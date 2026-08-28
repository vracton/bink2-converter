#include <stdio.h>
#include <libavutil/log.h>

/* TEMPORARY DEBUG BUILD: make FFmpeg emit its most verbose runtime trace.
   Remove this file from the link command once the startup stall is identified. */
__attribute__((constructor))
static void bink2_enable_ffmpeg_trace(void) {
    av_log_set_level(AV_LOG_TRACE);
    av_log_set_flags(AV_LOG_PRINT_LEVEL);
    fprintf(stderr, "[bink2-debug] FFmpeg AV_LOG_TRACE enabled\n");
    fflush(stderr);
}
