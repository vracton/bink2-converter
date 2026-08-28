#ifndef BINK2_NATIVE_CHECKPOINTS_H
#define BINK2_NATIVE_CHECKPOINTS_H

#include <stdio.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>

static inline void b2_checkpoint(const char *phase, const char *name) {
    fprintf(stderr, "[bink2-native] %s %s\n", phase, name);
    fflush(stderr);
}

static inline int b2_avformat_open_input(AVFormatContext **ps, const char *url,
                                         const AVInputFormat *fmt,
                                         AVDictionary **options) {
    b2_checkpoint("BEFORE", "avformat_open_input");
    int ret = avformat_open_input(ps, url, fmt, options);
    fprintf(stderr, "[bink2-native] AFTER avformat_open_input ret=%d streams=%u\n",
            ret, (ret >= 0 && ps && *ps) ? (*ps)->nb_streams : 0);
    fflush(stderr);
    return ret;
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
    int ret = avio_open(s, url, flags);
    fprintf(stderr, "[bink2-native] AFTER avio_open ret=%d\n", ret);
    fflush(stderr);
    return ret;
}

static inline int b2_avformat_write_header(AVFormatContext *s,
                                            AVDictionary **options) {
    fprintf(stderr, "[bink2-native] BEFORE avformat_write_header streams=%u\n",
            s ? s->nb_streams : 0);
    fflush(stderr);
    int ret = avformat_write_header(s, options);
    fprintf(stderr, "[bink2-native] AFTER avformat_write_header ret=%d\n", ret);
    fflush(stderr);
    return ret;
}

#define avformat_open_input             b2_avformat_open_input
#define avformat_find_stream_info       b2_avformat_find_stream_info
#define av_find_best_stream             b2_av_find_best_stream
#define avcodec_open2                   b2_avcodec_open2
#define avformat_alloc_output_context2  b2_avformat_alloc_output_context2
#define avformat_new_stream             b2_avformat_new_stream
#define avio_open                       b2_avio_open
#define avformat_write_header           b2_avformat_write_header

#endif
