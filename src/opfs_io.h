#ifndef BINK2_OPFS_IO_H
#define BINK2_OPFS_IO_H

#include <libavformat/avformat.h>

int bink2_opfs_is_active(void);
int bink2_opfs_open_input(AVFormatContext **ctx, const char *label);
int bink2_opfs_open_output(AVIOContext **pb);
void bink2_opfs_close_input(AVFormatContext **ctx);
int bink2_opfs_close_output(AVIOContext **pb);

#endif
