/* qn_spawn_win.h — Windows kernel seam for qn_spawn.c (CreateProcess +
 * Job Object twin of the fork/execveat/waitpid side). Policy (token
 * freshness, handshake cap, argv[0] rule, watchdog timing) stays in
 * qn_spawn.c; this seam owns kernel objects only. Slot ids keep the
 * int pid contract of qn_spawn.h intact. */
#ifndef QN_SPAWN_WIN_H
#define QN_SPAWN_WIN_H

#ifdef _WIN32

#include <stddef.h>
#include <stdint.h>

/* 32 fresh CSPRNG bytes (BCrypt). 0 = ok, -1 = entropy failure. */
int qnw_make_token(uint8_t out[32]);

/* Open `program` by handle BEFORE launch, validate it as a PE image,
 * capture its file identity; feed the raw token to the child stdin
 * through an inheritable pipe (closed pre-create: the child sees EOF
 * after 32 bytes); stdout/stderr to NUL; CreateProcess(SUSPENDED) +
 * job assignment (KILL_ON_JOB_CLOSE: engine death = kernel kills the
 * daemon) + post-create re-verification (the launched image's
 * volume+file-index identity must match the opened handle — a
 * persistent swap refuses; resume happens only after) + resume.
 * argv is quoted
 * per MSVCRT rules into a single command line — never a shell.
 * Returns a slot id (>=0) or -1 with *reason set. */
int qnw_spawn_exec(const char *program, char *const argv[],
                   char *const envp[], const uint8_t token[32],
                   const char **reason);

/* 1 = child live and unreaped. */
int qnw_spawn_alive(int slot);

/* Non-blocking reap: 1 = exited, *exit_status = raw win32 exit code
 * (0 only on a clean child-chosen exit). Closes the kernel handles. */
int qnw_spawn_check(int slot, int *exit_status);

/* Terminate (watchdog / final teardown); idempotent. */
void qnw_spawn_kill(int slot);

/* PE-validate a program path through an open handle (resolve-time
 * check). 0 = ok, -1 = refuse. */
int qnw_prog_is_pe(const char *path);

/* Absolute path of this process image (engine exe). 0 on success, -1 on
 * truncation or failure: callers must treat absence as a refusal. */
int qnw_self_image(char *out, size_t cap);

#endif /* _WIN32 */
#endif /* QN_SPAWN_WIN_H */
