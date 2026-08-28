#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <stdint.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/avutil.h>
#include <libavutil/dict.h>
#include <libavutil/error.h>
#include <libavutil/pixdesc.h>
#include <libavutil/samplefmt.h>
#include <libswresample/swresample.h>
#include <emscripten.h>

EM_JS(void, bink2_js_progress, (int frame, int total), {
    postMessage({ type: 'progress', frame, total });
});

static char last_error[1024];

typedef struct AudioTrack {
    int in_index;
    AVCodecContext *dec;
    AVCodecContext *enc;
    AVStream *out_stream;
    SwrContext *swr;
    AVAudioFifo *fifo;
    int64_t next_pts;
} AudioTrack;

static int failf(int code, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(last_error, sizeof(last_error), fmt, ap);
    va_end(ap);
    return code < 0 ? code : AVERROR(EINVAL);
}

static int fail_av(int code, const char *what) {
    char err[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(code, err, sizeof(err));
    return failf(code, "%s: %s", what, err);
}

EMSCRIPTEN_KEEPALIVE
const char *bink2_last_error(void) {
    return last_error;
}

static int drain_encoder(AVCodecContext *enc, AVFormatContext *out,
                         AVStream *out_stream, AVPacket *packet,
                         const char *what) {
    int ret;
    while (1) {
        ret = avcodec_receive_packet(enc, packet);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF)
            return 0;
        if (ret < 0)
            return fail_av(ret, what);
        av_packet_rescale_ts(packet, enc->time_base, out_stream->time_base);
        packet->stream_index = out_stream->index;
        ret = av_interleaved_write_frame(out, packet);
        av_packet_unref(packet);
        if (ret < 0)
            return fail_av(ret, "WebM muxer failed");
    }
}

static int encode_frame(AVCodecContext *enc, AVFormatContext *out,
                        AVStream *out_stream, AVFrame *frame,
                        AVPacket *packet, const char *what) {
    int ret = avcodec_send_frame(enc, frame);
    if (ret < 0)
        return fail_av(ret, what);
    return drain_encoder(enc, out, out_stream, packet, what);
}

static int encode_audio_fifo(AudioTrack *track, AVFormatContext *out,
                             AVPacket *packet, int flush_partial) {
    int frame_size = track->enc->frame_size > 0 ? track->enc->frame_size : 960;
    int available;
    int ret;

    while ((available = av_audio_fifo_size(track->fifo)) >= frame_size ||
           (flush_partial && available > 0)) {
        int samples = available < frame_size ? available : frame_size;
        AVFrame *frame = av_frame_alloc();
        if (!frame)
            return failf(AVERROR(ENOMEM), "Could not allocate Opus audio frame");

        frame->nb_samples = samples;
        frame->format = track->enc->sample_fmt;
        frame->sample_rate = track->enc->sample_rate;
        ret = av_channel_layout_copy(&frame->ch_layout, &track->enc->ch_layout);
        if (ret < 0) {
            av_frame_free(&frame);
            return fail_av(ret, "Could not set Opus channel layout");
        }
        ret = av_frame_get_buffer(frame, 0);
        if (ret < 0) {
            av_frame_free(&frame);
            return fail_av(ret, "Could not allocate Opus audio samples");
        }

        ret = av_audio_fifo_read(track->fifo, (void **)frame->extended_data, samples);
        if (ret < samples) {
            av_frame_free(&frame);
            return failf(AVERROR(EIO), "Could not read buffered Bink audio samples");
        }

        frame->pts = track->next_pts;
        track->next_pts += samples;
        ret = encode_frame(track->enc, out, track->out_stream, frame, packet,
                           "Opus encoder failed");
        av_frame_free(&frame);
        if (ret < 0)
            return ret;
    }
    return 0;
}

