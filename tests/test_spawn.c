/* test_spawn.c — engine-side child lifecycle: token delivery to stdin and
 * nowhere else, absolute-path resolution with no PATH fallback, reaping,
 * the watchdog, and the hard respawn cap. The fake children are #!/bin/sh
 * scripts on purpose: the kernel executes the shebang — the module under
 * test builds an execve argv array and never asks a shell to interpret
 * anything. Every wait is bounded, so a regression fails the suite
 * instead of hanging it. ASan+UBSan via make check. */
#define _GNU_SOURCE
#include "../src/driver/qn_spawn.h"

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>

/* No-op handler: an *ignored* SIGALRM would never interrupt write(),
 * only a handled one forces the EINTR retry path the delivery loop
 * promises to survive. */
static void noop_alarm(int sig) { (void)sig; }

static int checks;
static int failures;

#define CHECK(cond)                                                     \
    do {                                                                \
        checks++;                                                       \
        if (!(cond)) {                                                  \
            failures++;                                                 \
            printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond);      \
        }                                                               \
    } while (0)

static const uint8_t TOK[QN_SPAWN_TOKEN_LEN] = {
    0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04,
    0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C,
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27
};

static char tmpdir[256];

static void tok_variant(uint8_t out[QN_SPAWN_TOKEN_LEN], uint8_t fill)
{
    memset(out, fill, QN_SPAWN_TOKEN_LEN);
}

/* Bounded reap wait, observer-independent: the internal reaper in stop()
 * and watchdog() may legitimately win the race with our poll, so the
 * state — not our waitpid — decides. */
static int wait_exit(qn_spawn_t *s)
{
    for (int i = 0; i < 2000; i++) {
        if (s->exited || qn_spawn_check(s, 0)) {
            return 1;
        }
        usleep(1000);
    }
    return 0;
}

static int setup_tmpdir(void)
{
    char tmpl[] = "/tmp/qnspawnXXXXXX";
    char *d = mkdtemp(tmpl);
    if (d == NULL) {
        return -1;
    }
    snprintf(tmpdir, sizeof tmpdir, "%s", d);
    return chmod(tmpdir, 0700);
}

static void cleanup_tmpdir_files(void)
{
    char p[512];
    static const char *names[] = { "cap", "capelf", "cmdline.out",
                                   "environ.out", "cap.sh", "dump.sh",
                                   "exit3.sh", "hang.sh", "noexec",
                                   "badprog", "peer.elf" };
    for (size_t i = 0; i < sizeof names / sizeof *names; i++) {
        snprintf(p, sizeof p, "%s/%s", tmpdir, names[i]);
        unlink(p);
    }
    if (rmdir(tmpdir) != 0) {
        printf("NOTE: spawn sandbox dir left behind (unexpected files?)\n");
    }
}

/* Write an executable file; mode 0755 unless mode_arg given. */
static int write_exec(const char *name, const char *body, int executable)
{
    char path[512];
    snprintf(path, sizeof path, "%s/%s", tmpdir, name);
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) {
        return -1;
    }
    size_t n = strlen(body), off = 0;
    while (off < n) {
        ssize_t w = write(fd, body + off, n - off);
        if (w <= 0) {
            close(fd);
            return -1;
        }
        off += (size_t)w;
    }
    close(fd);
    return chmod(path, executable ? 0755 : 0644);
}

static ssize_t read_file(const char *name, char *buf, size_t cap)
{
    char path[512];
    snprintf(path, sizeof path, "%s/%s", tmpdir, name);
    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        return -1;
    }
    size_t total = 0;
    for (;;) {
        ssize_t r = read(fd, buf + total, cap - total);
        if (r < 0) {
            close(fd);
            return -1;
        }
        if (r == 0) {
            break;
        }
        total += (size_t)r;
        if (total == cap) {
            break;
        }
    }
    close(fd);
    return (ssize_t)total;
}

/* ---- resolution ---- */

