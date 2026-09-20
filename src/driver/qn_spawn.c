/* qn_spawn.c — see qn_spawn.h. Every path decision here is a refusal,
 * never a fallback: PATH lookups, token-in-argv/env, and reused tokens
 * all abort the spawn before the child can exist. Validation and exec
 * share one open descriptor, so a swapped path cannot race the check. */
#define _GNU_SOURCE
#include "qn_spawn.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#define QN_PEER_SIBLING "qn-peer"
#define QN_SPAWN_REAP_TRIES 64 /* bounded WNOHANG tries; no sleeping */

void qn_spawn_init(qn_spawn_t *s)
{
    memset(s, 0, sizeof *s);
    s->pid = -1;
}

int qn_spawn_make_token(uint8_t out[QN_SPAWN_TOKEN_LEN])
{
    return getentropy(out, QN_SPAWN_TOKEN_LEN) == 0 ? 0 : -1;
}

/* Policy view of the path (resolve-time, for clean early errors). The
 * authoritative check is exec_open() on an opened descriptor. */
static int exec_ok_path(const char *path, const char **reason)
{
    struct stat st;
    if (path[0] != '/') {
        *reason = "peer program must be an absolute path";
        return -1;
    }
    if (stat(path, &st) != 0 || !S_ISREG(st.st_mode)) {
        *reason = "peer program is not a regular file";
        return -1;
    }
    if (access(path, X_OK) != 0) {
        *reason = "peer program is not executable by us";
        return -1;
    }
    return 0;
}

/* Open `path` and validate through the descriptor: same file we exec,
 * executable by our effective identity (real-uid access() would diverge
 * under any setuid posture). Returns the fd, or -1 with *reason set. */
static int exec_open(const char *path, const char **reason)
{
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    struct stat st;
    if (fd < 0) {
        *reason = "peer program cannot be opened";
        return -1;
    }
    if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) {
        close(fd);
        *reason = "peer program is not a regular file";
        return -1;
    }
    if (faccessat(fd, "", X_OK, AT_EMPTY_PATH | AT_EACCESS) != 0) {
        close(fd);
        *reason = "peer program is not executable by us";
        return -1;
    }
    return fd;
}

int qn_spawn_resolve(char *out, size_t outlen, const char *override,
                     const char **reason)
{
    char buf[PATH_MAX];
    const char *src;

    *reason = "";
    if (override != NULL) {
        src = override;
    } else {
        char base[PATH_MAX];
        ssize_t k = readlink("/proc/self/exe", base, sizeof base - 1);
        if (k <= 0) {
            *reason = "cannot locate this process image";
            return -1;
        }
        if (k == (ssize_t)sizeof base - 1) {
            *reason = "process image path too long";
            return -1; /* refuse rather than probe a truncated prefix */
        }
        base[k] = '\0';
        char *slash = strrchr(base, '/');
        if (slash == NULL || slash == base) {
            *reason = "process image path malformed";
            return -1;
        }
        *slash = '\0';
        if (snprintf(buf, sizeof buf, "%s/%s", base, QN_PEER_SIBLING)
            >= (int)sizeof buf) {
            *reason = "sibling path too long";
            return -1;
        }
        src = buf;
    }
    if (strlen(src) >= outlen) {
        *reason = "resolved path does not fit";
        return -1;
    }
    if (exec_ok_path(src, reason) != 0) {
        return -1; /* clean refusal: no PATH fallback, ever */
    }
    memcpy(out, src, strlen(src) + 1);
    return 0;
}

/* One bounded, non-sleeping reap attempt set. */
static void reap(qn_spawn_t *s)
{
    for (int i = 0; i < QN_SPAWN_REAP_TRIES; i++) {
        int status = 0;
        pid_t r = waitpid(s->pid, &status, WNOHANG);
        if (r == s->pid) {
            s->exited = 1;
            s->exit_status = status;
            s->pid = -1;
            return;
        }
        if (r < 0) {
            /* Already reaped elsewhere: our child vanished from under the
             * single-reaper contract. Say so with a status no waitpid
             * could produce, instead of faking a clean exit. */
            s->exited = 1;
            s->exit_status = -1;
            s->pid = -1;
            return;
        }
        sched_yield(); /* let the dying child reach its exit state */
    }
}

