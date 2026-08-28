#ifndef BINK2_VP8_FASTPATH_H
#define BINK2_VP8_FASTPATH_H

#include <string.h>
#include <libavcodec/avcodec.h>
#include <libavutil/pixfmt.h>

/* native_checkpoints.h is force-included before this file, so avcodec_open2
   currently names b2_avcodec_open2. Wrap that checkpointed call and remember
   whether the decoded Bink video is ordinary YUV420P. Non-alpha Bink does not
   require VP9, and libvpx VP8 is substantially faster for 4K realtime encoding. */
static int b2_use_vp8_for_video = 0;

static inline int b2_avcodec_open2_choose_video(AVCodecContext *avctx,
                                                 const AVCodec *codec,
                                                 AVDictionary **options) {
    int ret = b2_avcodec_open2(avctx, codec, options);
    if (ret >= 0 && avctx && codec && codec->name &&
        (strcmp(codec->name, "binkvideo2") == 0 ||
         strcmp(codec->name, "binkvideo") == 0)) {
        b2_use_vp8_for_video = avctx->pix_fmt == AV_PIX_FMT_YUV420P;
        fprintf(stderr,
                "[bink2-fastpath] decoded pixel format=%d; video encoder=%s\n",
                avctx->pix_fmt, b2_use_vp8_for_video ? "VP8" : "VP9");
        fflush(stderr);
    }
    return ret;
}

#undef avcodec_open2
#define avcodec_open2 b2_avcodec_open2_choose_video

static inline const AVCodec *b2_find_encoder_by_name(const char *name) {
    if (b2_use_vp8_for_video && name && strcmp(name, "libvpx-vp9") == 0) {
        const AVCodec *vp8 = avcodec_find_encoder_by_name("libvpx");
        if (vp8) {
            fprintf(stderr,
                    "[bink2-fastpath] using libvpx VP8 for non-alpha WebM output\n");
            fflush(stderr);
            return vp8;
        }
    }
    return avcodec_find_encoder_by_name(name);
}

#define avcodec_find_encoder_by_name b2_find_encoder_by_name

#endif
