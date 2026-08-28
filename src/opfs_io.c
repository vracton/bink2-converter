#include "opfs_io.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>

#include <emscripten.h>
#include <libavutil/error.h>
#include <libavutil/mem.h>

/* This file is linked with native_checkpoints.h force-included. It must call the
   real FFmpeg functions internally rather than the interception wrappers. */
#ifdef avformat_open_input
#undef avformat_open_input
#endif
#ifdef avformat_close_input
#undef avformat_close_input
#endif
#ifdef avio_closep
#undef avio_closep
#endif

#define OPFS_AVIO_BUFFER_SIZE (256 * 1024)

typedef struct Bink2OpfsIO {
    int64_t pos;
    int is_output;
} Bink2OpfsIO;

EM_JS(int, bink2_opfs_is_active_js, (), {
    return Module['bink2OpfsInputHandle'] && Module['bink2OpfsOutputHandle'] ? 1 : 0;
});

EM_JS(int, bink2_opfs_input_read_js, (uint8_t *buf, int size, double pos), {
    const handle = Module['bink2OpfsInputHandle'];
    if (!handle) {
        Module['bink2OpfsError'] = 'OPFS input handle is not available';
        return -1;
    }
    try {
        return handle.read(HEAPU8.subarray(buf, buf + size), { at: pos });
    } catch (error) {
        Module['bink2OpfsError'] = 'OPFS input read failed: ' + (error && error.message ? error.message : String(error));
        return -1;
    }
});

EM_JS(double, bink2_opfs_input_size_js, (), {
    const handle = Module['bink2OpfsInputHandle'];
    if (!handle) return -1;
    try {
        return handle.getSize();
    } catch (error) {
        Module['bink2OpfsError'] = 'OPFS input size query failed: ' + (error && error.message ? error.message : String(error));
        return -1;
    }
});

EM_JS(int, bink2_opfs_output_write_js, (const uint8_t *buf, int size, double pos), {
    const handle = Module['bink2OpfsOutputHandle'];
    if (!handle) {
        Module['bink2OpfsError'] = 'OPFS output handle is not available';
        return -1;
    }
    try {
        let written = 0;
        while (written < size) {
            const count = handle.write(
                HEAPU8.subarray(buf + written, buf + size),
                { at: pos + written }
            );
            if (!(count > 0)) {
                Module['bink2OpfsError'] = 'OPFS output write returned zero bytes';
                return -1;
            }
            written += count;
        }
        return written;
    } catch (error) {
        Module['bink2OpfsError'] = 'OPFS output write failed: ' + (error && error.message ? error.message : String(error));
        return -1;
    }
});

EM_JS(double, bink2_opfs_output_size_js, (), {
    const handle = Module['bink2OpfsOutputHandle'];
    if (!handle) return -1;
    try {
        return handle.getSize();
    } catch (error) {
        Module['bink2OpfsError'] = 'OPFS output size query failed: ' + (error && error.message ? error.message : String(error));
        return -1;
    }
});

int bink2_opfs_is_active(void) {
    return bink2_opfs_is_active_js();
}

static double opfs_size(const Bink2OpfsIO *io) {
    return io && io->is_output ? bink2_opfs_output_size_js()
                               : bink2_opfs_input_size_js();
}

static int opfs_read_packet(void *opaque, uint8_t *buf, int buf_size) {
    Bink2OpfsIO *io = (Bink2OpfsIO *)opaque;
    int ret = bink2_opfs_input_read_js(buf, buf_size, (double)io->pos);
    if (ret < 0)
        return AVERROR(EIO);
    if (ret == 0)
        return AVERROR_EOF;
    io->pos += ret;
    return ret;
}

static int opfs_write_packet(void *opaque, const uint8_t *buf, int buf_size) {
    Bink2OpfsIO *io = (Bink2OpfsIO *)opaque;
    int ret = bink2_opfs_output_write_js(buf, buf_size, (double)io->pos);
    if (ret < 0)
        return AVERROR(EIO);
    io->pos += ret;
    return ret;
}

static int64_t opfs_seek(void *opaque, int64_t offset, int whence) {
    Bink2OpfsIO *io = (Bink2OpfsIO *)opaque;
    int64_t base;
    double size;

    if (whence & AVSEEK_SIZE) {
        size = opfs_size(io);
        return size < 0 ? AVERROR(EIO) : (int64_t)size;
    }

    whence &= ~AVSEEK_FORCE;
    switch (whence) {
        case SEEK_SET:
            base = 0;
            break;
        case SEEK_CUR:
            base = io->pos;
            break;
        case SEEK_END:
            size = opfs_size(io);
            if (size < 0)
                return AVERROR(EIO);
            base = (int64_t)size;
            break;
        default:
            return AVERROR(EINVAL);
    }

    if (offset < 0 && base < -offset)
        return AVERROR(EINVAL);
    io->pos = base + offset;
    return io->pos;
}

static AVIOContext *make_opfs_avio(int is_output) {
    uint8_t *buffer = av_malloc(OPFS_AVIO_BUFFER_SIZE);
    Bink2OpfsIO *io = av_mallocz(sizeof(*io));
    AVIOContext *avio;

    if (!buffer || !io) {
        av_free(buffer);
        av_free(io);
        return NULL;
    }

    io->is_output = is_output;
    avio = avio_alloc_context(
        buffer,
        OPFS_AVIO_BUFFER_SIZE,
        is_output,
        io,
        is_output ? NULL : opfs_read_packet,
        is_output ? opfs_write_packet : NULL,
        opfs_seek
    );
    if (!avio) {
        av_free(buffer);
        av_free(io);
        return NULL;
    }
    avio->seekable = AVIO_SEEKABLE_NORMAL;
    return avio;
}

static void free_opfs_avio(AVIOContext **pb) {
    if (!pb || !*pb)
        return;
    av_freep(&(*pb)->opaque);
    avio_context_free(pb);
}

int bink2_opfs_open_input(AVFormatContext **ctx, const char *label) {
    AVFormatContext *fmt;
    AVIOContext *pb;
    int ret;

    if (!ctx)
        return AVERROR(EINVAL);

    fmt = avformat_alloc_context();
    pb = make_opfs_avio(0);
    if (!fmt || !pb) {
        if (fmt)
            avformat_free_context(fmt);
        free_opfs_avio(&pb);
        return AVERROR(ENOMEM);
    }

    fmt->pb = pb;
    fmt->flags |= AVFMT_FLAG_CUSTOM_IO;
    fprintf(stderr, "[bink2-opfs] input reading directly from OPFS\n");
    fflush(stderr);

    ret = avformat_open_input(&fmt, label, NULL, NULL);
    if (ret < 0) {
        free_opfs_avio(&pb);
        if (fmt)
            avformat_free_context(fmt);
        return ret;
    }

    *ctx = fmt;
    return 0;
}

int bink2_opfs_open_output(AVIOContext **pb) {
    if (!pb)
        return AVERROR(EINVAL);
    *pb = make_opfs_avio(1);
    if (!*pb)
        return AVERROR(ENOMEM);
    fprintf(stderr, "[bink2-opfs] WebM writing directly to OPFS\n");
    fflush(stderr);
    return 0;
}

void bink2_opfs_close_input(AVFormatContext **ctx) {
    AVIOContext *pb;
    if (!ctx || !*ctx)
        return;
    pb = (*ctx)->pb;
    avformat_close_input(ctx);
    free_opfs_avio(&pb);
}

int bink2_opfs_close_output(AVIOContext **pb) {
    if (!pb || !*pb)
        return 0;
    avio_flush(*pb);
    free_opfs_avio(pb);
    return 0;
}
