#include <stdio.h>
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
