#include <stdio.h>
#include <libavformat/avformat.h>
#include <libavutil/log.h>

/* TEMPORARY DEBUG BUILD: keep useful FFmpeg diagnostics without the AV_LOG_TRACE
   firehose, which can itself dominate browser time when forwarded to the UI. */
__attribute__((constructor))
static void bink2_enable_ffmpeg_trace(void) {
    av_log_set_level(AV_LOG_VERBOSE);
    av_log_set_flags(AV_LOG_PRINT_LEVEL);
    fprintf(stderr, "[bink2-debug] FFmpeg AV_LOG_VERBOSE enabled\n");
    fflush(stderr);
}

/* Bink's demuxer fills the stream parameters we need directly in read_header().
   The normal avformat_find_stream_info() pass decodes probe packets from all
   eight Bink audio streams, initializing the FFT/DCT machinery once per stream
   before the real decoders are opened. The build maps only this converter's
   call to this no-op helper; FFmpeg itself is otherwise unchanged. */
int bink2_find_stream_info_fast(AVFormatContext *ctx, AVDictionary **options) {
    (void)options;
    fprintf(stderr,
            "[bink2-debug] skipping avformat_find_stream_info; Bink header supplied %u streams\n",
            ctx ? ctx->nb_streams : 0);
    fflush(stderr);
    return 0;
}