static int queue_audio_frame(AudioTrack *track, AVFormatContext *out,
                             AVPacket *packet, const AVFrame *decoded) {
    int out_samples;
    int converted_samples;
    int ret;
    AVFrame *converted = NULL;

    out_samples = (int)av_rescale_rnd(
        swr_get_delay(track->swr, track->dec->sample_rate) + decoded->nb_samples,
        track->enc->sample_rate, track->dec->sample_rate, AV_ROUND_UP);
    if (out_samples <= 0)
        return 0;

    converted = av_frame_alloc();
    if (!converted)
        return failf(AVERROR(ENOMEM), "Could not allocate converted audio frame");
    converted->nb_samples = out_samples;
    converted->format = track->enc->sample_fmt;
    converted->sample_rate = track->enc->sample_rate;
    ret = av_channel_layout_copy(&converted->ch_layout, &track->enc->ch_layout);
    if (ret < 0) {
        av_frame_free(&converted);
        return fail_av(ret, "Could not set converted audio layout");
    }
    ret = av_frame_get_buffer(converted, 0);
    if (ret < 0) {
        av_frame_free(&converted);
        return fail_av(ret, "Could not allocate converted audio samples");
    }

    converted_samples = swr_convert(
        track->swr,
        converted->extended_data,
        out_samples,
        (const uint8_t **)decoded->extended_data,
        decoded->nb_samples);
    if (converted_samples < 0) {
        av_frame_free(&converted);
        return fail_av(converted_samples, "Could not convert Bink audio for Opus");
    }
    converted->nb_samples = converted_samples;

    if (converted_samples > 0) {
        int old_size = av_audio_fifo_size(track->fifo);
        ret = av_audio_fifo_realloc(track->fifo, old_size + converted_samples);
        if (ret < 0) {
            av_frame_free(&converted);
            return fail_av(ret, "Could not grow audio buffer");
        }
        ret = av_audio_fifo_write(track->fifo, (void **)converted->extended_data,
                                  converted_samples);
        if (ret < converted_samples) {
            av_frame_free(&converted);
            return failf(AVERROR(EIO), "Could not buffer converted Bink audio");
        }
    }
    av_frame_free(&converted);
    return encode_audio_fifo(track, out, packet, 0);
}

static int drain_audio_decoder(AudioTrack *track, AVFormatContext *out,
                               AVPacket *packet, AVFrame *decoded) {
    int ret;
    while (1) {
        ret = avcodec_receive_frame(track->dec, decoded);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF)
            return 0;
        if (ret < 0)
            return fail_av(ret, "Bink audio decode failed");
        ret = queue_audio_frame(track, out, packet, decoded);
        av_frame_unref(decoded);
        if (ret < 0)
            return ret;
    }
}

static int process_audio_packet(AudioTrack *track, AVFormatContext *out,
                                AVPacket *packet, AVPacket *encoded,
                                AVFrame *decoded) {
    int ret = avcodec_send_packet(track->dec, packet);
    if (ret < 0)
        return fail_av(ret, "Could not send Bink audio packet to decoder");
    return drain_audio_decoder(track, out, encoded, decoded);
}

static int flush_audio_track(AudioTrack *track, AVFormatContext *out,
                             AVPacket *packet, AVFrame *decoded) {
    int ret;

    ret = avcodec_send_packet(track->dec, NULL);
    if (ret < 0 && ret != AVERROR_EOF)
        return fail_av(ret, "Could not flush Bink audio decoder");
    ret = drain_audio_decoder(track, out, packet, decoded);
    if (ret < 0)
        return ret;

    while (1) {
        int delay = (int)swr_get_delay(track->swr, track->dec->sample_rate);
        int out_samples;
        int converted_samples;
        AVFrame *converted;
        if (delay <= 0)
            break;
        out_samples = (int)av_rescale_rnd(delay, track->enc->sample_rate,
                                          track->dec->sample_rate, AV_ROUND_UP);
        if (out_samples <= 0)
            break;
        converted = av_frame_alloc();
        if (!converted)
            return failf(AVERROR(ENOMEM), "Could not allocate audio flush frame");
        converted->nb_samples = out_samples;
        converted->format = track->enc->sample_fmt;
        converted->sample_rate = track->enc->sample_rate;
        ret = av_channel_layout_copy(&converted->ch_layout, &track->enc->ch_layout);
        if (ret < 0) {
            av_frame_free(&converted);
            return fail_av(ret, "Could not set audio flush layout");
        }
        ret = av_frame_get_buffer(converted, 0);
        if (ret < 0) {
            av_frame_free(&converted);
            return fail_av(ret, "Could not allocate audio flush samples");
        }
        converted_samples = swr_convert(track->swr, converted->extended_data,
                                        out_samples, NULL, 0);
        if (converted_samples < 0) {
            av_frame_free(&converted);
            return fail_av(converted_samples, "Could not flush audio resampler");
        }
        if (converted_samples == 0) {
            av_frame_free(&converted);
            break;
        }
        ret = av_audio_fifo_realloc(track->fifo,
                                    av_audio_fifo_size(track->fifo) + converted_samples);
        if (ret < 0) {
            av_frame_free(&converted);
            return fail_av(ret, "Could not grow audio flush buffer");
        }
        ret = av_audio_fifo_write(track->fifo, (void **)converted->extended_data,
                                  converted_samples);
        av_frame_free(&converted);
        if (ret < converted_samples)
            return failf(AVERROR(EIO), "Could not buffer flushed audio samples");
    }

    ret = encode_audio_fifo(track, out, packet, 1);
    if (ret < 0)
        return ret;
    return encode_frame(track->enc, out, track->out_stream, NULL, packet,
                        "Could not flush Opus encoder");
}

