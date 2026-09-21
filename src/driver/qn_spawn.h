/* qn_spawn.h — engine-side lifecycle of the qn-peer child (spec §4).
 *
 * The engine generates a fresh token once per spawn and writes it — raw,
 * before anything else — to the child's stdin; the token never travels in
 * argv, the environment, logs, or any file (a token-shaped value found in
 * argv or envp aborts the spawn outright, and a token reused from any
 * earlier spawn of this run does too). The program is opened, validated
 * through that descriptor, and — for ELF images — execed through it too,
 * so the fast path never re-resolves the path; the kernel cannot exec
 * scripts from a descriptor, so shebang programs take a documented
 * path-exec fallback. Nothing is ever searched on PATH (hijack class);
 * a missing or unfit program is a clean refusal, never a fallback.
 *
 * Children are reaped exactly once by this module; a hung pre-authentication
 * child is SIGKILLed after the watchdog deadline, and at most
 * QN_SPAWN_MAX_HANDSHAKES token deliveries happen per engine run — an
 * endless respawn against a tampered peer is a bug farm, so the cap is a
 * hard stop.
 *
 * Time is injected: every entry point that cares takes now_ms and must be
 * fed a monotonic clock (a backward jump is ignored, never trusted); this
 * module never sleeps and never reads a clock itself, which keeps the
 * watchdog testable. */
#ifndef QN_SPAWN_H
#define QN_SPAWN_H

#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

#define QN_SPAWN_TOKEN_LEN 32u       /* same bytes the AUTH gate expects */
#define QN_SPAWN_MAX_HANDSHAKES 3u   /* per engine run, then hard stop */
#define QN_SPAWN_WATCHDOG_MS 6000ull /* auth deadline (5 s) + 1 s grace */

typedef struct {
    pid_t      pid;         /* live child, or -1 */
    int        authed;      /* caller sets 1 when the AUTH gate passed */
    unsigned   handshakes;  /* token deliveries completed this run */
    uint64_t   boot_ms;     /* now_ms at the current child's spawn */
    int        exited;      /* 1 once reaped; exit_status valid */
    int        exit_status; /* raw waitpid status, or -1 if the child was
                             * found already reaped elsewhere (that breaks
                             * the single-reaper contract and is worth
                             * distinguishing from a clean exit). Compare
                             * exit_status == -1 before the wait macros
                             * (WIFEXITED, WIFSIGNALED, WEXITSTATUS,
                             * WTERMSIG): -1 matches none of them, so
                             * they tell you nothing useful about it. */
    int        killed;      /* watchdog or stop issued SIGKILL */
    uint8_t    seen[QN_SPAWN_MAX_HANDSHAKES][QN_SPAWN_TOKEN_LEN];
                            /* freshness tripwire history */
} qn_spawn_t;

void qn_spawn_init(qn_spawn_t *s);

/* 32 fresh CSPRNG bytes. 0 = ok; -1 = entropy failure — the caller must
 * stop rather than spawn with a guessable token. */
int qn_spawn_make_token(uint8_t out[QN_SPAWN_TOKEN_LEN]);

/* Resolve the peer program: `override` must be an absolute path to a
 * regular executable readable by us (NULL = the sibling "qn-peer" beside
 * this process's own binary). Never a PATH search. 0 = ok (path copied to
 * out), -1 = refuse with *reason set. This is the policy check; the
 * authoritative validation happens on an open descriptor in start(). */
int qn_spawn_resolve(char *out, size_t outlen, const char *override,
                     const char **reason);

/* Open + validate `program` by descriptor, fork, and execve it with the
 * given argv (argv[0] must equal program — an execve-style NULL-terminated
 * array, never a shell string) and envp, then write the raw token to the
 * child's stdin as the first action, with SIGPIPE held ignored for the
 * duration (masking would defer the signal into the restore), and close the
 * write end so the child sees EOF right after 32 bytes.
 * Refusals (never leaving a child): live child, bad argv shape, cap
 * reached, reused token, token found in argv/env, unfit program.
 * 0 = child live and fed; -1 = *reason set to a fixed string. */
int qn_spawn_start(qn_spawn_t *s, const char *program, char *const argv[],
                   char *const envp[], const uint8_t token[QN_SPAWN_TOKEN_LEN],
                   uint64_t now_ms, const char **reason);

/* Non-blocking reap: 1 = child exited (exit_status set), 0 = still running
 * or no child. Call every pump iteration — this is the authoritative
 * reaper; stop()'s reap is best effort. */
int qn_spawn_check(qn_spawn_t *s, uint64_t now_ms);

/* 1 while a child is live and unreaped. */
int qn_spawn_running(const qn_spawn_t *s);

/* 1 only when the reaped child ended itself with status 0: it chose to
 * leave. Signals, nonzero status, watchdog kills, and the already-reaped
 * sentinel (-1) all answer 0, without the caller touching wait macros. */
int qn_spawn_exited_cleanly(const qn_spawn_t *s);

/* SIGKILL a child that has not authenticated within the watchdog window
 * (an authed child is never touched) and reap it best effort. A now_ms
 * behind boot_ms is treated as "not due". Returns 1 if this child was or
 * is being killed, 0 for nothing to do. */
int qn_spawn_watchdog(qn_spawn_t *s, uint64_t now_ms);

/* Final teardown: SIGKILL + best-effort reap regardless of auth state —
 * the game must never exit leaving a live peer — and scrub the token
 * history from the struct. The scrub destroys the freshness history:
 * after stop() the cap, not the tripwire, governs any further spawn. */
void qn_spawn_stop(qn_spawn_t *s);

#endif /* QN_SPAWN_H */