static void test_resolve(void)
{
    char out[4096];
    const char *reason = NULL;

    CHECK(write_exec("cap.sh", "#!/bin/sh\ncat > \"$1\"\n", 1) == 0);
    char script[512];
    snprintf(script, sizeof script, "%s/cap.sh", tmpdir);

    /* explicit absolute, executable: accepted, copied verbatim */
    CHECK(qn_spawn_resolve(out, sizeof out, script, &reason) == 0);
    CHECK(strcmp(out, script) == 0);

    /* relative name: never a PATH search */
    CHECK(qn_spawn_resolve(out, sizeof out, "qn-peer", &reason) == -1);
    CHECK(reason != NULL && *reason != '\0');

    /* missing sibling of this binary: clean refusal, no fallback */
    reason = NULL;
    CHECK(qn_spawn_resolve(out, sizeof out, NULL, &reason) == -1);
    CHECK(reason != NULL && *reason != '\0');

    /* non-executable regular file: refused */
    CHECK(write_exec("noexec", "#!/bin/sh\nexit 0\n", 0) == 0);
    char noexec[512];
    snprintf(noexec, sizeof noexec, "%s/noexec", tmpdir);
    reason = NULL;
    CHECK(qn_spawn_resolve(out, sizeof out, noexec, &reason) == -1);
    CHECK(reason != NULL && *reason != '\0');

    /* does not fit: refused, not truncated */
    reason = NULL;
    CHECK(qn_spawn_resolve(out, 4, script, &reason) == -1);
}

/* ---- token delivery ---- */

static void test_token_stdin(void)
{
    qn_spawn_t s;
    qn_spawn_init(&s);
    const char *reason = NULL;
    char cap[512], script[512];
    snprintf(cap, sizeof cap, "%s/cap", tmpdir);
    snprintf(script, sizeof script, "%s/cap.sh", tmpdir);
    char *const argv[] = { script, cap, NULL };
    char *const envp[] = { "QN_SAFE=1", NULL };

    CHECK(qn_spawn_start(&s, script, argv, envp, TOK, 1000, &reason) == 0);
    CHECK(reason != NULL && *reason == '\0');
    CHECK(qn_spawn_running(&s));
    CHECK(s.boot_ms == 1000);
    CHECK(s.handshakes == 1);
    CHECK(wait_exit(&s));
    CHECK(!qn_spawn_running(&s));
    CHECK(WIFEXITED(s.exit_status));
    CHECK(WEXITSTATUS(s.exit_status) == 0);

    char buf[4096];
    ssize_t n = read_file("cap", buf, sizeof buf);
    CHECK(n == (ssize_t)QN_SPAWN_TOKEN_LEN);
    CHECK(n > 0 && memcmp(buf, TOK, QN_SPAWN_TOKEN_LEN) == 0);
    unlink(cap);
}

/* The token must exist in stdin and nowhere else the child exposes:
 * its command line and its environment are both dumped and checked. */
static void test_no_token_elsewhere(void)
{
    qn_spawn_t s;
    qn_spawn_init(&s);
    const char *reason = NULL;
    CHECK(write_exec("dump.sh",
                     "#!/bin/sh\n"
                     "cat /proc/$$/cmdline > \"$1\"\n"
                     "cat /proc/$$/environ > \"$2\"\n"
                     "cat > /dev/null\n", 1) == 0);
    char c1[512], c2[512], script[512];
    snprintf(c1, sizeof c1, "%s/cmdline.out", tmpdir);
    snprintf(c2, sizeof c2, "%s/environ.out", tmpdir);
    snprintf(script, sizeof script, "%s/dump.sh", tmpdir);
    char *const argv[] = { script, c1, c2, NULL };
    char *const envp[] = { "QN_SAFE=1", NULL };

    CHECK(qn_spawn_start(&s, script, argv, envp, TOK, 1000, &reason) == 0);
    CHECK(wait_exit(&s));

    char cmd[4096], env[4096];
    ssize_t cl = read_file("cmdline.out", cmd, sizeof cmd);
    ssize_t el = read_file("environ.out", env, sizeof env);
    CHECK(cl > 0 && el > 0);
    /* the dump really contains what it should... */
    CHECK(cl > 0 && memmem(cmd, (size_t)cl, script, strlen(script)) != NULL);
    CHECK(el > 0 && memmem(env, (size_t)el, "QN_SAFE=1", 9) != NULL);
    /* ...and never the token */
    CHECK(cl > 0 && memmem(cmd, (size_t)cl, TOK, QN_SPAWN_TOKEN_LEN) == NULL);
    CHECK(el > 0 && memmem(env, (size_t)el, TOK, QN_SPAWN_TOKEN_LEN) == NULL);
    unlink(c1);
    unlink(c2);
}

