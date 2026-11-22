#ifndef BINK2_DECODER_FALLBACK_H
#define BINK2_DECODER_FALLBACK_H

#include <stdio.h>
#include <string.h>
#include <libavcodec/avcodec.h>

static inline const AVCodec *b2_find_decoder_robust(enum AVCodecID id) {
    const AVCodec *decoder = avcodec_find_decoder(id);
    if (decoder) return decoder;

    const char *codec_name = avcodec_get_name(id);
    fprintf(stderr,
            "[bink2-decoder] codec-id lookup failed: id=%d name=%s; trying explicit Bink decoder names\n",
            (int)id, codec_name ? codec_name : "unknown");
    fflush(stderr);

    if (id == AV_CODEC_ID_BINKVIDEO2 || (codec_name && strstr(codec_name, "bink2")))
        decoder = avcodec_find_decoder_by_name("binkvideo2");
    else if (id == AV_CODEC_ID_BINKVIDEO || (codec_name && strstr(codec_name, "binkvideo")))
        decoder = avcodec_find_decoder_by_name("binkvideo");

    if (decoder) {
        fprintf(stderr, "[bink2-decoder] recovered decoder by name: %s\n",
                decoder->name ? decoder->name : "unknown");
        fflush(stderr);
    }
    return decoder;
}

#define avcodec_find_decoder b2_find_decoder_robust

#endif
