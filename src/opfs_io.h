#ifndef BINK2_OPFS_IO_H
#define BINK2_OPFS_IO_H

#include <libavformat/avformat.h>

int bink2_opfs_open_input(AVFormatContext **ctx, const char *label);
int bink2_opfs_attach_output(AVFormatContext *ctx);
void bink2_opfs_close_input(AVFormatContext **ctx);
void bink2_opfs_close_output(AVFormatContext *ctx);

#endif