/* ---- reaping + exit status ---- */

static void test_early_exit(void)
{
    qn_spawn_t s;
    qn_spawn_init(&s);
    const char *reason = NULL;
    CHECK(write_exec("exit3.sh", "#!/bin/sh\nexit 3\n", 1) == 0);
    char script[512];
    snprintf(script, sizeof script, "%s/exit3.sh", tmpdir);
    char *const argv[] = { script, NULL };

    CHECK(qn_spawn_start(&s, script, argv, NULL, TOK, 1000, &reason) == 0);
    CHECK(wait_exit(&s));
    CHECK(WIFEXITED(s.exit_status));
    CHECK(WEXITSTATUS(s.exit_status) == 3);
    /* reaping is exactly once; a second check finds nothing */
    CHECK(qn_spawn_check(&s, 0) == 0);
}

/* ---- watchdog ---- */

static void test_watchdog(void)
{
    qn_spawn_t s;
    qn_spawn_init(&s);
    const char *reason = NULL;
    CHECK(write_exec("hang.sh", "#!/bin/sh\nexec sleep 31\n", 1) == 0);
    char script[512];
    snprintf(script, sizeof script, "%s/hang.sh", tmpdir);
    char *const argv[] = { script, NULL };

    CHECK(qn_spawn_start(&s, script, argv, NULL, TOK, 1000, &reason) == 0);
    /* inside the window: untouched */
    CHECK(qn_spawn_watchdog(&s, 1000 + QN_SPAWN_WATCHDOG_MS) == 0);
    CHECK(qn_spawn_running(&s));
    /* past it: SIGKILL and reap */
    CHECK(qn_spawn_watchdog(&s, 1000 + QN_SPAWN_WATCHDOG_MS + 1) == 1);
    CHECK(s.killed == 1);
    CHECK(wait_exit(&s));
    CHECK(WIFSIGNALED(s.exit_status));
    CHECK(WTERMSIG(s.exit_status) == SIGKILL);

    /* an authed child is never watchdoged, and stop() still reaps it */
    uint8_t t2[QN_SPAWN_TOKEN_LEN];
    tok_variant(t2, 0x77);
    CHECK(qn_spawn_start(&s, script, argv, NULL, t2, 5000, &reason) == 0);
    s.authed = 1;
    CHECK(qn_spawn_watchdog(&s, 5000 + 1000000) == 0);
    CHECK(qn_spawn_running(&s));
    pid_t live = s.pid;
    qn_spawn_stop(&s);
    CHECK(wait_exit(&s)); /* the pump's check() completes the best-effort reap */
    CHECK(kill(live, 0) == -1 && errno == ESRCH); /* no orphan, no zombie */
}

/* ---- respawn cap + freshness ---- */

