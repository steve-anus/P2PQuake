/* macOS process primitives. GPL-2.0-or-later. */
#ifndef QN_OS_MACOS_H
#define QN_OS_MACOS_H
#ifdef __APPLE__
#include <stddef.h>
#include <sys/types.h>
/* FD 3 carries an opened engine image to the peer, never an AUTH token. */
#define QN_MACOS_IMAGE_FD 3
int qn_macos_executable(char *out, size_t size);
int qn_macos_fd_executable(int fd);
int qn_macos_pipe(int fds[2]);
int qn_macos_spawn(pid_t *pid, const char *program, int program_fd,
                   int input_fd, char *const argv[], char *const envp[]);
#endif
#endif
