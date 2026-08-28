#ifndef BINK2_NATIVE_CHECKPOINTS_H
#define BINK2_NATIVE_CHECKPOINTS_H

#include <stdio.h>
#include <string.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/frame.h>
#include <libswresample/swresample.h>
#include "opfs_io.h"

static inline const char *b2_codec_name(const AVCodecContext *ctx) {
    return (ctx && ctx->codec && ctx->codec->name) ? ctx->codec->name : "unknown";
}

static inline void b2_checkpoint(const char *phase, const char *name) {
    fprintf(stderr, "[bink2-native] %s %s\n", phase, name);
    fflush(stderr);
}

static inline int b2_avformat_open_input(AVFormatContext **ps, const char *url,
                                         const AVInputFormat *fmt,
                                         AVDictionary **options) {
    b2_checkpoint("BEFORE", "avformat_open_input");
    int ret;
    if (bink2_opfs_is_active() && !fmt && !options) {
        ret = bink2_opfs_open_input(ps, url);
    } else {
        ret = avformat_open_input(ps, url, fmt, options);
    }
    fprintf(stderr, "[bink2-native] AFTER avformat_open_input ret=%d streams=%u io=%s\n",
            ret, (ret >= 0 && ps && *ps) ? (*ps)->nb_streams : 0,
            bink2_opfs_is_active() ? "OPFS" : "MEMFS");
    fflush(stderr);
    return ret;
}

static inline void b2_avformat_close_input(AVFormatContext **ps) {
    if (bink2_opfs_is_active())
        bink2_opfs_close_input(ps);
    else
        avformat_close_input(ps);
}

static inline int b2_avformat_find_stream_info(AVFormatContext *ic,
                                                AVDictionary **options) {
    b2_checkpoint("BEFORE", "avformat_find_stream_info");
    int ret = avformat_find_stream_info(ic, options);
    fprintf(stderr, "[bink2-native] AFTER avformat_find_stream_info ret=%d streams=%u\n",
            ret, ic ? ic->nb_streams : 0);
    fflush(stderr);
    return ret;
}

static inline int b2_av_find_best_stream(AVFormatContext *ic,
                                         enum AVMediaType type,
                                         int wanted_stream_nb,
                                         int related_stream,
                                         const AVCodec **decoder_ret,
                                         int flags) {
    b2_checkpoint("BEFORE", "av_find_best_stream");
    int ret = av_find_best_stream(ic, type, wanted_stream_nb, related_stream,
                                  decoder_ret, flags);
    fprintf(stderr, "[bink2-native] AFTER av_find_best_stream ret=%d\n", ret);
    fflush(stderr);
    return ret;
}

static inline int b2_avcodec_open2(AVCodecContext *avctx, const AVCodec *codec,
                                   AVDictionary **options) {
    const char *name = codec && codec->name ? codec->name : "unknown";

    /* Preserve the finite browser pthread pool for libvpx. Bink/Bink2 decode is
       much cheaper than 4K VP9 encoding, so both Bink decoders stay single-threaded. */
    if (avctx && (strcmp(name, "binkvideo2") == 0 || strcmp(name, "binkvideo") == 0) &&
        avctx->thread_count > 1) {
        fprintf(stderr,
                "[bink2-native] limiting %s decoder threads %d -> 1 to preserve browser pthread pool\n",
                name, avctx->thread_count);
        avctx->thread_count = 1;
    }

    fprintf(stderr, "[bink2-native] BEFORE avcodec_open2 codec=%s threads=%d\n",
            name, avctx ? avctx->thread_count : -1);
    fflush(stderr);
    int ret = avcodec_open2(avctx, codec, options);
    fprintf(stderr, "[bink2-native] AFTER avcodec_open2 codec=%s ret=%d threads=%d\n",
            name, ret, avctx ? avctx->thread_count : -1);
    fflush(stderr);
    return ret;
}

static inline int b2_avformat_alloc_output_context2(AVFormatContext **ctx,
                                                     const AVOutputFormat *oformat,
                                                     const char *format_name,
                                                     const char *filename) {
    b2_checkpoint("BEFORE", "avformat_alloc_output_context2");
    int ret = avformat_alloc_output_context2(ctx, oformat, format_name, filename);
    fprintf(stderr, "[bink2-native] AFTER avformat_alloc_output_context2 ret=%d\n", ret);
    fflush(stderr);
    return ret;
}

static inline AVStream *b2_avformat_new_stream(AVFormatContext *s,
                                                const AVCodec *c) {
    fprintf(stderr, "[bink2-native] BEFORE avformat_new_stream existing=%u\n",
            s ? s->nb_streams : 0);
    fflush(stderr);
    AVStream *ret = avformat_new_stream(s, c);
    fprintf(stderr, "[bink2-native] AFTER avformat_new_stream ok=%d total=%u\n",
            ret != NULL, s ? s->nb_streams : 0);
    fflush(stderr);
    return ret;
}