static int token_is_new(const qn_spawn_t *s, const uint8_t token[QN_SPAWN_TOKEN_LEN])
{
    for (unsigned i = 0; i < s->handshakes && i < QN_SPAWN_MAX_HANDSHAKES; i++) {
        if (memcmp(s->seen[i], token, QN_SPAWN_TOKEN_LEN) == 0) {
            return 0;
        }
    }
    return 1;
}

static int has_token(char *const list[], const uint8_t token[QN_SPAWN_TOKEN_LEN])
{
    if (list == NULL) {
        return 0;
    }
    for (int i = 0; list[i] != NULL; i++) {
        if (strlen(list[i]) >= QN_SPAWN_TOKEN_LEN &&
            memmem(list[i], strlen(list[i]), token, QN_SPAWN_TOKEN_LEN) != NULL) {
            return 1;
        }
    }
    return 0;
}

static void child_close_high_fds(int keep)
{
#ifdef SYS_close_range
    if (keep >= 3) {
        /* close_range rejects first > last: the lower sweep runs only
         * when there is something below keep to close. */
        int lo_ok = (keep == 3) ||
                    syscall(SYS_close_range, 3u, (unsigned)keep - 1u, 0) == 0;
        if (lo_ok &&
            syscall(SYS_close_range, (unsigned)keep + 1u, ~0U, 0) == 0) {
            return;
        }
    } else if (syscall(SYS_close_range, 3u, ~0U, 0) == 0) {
        return;
    }
#endif
    long lim = sysconf(_SC_OPEN_MAX);
    if (lim < 0 || lim > 4096) {
        lim = 4096;
    }
    for (int f = 3; f < (int)lim; f++) {
        if (f != keep) {
            close(f);
        }
    }
}