static void test_cap_and_freshness(void)
{
    qn_spawn_t s;
    qn_spawn_init(&s);
    const char *reason = NULL;
    char script[512];
    snprintf(script, sizeof script, "%s/exit3.sh", tmpdir);
    CHECK(write_exec("exit3.sh", "#!/bin/sh\nexit 3\n", 1) == 0);
    char *const argv[] = { script, NULL };
    uint8_t tk[QN_SPAWN_TOKEN_LEN];

    /* three deliveries, each a distinct fresh token */
    for (unsigned i = 0; i < QN_SPAWN_MAX_HANDSHAKES; i++) {
        tok_variant(tk, (uint8_t)(0x30 + i));
        reason = NULL;
        CHECK(qn_spawn_start(&s, script, argv, NULL, tk, 1000 * (i + 1),
                             &reason) == 0);
        CHECK(wait_exit(&s));
    }
    CHECK(s.handshakes == QN_SPAWN_MAX_HANDSHAKES);

    /* the fourth is a hard stop, before any fork */
    tok_variant(tk, 0x7F);
    reason = NULL;
    CHECK(qn_spawn_start(&s, script, argv, NULL, tk, 9000, &reason) == -1);
    CHECK(reason != NULL && *reason != '\0');
    CHECK(!qn_spawn_running(&s));
    CHECK(s.pid == -1);

    /* a repeated token is refused even while under the cap */
    qn_spawn_t f;
    qn_spawn_init(&f);
    tok_variant(tk, 0x41);
    CHECK(qn_spawn_start(&f, script, argv, NULL, tk, 100, &reason) == 0);
    CHECK(wait_exit(&f));
    reason = NULL;
    CHECK(qn_spawn_start(&f, script, argv, NULL, tk, 200, &reason) == -1);
    CHECK(reason != NULL && *reason != '\0');
    CHECK(f.handshakes == 1); /* refusals never consume the cap */

    /* A,B,A: reuse is refused against the whole history, not just the
     * immediately previous token. */
    qn_spawn_t h;
    uint8_t ta[QN_SPAWN_TOKEN_LEN], tb[QN_SPAWN_TOKEN_LEN];
    qn_spawn_init(&h);
    tok_variant(ta, 0xA1);
    tok_variant(tb, 0xB2);
    CHECK(qn_spawn_start(&h, script, argv, NULL, ta, 10, &reason) == 0);
    CHECK(wait_exit(&h));
    CHECK(qn_spawn_start(&h, script, argv, NULL, tb, 20, &reason) == 0);
    CHECK(wait_exit(&h));
    reason = NULL;
    CHECK(qn_spawn_start(&h, script, argv, NULL, ta, 30, &reason) == -1);
    CHECK(reason != NULL && *reason != '\0');
}

/* ---- start refusals and the argv/env tripwire ---- */

static void test_refusals(void)
{
    qn_spawn_t s;
    qn_spawn_init(&s);
    const char *reason = NULL;
    char script[512];
    snprintf(script, sizeof script, "%s/exit3.sh", tmpdir);
    char *const good[] = { script, NULL };

    reason = NULL;
    CHECK(qn_spawn_start(&s, NULL, good, NULL, TOK, 1, &reason) == -1);
    reason = NULL;
    CHECK(qn_spawn_start(&s, script, NULL, NULL, TOK, 1, &reason) == -1);
    /* argv[0] must be the resolved program, not a different name */
    char *const drift[] = { (char *)"liar", NULL };
    reason = NULL;
    CHECK(qn_spawn_start(&s, script, drift, NULL, TOK, 1, &reason) == -1);
    CHECK(reason != NULL && *reason != '\0');
    CHECK(s.handshakes == 0);

    /* token bytes handed to the child via argv: refused outright */
    char stolen[QN_SPAWN_TOKEN_LEN + 1];
    memset(stolen, 'A', QN_SPAWN_TOKEN_LEN);
    stolen[QN_SPAWN_TOKEN_LEN] = '\0';
    uint8_t tA[QN_SPAWN_TOKEN_LEN];
    tok_variant(tA, 'A');
    char *const targv[] = { script, stolen, NULL };
    reason = NULL;
    CHECK(qn_spawn_start(&s, script, targv, NULL, tA, 1, &reason) == -1);
    CHECK(reason != NULL && *reason != '\0');
    /* ...or via the environment: same refusal */
    char *const tenvp[] = { stolen, NULL };
    reason = NULL;
    CHECK(qn_spawn_start(&s, script, good, tenvp, tA, 1, &reason) == -1);
    CHECK(s.handshakes == 0);

    /* a second start while one is live: refused */
    char hscript[512];
    snprintf(hscript, sizeof hscript, "%s/hang.sh", tmpdir);
    char *const hargv[] = { hscript, NULL };
    uint8_t t1[QN_SPAWN_TOKEN_LEN];
    CHECK(qn_spawn_make_token(t1) == 0);
    CHECK(qn_spawn_start(&s, hscript, hargv, NULL, t1, 10, &reason) == 0);
    reason = NULL;
    uint8_t t2[QN_SPAWN_TOKEN_LEN];
    CHECK(qn_spawn_make_token(t2) == 0);
    CHECK(qn_spawn_start(&s, hscript, hargv, NULL, t2, 11, &reason) == -1);
    CHECK(qn_spawn_running(&s));
    qn_spawn_stop(&s);
    CHECK(wait_exit(&s));
    CHECK(qn_spawn_running(&s) == 0);
}