static AudioTrack *find_audio_track(AudioTrack *tracks, int count, int stream_index) {
    for (int i = 0; i < count; i++)
        if (tracks[i].in_index == stream_index)
            return &tracks[i];
    return NULL;
}

static void free_audio_tracks(AudioTrack *tracks, int count) {
    if (!tracks)
        return;
    for (int i = 0; i < count; i++) {
        av_audio_fifo_free(tracks[i].fifo);
        swr_free(&tracks[i].swr);
        avcodec_free_context(&tracks[i].enc);
        avcodec_free_context(&tracks[i].dec);
    }
    av_free(tracks);
}

EMSCRIPTEN_KEEPALIVE
int transcode_bk2(const char *input_path, const char *output_path,
                  int crf, int cpu_used, int threads) {
    AVFormatContext *in = NULL;
    AVFormatContext *out = NULL;
    AVCodecContext *dec = NULL;
    AVCodecContext *enc = NULL;
    AVFrame *frame = NULL;
    AVFrame *audio_frame = NULL;
    AVPacket *packet = NULL;
    AVPacket *encoded_packet = NULL;
    AVStream *in_stream = NULL;
    AVStream *out_stream = NULL;
    const AVCodec *decoder = NULL;
    const AVCodec *encoder = NULL;
    const AVCodec *opus_encoder = NULL;
    AVDictionary *enc_opts = NULL;
    AudioTrack *audio_tracks = NULL;
    int audio_count = 0;
    int video_index = -1;
    int frame_count = 0;
    int total_frames = 0;
    int wrote_header = 0;
    int ret = 0;
    AVRational fps;
    char value[32];

    last_error[0] = '\0';
    if (!input_path || !output_path)
        return failf(AVERROR(EINVAL), "Missing input or output path");
    if (crf < 0) crf = 18;
    if (crf > 63) crf = 63;
    if (cpu_used < 0) cpu_used = 6;
    if (cpu_used > 8) cpu_used = 8;
    if (threads < 1) threads = 1;
    if (threads > 8) threads = 8;

    ret = avformat_open_input(&in, input_path, NULL, NULL);
    if (ret < 0) { ret = fail_av(ret, "Could not open BK2 input"); goto cleanup; }
    ret = avformat_find_stream_info(in, NULL);
    if (ret < 0) { ret = fail_av(ret, "Could not read BK2 stream info"); goto cleanup; }

    video_index = av_find_best_stream(in, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    if (video_index < 0) { ret = fail_av(video_index, "No video stream in BK2"); goto cleanup; }
    in_stream = in->streams[video_index];

    decoder = avcodec_find_decoder(in_stream->codecpar->codec_id);
    if (!decoder) { ret = failf(AVERROR_DECODER_NOT_FOUND, "Bink2 decoder is not present in this build"); goto cleanup; }
    dec = avcodec_alloc_context3(decoder);
    if (!dec) { ret = failf(AVERROR(ENOMEM), "Could not allocate Bink2 decoder"); goto cleanup; }
    ret = avcodec_parameters_to_context(dec, in_stream->codecpar);
    if (ret < 0) { ret = fail_av(ret, "Could not initialize Bink2 decoder parameters"); goto cleanup; }
    dec->thread_count = threads;
    ret = avcodec_open2(dec, decoder, NULL);
    if (ret < 0) { ret = fail_av(ret, "Could not open Bink2 decoder"); goto cleanup; }

    if (dec->pix_fmt != AV_PIX_FMT_YUVA420P && dec->pix_fmt != AV_PIX_FMT_YUV420P) {
        const char *name = av_get_pix_fmt_name(dec->pix_fmt);
        ret = failf(AVERROR(EINVAL), "Unexpected Bink2 pixel format: %s", name ? name : "unknown");
        goto cleanup;
    }

    fps = av_guess_frame_rate(in, in_stream, NULL);
    if (fps.num <= 0 || fps.den <= 0)
        fps = (AVRational){30, 1};
    if (in_stream->nb_frames > 0 && in_stream->nb_frames <= INT32_MAX)
        total_frames = (int)in_stream->nb_frames;
    else if (in_stream->duration > 0 && in_stream->duration <= INT32_MAX)
        total_frames = (int)in_stream->duration;

    ret = avformat_alloc_output_context2(&out, NULL, "webm", output_path);
    if (ret < 0 || !out) { ret = fail_av(ret < 0 ? ret : AVERROR_UNKNOWN, "Could not create WebM output"); goto cleanup; }

    encoder = avcodec_find_encoder_by_name("libvpx-vp9");
    if (!encoder) { ret = failf(AVERROR_ENCODER_NOT_FOUND, "libvpx-vp9 encoder is not present in this build"); goto cleanup; }
    enc = avcodec_alloc_context3(encoder);
    if (!enc) { ret = failf(AVERROR(ENOMEM), "Could not allocate VP9 encoder"); goto cleanup; }

    enc->width = dec->width;
    enc->height = dec->height;
    enc->pix_fmt = dec->pix_fmt;
    enc->time_base = av_inv_q(fps);
    enc->framerate = fps;
    enc->bit_rate = 0;
    enc->gop_size = fps.num > 0 ? (fps.num / fps.den) * 4 : 120;
    if (enc->gop_size < 30) enc->gop_size = 30;
    enc->color_range = dec->color_range;
    enc->colorspace = dec->colorspace;
    enc->color_primaries = dec->color_primaries;
    enc->color_trc = dec->color_trc;
    enc->thread_count = threads;
    if (out->oformat->flags & AVFMT_GLOBALHEADER)
        enc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

    snprintf(value, sizeof(value), "%d", crf);
    av_dict_set(&enc_opts, "crf", value, 0);
    av_dict_set(&enc_opts, "auto-alt-ref", "0", 0);
    av_dict_set(&enc_opts, "lag-in-frames", "0", 0);
    av_dict_set(&enc_opts, "row-mt", threads > 1 ? "1" : "0", 0);
    av_dict_set(&enc_opts, "frame-parallel", threads > 1 ? "1" : "0", 0);
    if (dec->width >= 3840)
        av_dict_set(&enc_opts, "tile-columns", "2", 0);
    else if (dec->width >= 1920)
        av_dict_set(&enc_opts, "tile-columns", "1", 0);
    snprintf(value, sizeof(value), "%d", cpu_used);
    av_dict_set(&enc_opts, "cpu-used", value, 0);
    av_dict_set(&enc_opts, "deadline", "realtime", 0);

    ret = avcodec_open2(enc, encoder, &enc_opts);
    av_dict_free(&enc_opts);
    if (ret < 0) { ret = fail_av(ret, "Could not open VP9 encoder"); goto cleanup; }

    out_stream = avformat_new_stream(out, NULL);
    if (!out_stream) { ret = failf(AVERROR(ENOMEM), "Could not create WebM video stream"); goto cleanup; }
    out_stream->time_base = enc->time_base;
    out_stream->avg_frame_rate = fps;
    ret = avcodec_parameters_from_context(out_stream->codecpar, enc);
    if (ret < 0) { ret = fail_av(ret, "Could not initialize WebM video stream"); goto cleanup; }
    if (enc->pix_fmt == AV_PIX_FMT_YUVA420P)
        av_dict_set(&out_stream->metadata, "alpha_mode", "1", 0);

    for (unsigned int i = 0; i < in->nb_streams; i++)
        if (in->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO)
            audio_count++;

    if (audio_count > 0) {
        int ai = 0;
        opus_encoder = avcodec_find_encoder_by_name("libopus");
        if (!opus_encoder) {
            ret = failf(AVERROR_ENCODER_NOT_FOUND, "libopus encoder is not present in this build");
            goto cleanup;
        }
        audio_tracks = av_calloc(audio_count, sizeof(*audio_tracks));
        if (!audio_tracks) { ret = failf(AVERROR(ENOMEM), "Could not allocate audio tracks"); goto cleanup; }

        for (unsigned int i = 0; i < in->nb_streams; i++) {
            AVStream *audio_in = in->streams[i];
            AudioTrack *track;
            const AVCodec *audio_decoder;
            AVDictionary *opus_opts = NULL;
            int channels;
            if (audio_in->codecpar->codec_type != AVMEDIA_TYPE_AUDIO)
                continue;

            track = &audio_tracks[ai++];
            track->in_index = (int)i;
            audio_decoder = avcodec_find_decoder(audio_in->codecpar->codec_id);
            if (!audio_decoder) { ret = failf(AVERROR_DECODER_NOT_FOUND, "Bink audio decoder is not present in this build"); goto cleanup; }
            track->dec = avcodec_alloc_context3(audio_decoder);
            if (!track->dec) { ret = failf(AVERROR(ENOMEM), "Could not allocate Bink audio decoder"); goto cleanup; }
            ret = avcodec_parameters_to_context(track->dec, audio_in->codecpar);
            if (ret < 0) { ret = fail_av(ret, "Could not initialize Bink audio decoder"); goto cleanup; }
            track->dec->thread_count = 1;
            ret = avcodec_open2(track->dec, audio_decoder, NULL);
            if (ret < 0) { ret = fail_av(ret, "Could not open Bink audio decoder"); goto cleanup; }

            channels = track->dec->ch_layout.nb_channels;
            if (channels < 1 || channels > 2) {
                ret = failf(AVERROR(EINVAL), "Unsupported Bink audio channel count: %d", channels);
                goto cleanup;
            }

            track->enc = avcodec_alloc_context3(opus_encoder);
            if (!track->enc) { ret = failf(AVERROR(ENOMEM), "Could not allocate Opus encoder"); goto cleanup; }
            track->enc->sample_rate = 48000;
            track->enc->sample_fmt = AV_SAMPLE_FMT_FLT;
            track->enc->time_base = (AVRational){1, track->enc->sample_rate};
            track->enc->bit_rate = channels == 1 ? 64000 : 128000;
            ret = av_channel_layout_copy(&track->enc->ch_layout, &track->dec->ch_layout);
            if (ret < 0) { ret = fail_av(ret, "Could not copy audio channel layout"); goto cleanup; }
            if (out->oformat->flags & AVFMT_GLOBALHEADER)
                track->enc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
            av_dict_set(&opus_opts, "application", "audio", 0);
            av_dict_set(&opus_opts, "compression_level", "5", 0);
            ret = avcodec_open2(track->enc, opus_encoder, &opus_opts);
            av_dict_free(&opus_opts);
            if (ret < 0) { ret = fail_av(ret, "Could not open Opus encoder"); goto cleanup; }

            track->out_stream = avformat_new_stream(out, NULL);
            if (!track->out_stream) { ret = failf(AVERROR(ENOMEM), "Could not create WebM audio stream"); goto cleanup; }
            track->out_stream->time_base = track->enc->time_base;
            track->out_stream->id = audio_in->id;
            av_dict_copy(&track->out_stream->metadata, audio_in->metadata, 0);
            ret = avcodec_parameters_from_context(track->out_stream->codecpar, track->enc);
            if (ret < 0) { ret = fail_av(ret, "Could not initialize WebM audio stream"); goto cleanup; }

            ret = swr_alloc_set_opts2(&track->swr,
                                      &track->enc->ch_layout,
                                      track->enc->sample_fmt,
                                      track->enc->sample_rate,
                                      &track->dec->ch_layout,
                                      track->dec->sample_fmt,
                                      track->dec->sample_rate,
                                      0, NULL);
            if (ret < 0) { ret = fail_av(ret, "Could not allocate audio resampler"); goto cleanup; }
            ret = swr_init(track->swr);
            if (ret < 0) { ret = fail_av(ret, "Could not initialize audio resampler"); goto cleanup; }
            track->fifo = av_audio_fifo_alloc(track->enc->sample_fmt,
                                              track->enc->ch_layout.nb_channels,
                                              track->enc->frame_size * 4);
            if (!track->fifo) { ret = failf(AVERROR(ENOMEM), "Could not allocate audio FIFO"); goto cleanup; }
        }
    }

    if (!(out->oformat->flags & AVFMT_NOFILE)) {
        ret = avio_open(&out->pb, output_path, AVIO_FLAG_WRITE);
        if (ret < 0) { ret = fail_av(ret, "Could not open WebM output file"); goto cleanup; }
    }
    ret = avformat_write_header(out, NULL);
    if (ret < 0) { ret = fail_av(ret, "Could not write WebM header"); goto cleanup; }
    wrote_header = 1;

    frame = av_frame_alloc();
    audio_frame = av_frame_alloc();
    packet = av_packet_alloc();
    encoded_packet = av_packet_alloc();
    if (!frame || !audio_frame || !packet || !encoded_packet) {
        ret = failf(AVERROR(ENOMEM), "Could not allocate decode buffers");
        goto cleanup;
    }

    while ((ret = av_read_frame(in, packet)) >= 0) {
        if (packet->stream_index == video_index) {
            ret = avcodec_send_packet(dec, packet);
            av_packet_unref(packet);
            if (ret < 0) { ret = fail_av(ret, "Could not send Bink2 packet to decoder"); goto cleanup; }
            while (1) {
                ret = avcodec_receive_frame(dec, frame);
                if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) break;
                if (ret < 0) { ret = fail_av(ret, "Bink2 frame decode failed"); goto cleanup; }
                if (frame->format != enc->pix_fmt) { ret = failf(AVERROR(EINVAL), "Bink2 pixel format changed during decode"); goto cleanup; }
                frame->pts = frame_count;
                ret = encode_frame(enc, out, out_stream, frame, encoded_packet,
                                   "VP9 encoder failed");
                av_frame_unref(frame);
                if (ret < 0) goto cleanup;
                frame_count++;
                bink2_js_progress(frame_count, total_frames);
            }
        } else {
            AudioTrack *track = find_audio_track(audio_tracks, audio_count, packet->stream_index);
            if (track) {
                ret = process_audio_packet(track, out, packet, encoded_packet, audio_frame);
                av_packet_unref(packet);
                if (ret < 0) goto cleanup;
            } else {
                av_packet_unref(packet);
            }
        }
    }
    if (ret != AVERROR_EOF) { ret = fail_av(ret, "Error reading BK2 packets"); goto cleanup; }

    ret = avcodec_send_packet(dec, NULL);
    if (ret < 0 && ret != AVERROR_EOF) { ret = fail_av(ret, "Could not flush Bink2 decoder"); goto cleanup; }
    while (1) {
        ret = avcodec_receive_frame(dec, frame);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) break;
        if (ret < 0) { ret = fail_av(ret, "Bink2 decoder flush failed"); goto cleanup; }
        frame->pts = frame_count;
        ret = encode_frame(enc, out, out_stream, frame, encoded_packet,
                           "VP9 encoder failed");
        av_frame_unref(frame);
        if (ret < 0) goto cleanup;
        frame_count++;
        bink2_js_progress(frame_count, total_frames);
    }

    ret = encode_frame(enc, out, out_stream, NULL, encoded_packet,
                       "Could not flush VP9 encoder");
    if (ret < 0) goto cleanup;

    for (int i = 0; i < audio_count; i++) {
        ret = flush_audio_track(&audio_tracks[i], out, encoded_packet, audio_frame);
        if (ret < 0) goto cleanup;
    }

    ret = av_write_trailer(out);
    if (ret < 0) { ret = fail_av(ret, "Could not finalize WebM output"); goto cleanup; }
    wrote_header = 0;
    ret = frame_count;

cleanup:
    av_dict_free(&enc_opts);
    if (ret < 0 && wrote_header && out) av_write_trailer(out);
    av_packet_free(&encoded_packet);
    av_packet_free(&packet);
    av_frame_free(&audio_frame);
    av_frame_free(&frame);
    free_audio_tracks(audio_tracks, audio_count);
    avcodec_free_context(&enc);
    avcodec_free_context(&dec);
    if (out) {
        if (!(out->oformat->flags & AVFMT_NOFILE) && out->pb) avio_closep(&out->pb);
        avformat_free_context(out);
    }
    avformat_close_input(&in);
    return ret;
}