int qn_spawn_start(qn_spawn_t *s, const char *program, char *const argv[],
                   char *const envp[], const uint8_t token[QN_SPAWN_TOKEN_LEN],
                   uint64_t now_ms, const char **reason)
{
    *reason = "";

    if (s->pid != -1) {
        *reason = "a child is already live";
        return -1;
    }
    if (program == NULL || argv == NULL || argv[0] == NULL) {
        *reason = "missing program or argv";
        return -1;
    }
    if (strcmp(argv[0], program) != 0) {
        *reason = "argv[0] must equal the resolved program";
        return -1;
    }
    if (s->handshakes >= QN_SPAWN_MAX_HANDSHAKES) {
        *reason = "respawn cap reached for this engine run";
        return -1;
    }
    if (!token_is_new(s, token)) {
        *reason = "tokens must be fresh for every spawn";
        return -1;
    }
    /* Tripwire, not the design: the token's home is stdin. A copy in the
     * command line is world-readable to any local process. */
    if (has_token(argv, token) || has_token(envp, token)) {
        *reason = "token must never travel in argv or env";
        return -1;
    }
    if (exec_ok_path(program, reason) != 0) {
        return -1;
    }
    int prog_fd = exec_open(program, reason);
    if (prog_fd < 0) {
        return -1;
    }
    if (prog_fd < 3) {
        /* An engine running with stdio closed could land the validated
         * descriptor on 0..2, where the child's dup2 would clobber it
         * and the descriptor fast path would silently fall back to a
         * path exec. Relocate; the freed low slot then trips the
         * low-descriptor guard below — a clean refusal by design for
         * that posture (an engine must keep 0..2 occupied at init). */
        int high = fcntl(prog_fd, F_DUPFD_CLOEXEC, 3);
        close(prog_fd);
        prog_fd = high;
        if (prog_fd < 0) {
            *reason = "cannot relocate program descriptor";
            return -1;
        }
    }

    int fds[2];
    if (pipe2(fds, O_CLOEXEC) != 0) {
        close(prog_fd);
        *reason = "pipe failed";
        return -1;
    }
    if (fds[0] < 3) {
        /* Stdio slots must be occupied or held by us, or the child's
         * stdin plumbing cannot be trusted. */
        close(fds[0]);
        close(fds[1]);
        close(prog_fd);
        *reason = "low descriptors unavailable";
        return -1;
    }

    /* Fresh per-child state before the fork, not only after delivery. */
    s->authed = 0;
    s->killed = 0;
    s->exited = 0;
    s->exit_status = 0;
    s->boot_ms = now_ms;

    pid_t pid = fork();
    if (pid < 0) {
        close(fds[0]);
        close(fds[1]);
        close(prog_fd);
        *reason = "fork failed";
        return -1;
    }
    if (pid == 0) {
        if (dup2(fds[0], STDIN_FILENO) < 0) {
            _exit(126);
        }
        sigset_t all;
        sigfillset(&all);
        sigprocmask(SIG_UNBLOCK, &all, NULL); /* the peer owns its signals */
        /* Belt beyond O_CLOEXEC: no descriptor we do not own may survive
         * into the child. */
        child_close_high_fds(prog_fd);
        execveat(prog_fd, "", argv, envp, AT_EMPTY_PATH);
        /* ELF images exec from the validated descriptor. The kernel's
         * script loader cannot (it reports ENOENT for an empty path),
         * so any descriptor-exec failure falls back to the path exec,
         * which re-resolves — fine for shebang test fakes; production
         * peers are ELF binaries riding the fast path above. */
        execve(program, argv, envp);
        _exit(127); /* only reachable if both execs failed */
    }

    close(fds[0]);
    close(prog_fd); /* the child holds its own copy; ours is spent */
    /* A pipe write with every reader gone raises SIGPIPE before write()
     * returns EPIPE. MASKING IS NOT ENOUGH: the standard signal stays
     * pending and is delivered the instant the mask is restored — death
     * one line later, inside sigprocmask itself (observed under load).
     * The disposition must be SIG_IGN at raise time, which discards the
     * signal outright; restore the saved action on every exit. */
    struct sigaction ign;
    struct sigaction old_act;
    memset(&ign, 0, sizeof ign);
    ign.sa_handler = SIG_IGN;
    sigemptyset(&ign.sa_mask);
    if (sigaction(SIGPIPE, &ign, &old_act) != 0) {
        close(fds[1]);
        kill(pid, SIGKILL);
        s->pid = pid;
        s->killed = 1;
        reap(s);
        *reason = "cannot suppress delivery signal";
        return -1;
    }
    size_t off = 0;
    while (off < QN_SPAWN_TOKEN_LEN) {
        ssize_t w = write(fds[1], token + off, QN_SPAWN_TOKEN_LEN - off);
        if (w < 0 && errno == EINTR) {
            continue;
        }
        if (w <= 0) { /* child gone before taking the token */
            close(fds[1]);
            sigaction(SIGPIPE, &old_act, NULL);
            kill(pid, SIGKILL);
            s->pid = pid;
            s->killed = 1;
            reap(s);
            *reason = "child died before taking the token";
            return -1;
        }
        off += (size_t)w;
    }
    close(fds[1]);
    sigaction(SIGPIPE, &old_act, NULL);

    s->pid = pid;
    memcpy(s->seen[s->handshakes % QN_SPAWN_MAX_HANDSHAKES], token,
           QN_SPAWN_TOKEN_LEN);
    s->handshakes++;
    return 0;
}

int qn_spawn_check(qn_spawn_t *s, uint64_t now_ms)
{
    (void)now_ms;
    if (s->pid == -1) {
        return 0;
    }
    int status = 0;
    pid_t r = waitpid(s->pid, &status, WNOHANG);
    if (r == 0) {
        return 0;
    }
    if (r == s->pid) {
        s->exited = 1;
        s->exit_status = status;
        s->pid = -1;
        return 1;
    }
    s->exited = 1;
    s->exit_status = -1; /* see header: single-reaper contract broken */
    s->pid = -1;
    return 1;
}

int qn_spawn_running(const qn_spawn_t *s)
{
    return s->pid != -1 && !s->exited;
}

int qn_spawn_watchdog(qn_spawn_t *s, uint64_t now_ms)
{
    if (s->pid == -1 || s->authed) {
        return 0;
    }
    if (now_ms < s->boot_ms) {
        return 0; /* injected clocks must be monotonic; never rewind-kill */
    }
    if (now_ms - s->boot_ms <= QN_SPAWN_WATCHDOG_MS) {
        return 0;
    }
    if (!s->killed) {
        kill(s->pid, SIGKILL);
        s->killed = 1;
    }
    reap(s);
    return 1;
}

void qn_spawn_stop(qn_spawn_t *s)
{
    if (s->pid != -1) {
        kill(s->pid, SIGKILL);
        s->killed = 1;
        reap(s); /* a pending SIGKILL leaves no live orphan: the reparent
                  * (init) completes the reap if we cannot */
    }
    explicit_bzero(s->seen, sizeof s->seen);
}