static inline int b2_avio_open(AVIOContext **s, const char *url, int flags) {
    b2_checkpoint("BEFORE", "avio_open");
    int ret;
    if (bink2_opfs_is_active() && (flags & AVIO_FLAG_WRITE))
        ret = bink2_opfs_open_output(s);
    else
        ret = avio_open(s, url, flags);
    fprintf(stderr, "[bink2-native] AFTER avio_open ret=%d io=%s\n",
            ret, bink2_opfs_is_active() ? "OPFS" : "MEMFS");
    fflush(stderr);
    return ret;
}

static inline int b2_avio_closep(AVIOContext **s) {
    if (bink2_opfs_is_active())
        return bink2_opfs_close_output(s);
    return avio_closep(s);
}

static inline int b2_avformat_write_header(AVFormatContext *s,
                                            AVDictionary **options) {
    if (s && bink2_opfs_is_active())
        s->flags |= AVFMT_FLAG_CUSTOM_IO;
    fprintf(stderr, "[bink2-native] BEFORE avformat_write_header streams=%u\n",
            s ? s->nb_streams : 0);
    fflush(stderr);
    int ret = avformat_write_header(s, options);
    fprintf(stderr, "[bink2-native] AFTER avformat_write_header ret=%d\n", ret);
    fflush(stderr);
    return ret;
}

static inline int b2_av_read_frame(AVFormatContext *s, AVPacket *pkt) {
    static int calls = 0;
    int n = ++calls;
    if (n <= 20) {
        fprintf(stderr, "[bink2-packet] BEFORE av_read_frame #%d\n", n);
        fflush(stderr);
    }
    int ret = av_read_frame(s, pkt);
    if (n <= 20) {
        if (ret >= 0 && pkt) {
            fprintf(stderr,
                    "[bink2-packet] AFTER av_read_frame #%d ret=%d stream=%d size=%d pts=%lld\n",
                    n, ret, pkt->stream_index, pkt->size, (long long)pkt->pts);
        } else {
            fprintf(stderr, "[bink2-packet] AFTER av_read_frame #%d ret=%d\n", n, ret);
        }
        fflush(stderr);
    }
    return ret;
}

static inline int b2_avcodec_send_packet(AVCodecContext *ctx, const AVPacket *pkt) {
    static int calls = 0;
    int n = ++calls;
    if (n <= 24) {
        fprintf(stderr,
                "[bink2-packet] BEFORE avcodec_send_packet #%d codec=%s size=%d stream=%d\n",
                n, b2_codec_name(ctx), pkt ? pkt->size : -1,
                pkt ? pkt->stream_index : -1);
        fflush(stderr);
    }
    int ret = avcodec_send_packet(ctx, pkt);
    if (n <= 24) {
        fprintf(stderr,
                "[bink2-packet] AFTER avcodec_send_packet #%d codec=%s ret=%d\n",
                n, b2_codec_name(ctx), ret);
        fflush(stderr);
    }
    return ret;
}

static inline int b2_avcodec_receive_frame(AVCodecContext *ctx, AVFrame *frame) {
    static int calls = 0;
    int n = ++calls;
    if (n <= 24) {
        fprintf(stderr, "[bink2-packet] BEFORE avcodec_receive_frame #%d codec=%s\n",
                n, b2_codec_name(ctx));
        fflush(stderr);
    }
    int ret = avcodec_receive_frame(ctx, frame);
    if (n <= 24) {
        fprintf(stderr,
                "[bink2-packet] AFTER avcodec_receive_frame #%d codec=%s ret=%d samples=%d format=%d\n",
                n, b2_codec_name(ctx), ret,
                (ret >= 0 && frame) ? frame->nb_samples : -1,
                (ret >= 0 && frame) ? frame->format : -1);
        fflush(stderr);
    }
    return ret;
}

static inline int b2_av_frame_get_buffer(AVFrame *frame, int align) {
    static int calls = 0;
    int n = ++calls;
    if (n <= 16) {
        fprintf(stderr,
                "[bink2-audio] BEFORE av_frame_get_buffer #%d samples=%d format=%d\n",
                n, frame ? frame->nb_samples : -1, frame ? frame->format : -1);
        fflush(stderr);
    }
    int ret = av_frame_get_buffer(frame, align);
    if (n <= 16) {
        fprintf(stderr, "[bink2-audio] AFTER av_frame_get_buffer #%d ret=%d\n", n, ret);
        fflush(stderr);
    }
    return ret;
}

static inline int b2_swr_convert(struct SwrContext *s, uint8_t **out,
                                 int out_count, const uint8_t **in,
                                 int in_count) {
    static int calls = 0;
    int n = ++calls;
    if (n <= 16) {
        fprintf(stderr,
                "[bink2-audio] BEFORE swr_convert #%d in=%d out_capacity=%d\n",
                n, in_count, out_count);
        fflush(stderr);
    }
    int ret = swr_convert(s, out, out_count, in, in_count);
    if (n <= 16) {
        fprintf(stderr, "[bink2-audio] AFTER swr_convert #%d ret=%d\n", n, ret);
        fflush(stderr);
    }
    return ret;
}