/* The descriptor fast path only exists for ELF images (the kernel cannot
 * exec a script from an fd), so every script fake above rides the path
 * fallback — an ELF lane is the only check that the fast path itself
 * delivers the token and exits clean. dd copies our stdin into of=. */
static void test_elf_from_descriptor(void)
{
    qn_spawn_t s;
    qn_spawn_init(&s);
    const char *reason = NULL;
    const char *sys[] = { "/usr/bin/dd", "/bin/dd", NULL };
    char elf[512];
    snprintf(elf, sizeof elf, "%s/peer.elf", tmpdir);
    int src = -1;
    for (int i = 0; sys[i] != NULL; i++) {
        src = open(sys[i], O_RDONLY);
        if (src >= 0) {
            break;
        }
    }
    CHECK(src >= 0);
    if (src < 0) {
        return;
    }
    int dst = open(elf, O_WRONLY | O_CREAT | O_TRUNC, 0755);
    CHECK(dst >= 0);
    if (dst < 0) {
        close(src);
        return;
    }
    char chunk[65536];
    ssize_t r;
    while ((r = read(src, chunk, sizeof chunk)) > 0) {
        ssize_t off = 0;
        while (off < r) {
            ssize_t w = write(dst, chunk + off, (size_t)(r - off));
            CHECK(w > 0);
            if (w <= 0) {
                break;
            }
            off += w;
        }
    }
    CHECK(r == 0);
    close(src);
    close(dst);

    char capelf[512];
    snprintf(capelf, sizeof capelf, "%s/capelf", tmpdir);
    char of_arg[600];
    snprintf(of_arg, sizeof of_arg, "of=%s", capelf);
    char *const argv[] = { elf, of_arg, (char *)"status=none", NULL };
    uint8_t tk[QN_SPAWN_TOKEN_LEN];
    CHECK(qn_spawn_make_token(tk) == 0);
    CHECK(qn_spawn_start(&s, elf, argv, NULL, tk, 1000, &reason) == 0);
    CHECK(wait_exit(&s));
    CHECK(WIFEXITED(s.exit_status));
    CHECK(WEXITSTATUS(s.exit_status) == 0);
    char buf[4096];
    ssize_t n = read_file("capelf", buf, sizeof buf);
    CHECK(n == (ssize_t)QN_SPAWN_TOKEN_LEN);
    CHECK(n > 0 && memcmp(buf, tk, QN_SPAWN_TOKEN_LEN) == 0);
    unlink(capelf);
    unlink(elf);
}

/* Delivery races a child that dies on its own — before the fix, a lost
 * race was not a failed start but a dead engine: write() to a pipe with
 * no reader raises SIGPIPE before returning. Many races so both orders
 * occur; reaching the end of this lane at all is the regression proof,
 * since the pre-fix binary dies of its own signal under at least one. */
