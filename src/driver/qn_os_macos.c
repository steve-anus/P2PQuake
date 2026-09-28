/* macOS process primitives. GPL-2.0-or-later.
 * Darwin has no execveat/fexecve. posix_spawn executes the validated absolute
 * path (including packaged Mach-O runtimes); it never searches PATH. A final
 * inode comparison catches path replacement before spawn, but is not an
 * atomic fd-exec guarantee. The install directory must be trusted, just as
 * the script entry and its modules must be on the other platforms.
 * posix_spawn avoids running libc in a fork child of SDL/Metal's threads. */
#ifdef __APPLE__
#include "qn_os_macos.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int qn_macos_executable(char *out, size_t size)
{
    char raw[PATH_MAX];
    uint32_t n = sizeof raw;
    char resolved[PATH_MAX];
    if (_NSGetExecutablePath(raw, &n) != 0 || !realpath(raw, resolved)) return -1;
    size_t len = strlen(resolved);
    if (len >= size) return -1;
    memcpy(out, resolved, len + 1);
    return 0;
}

int qn_macos_fd_executable(int fd)
{
    char name[PATH_MAX];
    struct stat held, named;
    if (fcntl(fd, F_GETPATH, name) < 0 || fstat(fd, &held) < 0 ||
        stat(name, &named) < 0 || held.st_dev != named.st_dev ||
        held.st_ino != named.st_ino) return -1;
    return faccessat(AT_FDCWD, name, X_OK, AT_EACCESS);
}

int qn_macos_pipe(int fds[2])
{
    if (pipe(fds) < 0) return -1;
    if (fcntl(fds[0], F_SETFD, FD_CLOEXEC) < 0 ||
        fcntl(fds[1], F_SETFD, FD_CLOEXEC) < 0) {
        close(fds[0]); close(fds[1]); return -1;
    }
    return 0;
}

int qn_macos_spawn(pid_t *pid, const char *program, int program_fd,
                   int input_fd, char *const argv[], char *const envp[])
{
    char image[PATH_MAX];
    struct stat held, named;
    *pid = -1;
    if (fstat(program_fd, &held) < 0 || stat(program, &named) < 0 ||
        held.st_dev != named.st_dev || held.st_ino != named.st_ino ||
        qn_macos_executable(image, sizeof image) < 0) return -1;
    int fd = open(image, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    posix_spawn_file_actions_t actions;
    posix_spawnattr_t attr;
    int error = posix_spawn_file_actions_init(&actions);
    if (error) { close(fd); errno = error; return -1; }
    error = posix_spawnattr_init(&attr);
    if (error) {
        posix_spawn_file_actions_destroy(&actions);
        close(fd); errno = error; return -1;
    }
    sigset_t empty;
    sigemptyset(&empty);
    /* dup stdin first: input_fd may be 3. CLOEXEC_DEFAULT closes even
     * descriptors opened by other threads between validation and spawn. */
    if (!(error = posix_spawnattr_setflags(&attr,
                    POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK)) &&
        !(error = posix_spawnattr_setsigmask(&attr, &empty)) &&
        !(error = posix_spawn_file_actions_adddup2(&actions, input_fd, 0)) &&
        !(error = posix_spawn_file_actions_addinherit_np(&actions, 1)) &&
        !(error = posix_spawn_file_actions_addinherit_np(&actions, 2)) &&
        !(error = posix_spawn_file_actions_adddup2(&actions, fd, QN_MACOS_IMAGE_FD)))
        error = posix_spawn(pid, program, &actions, &attr, argv, envp);
    posix_spawnattr_destroy(&attr);
    posix_spawn_file_actions_destroy(&actions);
    close(fd);
    if (error) { *pid = -1; errno = error; return -1; }
    return 0;
}
#else
typedef int qn_os_macos_translation_unit;
#endif