static inline int b2_av_audio_fifo_realloc(AVAudioFifo *af, int nb_samples) {
    static int calls = 0;
    int n = ++calls;
    if (n <= 16) {
        fprintf(stderr, "[bink2-audio] BEFORE fifo_realloc #%d samples=%d\n",
                n, nb_samples);
        fflush(stderr);
    }
    int ret = av_audio_fifo_realloc(af, nb_samples);
    if (n <= 16) {
        fprintf(stderr, "[bink2-audio] AFTER fifo_realloc #%d ret=%d\n", n, ret);
        fflush(stderr);
    }
    return ret;
}

static inline int b2_av_audio_fifo_write(AVAudioFifo *af, void **data,
                                         int nb_samples) {
    static int calls = 0;
    int n = ++calls;
    if (n <= 16) {
        fprintf(stderr, "[bink2-audio] BEFORE fifo_write #%d samples=%d\n",
                n, nb_samples);
        fflush(stderr);
    }
    int ret = av_audio_fifo_write(af, data, nb_samples);
    if (n <= 16) {
        fprintf(stderr, "[bink2-audio] AFTER fifo_write #%d ret=%d\n", n, ret);
        fflush(stderr);
    }
    return ret;
}

static inline int b2_avcodec_send_frame(AVCodecContext *ctx, const AVFrame *frame) {
    static int calls = 0;
    int n = ++calls;
    if (n <= 20) {
        fprintf(stderr,
                "[bink2-encode] BEFORE avcodec_send_frame #%d codec=%s pts=%lld samples=%d\n",
                n, b2_codec_name(ctx),
                frame ? (long long)frame->pts : -1LL,
                frame ? frame->nb_samples : -1);
        fflush(stderr);
    }
    int ret = avcodec_send_frame(ctx, frame);
    if (n <= 20) {
        fprintf(stderr,
                "[bink2-encode] AFTER avcodec_send_frame #%d codec=%s ret=%d\n",
                n, b2_codec_name(ctx), ret);
        fflush(stderr);
    }
    return ret;
}

static inline int b2_avcodec_receive_packet(AVCodecContext *ctx, AVPacket *pkt) {
    static int calls = 0;
    int n = ++calls;
    if (n <= 20) {
        fprintf(stderr, "[bink2-encode] BEFORE avcodec_receive_packet #%d codec=%s\n",
                n, b2_codec_name(ctx));
        fflush(stderr);
    }
    int ret = avcodec_receive_packet(ctx, pkt);
    if (n <= 20) {
        fprintf(stderr,
                "[bink2-encode] AFTER avcodec_receive_packet #%d codec=%s ret=%d size=%d\n",
                n, b2_codec_name(ctx), ret,
                (ret >= 0 && pkt) ? pkt->size : -1);
        fflush(stderr);
    }
    return ret;
}

static inline int b2_av_interleaved_write_frame(AVFormatContext *s, AVPacket *pkt) {
    static int calls = 0;
    int n = ++calls;
    if (n <= 20) {
        fprintf(stderr,
                "[bink2-mux] BEFORE av_interleaved_write_frame #%d stream=%d size=%d pts=%lld\n",
                n, pkt ? pkt->stream_index : -1, pkt ? pkt->size : -1,
                pkt ? (long long)pkt->pts : -1LL);
        fflush(stderr);
    }
    int ret = av_interleaved_write_frame(s, pkt);
    if (n <= 20) {
        fprintf(stderr, "[bink2-mux] AFTER av_interleaved_write_frame #%d ret=%d\n",
                n, ret);
        fflush(stderr);
    }
    return ret;
}

#define avformat_open_input             b2_avformat_open_input
#define avformat_close_input            b2_avformat_close_input
#define avformat_find_stream_info       b2_avformat_find_stream_info
#define av_find_best_stream             b2_av_find_best_stream
#define avcodec_open2                   b2_avcodec_open2
#define avformat_alloc_output_context2  b2_avformat_alloc_output_context2
#define avformat_new_stream             b2_avformat_new_stream
#define avio_open                       b2_avio_open
#define avio_closep                     b2_avio_closep
#define avformat_write_header           b2_avformat_write_header
#define av_read_frame                   b2_av_read_frame
#define avcodec_send_packet             b2_avcodec_send_packet
#define avcodec_receive_frame           b2_avcodec_receive_frame
#define av_frame_get_buffer             b2_av_frame_get_buffer
#define swr_convert                     b2_swr_convert
#define av_audio_fifo_realloc           b2_av_audio_fifo_realloc
#define av_audio_fifo_write             b2_av_audio_fifo_write
#define avcodec_send_frame              b2_avcodec_send_frame
#define avcodec_receive_packet          b2_avcodec_receive_packet
#define av_interleaved_write_frame      b2_av_interleaved_write_frame

#endif