static void test_delivery_races_survive(void)
{
    int deliveries = 0, rejections = 0, delivery_fails = 0;
    char script[512];
    snprintf(script, sizeof script, "%s/exit3.sh", tmpdir);
    CHECK(write_exec("exit3.sh", "#!/bin/sh\nexit 3\n", 1) == 0);
    char *const argv[] = { script, NULL };
    char bad[512];
    snprintf(bad, sizeof bad, "%s/badprog", tmpdir);
    CHECK(write_exec("badprog", "this is not a loadable image\n", 1) == 0);
    char *const bargv[] = { bad, NULL };

    int races = 200;
    const char *env = getenv("QN_SPAWN_RACES");
    if (env != NULL) {
        long v = strtol(env, NULL, 10);
        if (v >= 1 && v <= 20000) {
            races = (int)v;
        }
    }
    /* On an idle box the parent's 32-byte write wins the race against the
     * child's death every time, so the delivery-failure branch stays
     * defensive-only. Load mode hammers it two ways: CPU hogs preempt the
     * parent between fork and write, and a handled 1 ms SIGALRM storms the
     * write loop with EINTR retries, so the token can land only after the
     * reader is gone. Under QN_SPAWN_LOAD=1 the branch MUST be seen. */
    int load_mode = getenv("QN_SPAWN_LOAD") != NULL;
    struct sigaction old_alarm;
    if (load_mode) {
        struct sigaction sa;
        memset(&sa, 0, sizeof sa);
        sa.sa_handler = noop_alarm;
        sigemptyset(&sa.sa_mask);
        sa.sa_flags = 0; /* no SA_RESTART: we WANT EINTR from write() */
        if (sigaction(SIGALRM, &sa, &old_alarm) != 0) {
            load_mode = 0; /* cannot force the storm; skip the mandate */
        } else {
            struct itimerval every;
            every.it_interval.tv_sec = 0;
            every.it_interval.tv_usec = 1000;
            every.it_value = every.it_interval;
            if (setitimer(ITIMER_REAL, &every, NULL) != 0) {
                load_mode = 0;
                sigaction(SIGALRM, &old_alarm, NULL);
            }
        }
    }
    int done = 0;
    for (int i = 0; i < races; i++) {
        qn_spawn_t s;
        qn_spawn_init(&s);
        uint8_t tk[QN_SPAWN_TOKEN_LEN];
        CHECK(qn_spawn_make_token(tk) == 0);
        const char *reason = NULL;
        int r = qn_spawn_start(&s, i % 2 ? script : bad,
                               i % 2 ? argv : bargv, NULL, tk,
                               (uint64_t)i * 10, &reason);
        if (r == 0) {
            CHECK(wait_exit(&s)); /* the pump completes the reap */
            deliveries++;
        } else {
            CHECK(reason != NULL && *reason != '\0');
            CHECK(!qn_spawn_running(&s)); /* refusals never leave a child */
            rejections++;
            if (reason != NULL &&
                strcmp(reason, "child died before taking the token") == 0) {
                delivery_fails++; /* the branch under witness, by name */
            }
        }
        done++;
        /* Load mode keeps racing until the delivery-failure branch has
         * been seen once; on a contended box that costs a fraction of
         * the budget, on an idle one it burns the full cap and then
         * honestly fails the mandate below. */
        if (load_mode && delivery_fails > 0) {
            break;
        }
    }
    if (load_mode) {
        struct itimerval off;
        memset(&off, 0, sizeof off);
        setitimer(ITIMER_REAL, &off, NULL);
        /* Disarming does not discard an already-pending tick; delivering
         * it to the no-op handler here keeps it from waking after the
         * SIG_DFL restore below and terminating the suite. */
        raise(SIGALRM);
        sigaction(SIGALRM, &old_alarm, NULL);
    }
    CHECK(deliveries + rejections == done);
    CHECK(done == races || delivery_fails > 0); /* early stop only on a hit */
    if (load_mode) {
        CHECK(delivery_fails > 0);
    }
}

int qn_test_spawn(int *checks_out)
{
    if (setup_tmpdir() != 0) {
        printf("FAIL spawn suite cannot build its sandbox\n");
        *checks_out = 0;
        return 1;
    }
    test_resolve();
    test_token_stdin();
    test_no_token_elsewhere();
    test_early_exit();
    test_watchdog();
    test_elf_from_descriptor();
    test_cap_and_freshness();
    test_refusals();
    test_delivery_races_survive();
    cleanup_tmpdir_files();
    *checks_out = checks;
    if (failures) {
        printf("QN spawn tests FAILED: %d/%d\n", failures, checks);
        return 1;
    }
    return 0;
}
