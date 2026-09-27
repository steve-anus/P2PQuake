/* test_transport.c — engine-side Plane A endpoint (spec §2.2, §2.4, §4, §8).
 * The AUTH gate, the terminal-cause doctrine, socket/file permissions,
 * and SO_PEERCRED accept over a real UDS pair. ASan+UBSan via make check. */
#define _GNU_SOURCE
#include "../src/driver/qn_transport.h"

#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

static int checks;
static int failures;

#define CHECK(cond)                                                     \
    do {                                                                \
        checks++;                                                       \
        if (!(cond)) {                                                  \
            failures++;                                                 \
            printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond);       \
        }                                                               \
    } while (0)

static const uint8_t TOK[QN_AUTH_TOKEN_LEN] = {
    0xA5, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
    0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF,
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10
};

/* read with a bounded wait: a regression fails the suite, it never
 * hangs the suite. Returns bytes read, or -1 on timeout/error. */
static ssize_t read_tmo(int fd, uint8_t *b, size_t n)
{
    struct pollfd pfd = { .fd = fd, .events = POLLIN };
    if (poll(&pfd, 1, 2000) <= 0) {
        return -1;
    }
    return read(fd, b, n);
}

static void write_all(int fd, const uint8_t *b, size_t n)
{
    while (n > 0) {
        /* The peer may already be gone; a dead socket must surface as a
         * failed write, never as a signal to this suite. */
        ssize_t w = send(fd, b, n, MSG_NOSIGNAL);
        CHECK(w > 0);
        if (w <= 0) {
            return;
        }
        b += (size_t)w;
        n -= (size_t)w;
    }
}

/* Fresh socketpair with the transport (server) side adopted. */
static void pair_init(qn_transport_t *t, int *testfd, uint64_t now_ms)
{
    int sv[2];
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, sv) == 0);
    CHECK(fcntl(sv[0], F_SETFL, O_NONBLOCK) == 0); /* transport side */
    *testfd = sv[1];
    qn_transport_init(t, sv[0], TOK, now_ms);
}

static size_t frame(uint8_t *buf, uint16_t type, uint32_t seq,
                    const uint8_t *pl, uint16_t len)
{
    size_t n = qn_frame_write(buf, QN_MAX_FRAME, type, seq, pl, len);
    CHECK(n > 0u);
    return n;
}

/* --- the AUTH gate (spec §4) --- */

static void test_auth_gate(void)
{
    qn_transport_t t;
    int fd;
    uint8_t buf[QN_MAX_FRAME];
    size_t n;

    /* happy path */
    pair_init(&t, &fd, 1000);
    CHECK(qn_transport_poll(&t, 1000) == QN_TR_NEED); /* no bytes yet */
    n = frame(buf, QN_T_AUTH, 1, TOK, QN_AUTH_TOKEN_LEN);
    write_all(fd, buf, n);
    CHECK(qn_transport_poll(&t, 1500) == QN_TR_AUTHED);
    CHECK(qn_transport_poll(&t, 1501) == QN_TR_NEED); /* reported once */
    close(fd);
    qn_transport_close(&t);

    /* deadline: strict greater-than on the 5 s bound (§4.4) */
    pair_init(&t, &fd, 1000);
    CHECK(qn_transport_poll(&t, 6000) == QN_TR_NEED); /* exactly 5 s: alive */
    close(fd);
    qn_transport_close(&t);
    pair_init(&t, &fd, 1000);
    CHECK(qn_transport_poll(&t, 6001) == QN_TR_FAIL);
    CHECK(strcmp(t.reason, "auth timeout") == 0);
    close(fd);
    qn_transport_close(&t);

    /* first frame not AUTH -> terminal, whatever else it is (§4.5) */
    pair_init(&t, &fd, 1000);
    n = frame(buf, QN_T_PING, 1, (const uint8_t[]){1, 2, 3, 4}, 4);
    write_all(fd, buf, n);
    CHECK(qn_transport_poll(&t, 1000) == QN_TR_FAIL);
    CHECK(strcmp(t.reason, "auth missing") == 0);
    close(fd);
    qn_transport_close(&t);

    /* AUTH with the wrong sequence */
    pair_init(&t, &fd, 1000);
    n = frame(buf, QN_T_AUTH, 2, TOK, QN_AUTH_TOKEN_LEN);
    write_all(fd, buf, n);
    CHECK(qn_transport_poll(&t, 1000) == QN_TR_FAIL);
    CHECK(strcmp(t.reason, "auth seq") == 0);
    close(fd);
    qn_transport_close(&t);

    /* one flipped token bit, and a short token: both dead (§4.4) */
    pair_init(&t, &fd, 1000);
    {
        uint8_t bad[QN_AUTH_TOKEN_LEN];
        memcpy(bad, TOK, sizeof bad);
        bad[17] ^= 0x01u;
        n = frame(buf, QN_T_AUTH, 1, bad, QN_AUTH_TOKEN_LEN);
    }
    write_all(fd, buf, n);
    CHECK(qn_transport_poll(&t, 1000) == QN_TR_FAIL);
    CHECK(strcmp(t.reason, "auth token") == 0);
    close(fd);
    qn_transport_close(&t);

    pair_init(&t, &fd, 1000);
    n = frame(buf, QN_T_AUTH, 1, TOK, QN_AUTH_TOKEN_LEN - 1u);
    write_all(fd, buf, n);
    CHECK(qn_transport_poll(&t, 1000) == QN_TR_FAIL);
    CHECK(strcmp(t.reason, "auth token") == 0);
    close(fd);
    qn_transport_close(&t);

    /* corrupted CRC anywhere in the first frame: malformed, terminal (§8) */
    pair_init(&t, &fd, 1000);
    n = frame(buf, QN_T_AUTH, 1, TOK, QN_AUTH_TOKEN_LEN);
    buf[n - 2u] ^= 0xFFu; /* CRC byte */
    write_all(fd, buf, n);
    CHECK(qn_transport_poll(&t, 1000) == QN_TR_FAIL);
    CHECK(strcmp(t.reason, "frame malformed") == 0);
    close(fd);
    qn_transport_close(&t);

    /* peer hangs up pre-auth */
    pair_init(&t, &fd, 1000);
    close(fd);
    CHECK(qn_transport_poll(&t, 1000) == QN_TR_CLOSED);
    qn_transport_close(&t);
}

/* --- post-auth frame policy (§2.2, §4.5) --- */

static void auth_in(int fd)
{
    uint8_t buf[QN_MAX_FRAME];
    size_t n = frame(buf, QN_T_AUTH, 1, TOK, QN_AUTH_TOKEN_LEN);
    write_all(fd, buf, n);
}

static void test_post_auth(void)
{
    qn_transport_t t;
    int fd;
    uint8_t buf[QN_MAX_FRAME];
    size_t n;
    qn_frame_t f;

    /* strict increase accepted, regression terminal (§2.2) */
    pair_init(&t, &fd, 1000);
    auth_in(fd);
    CHECK(qn_transport_poll(&t, 1000) == QN_TR_AUTHED);
    n = frame(buf, QN_T_PING, 2, (const uint8_t[]){7}, 1);
    write_all(fd, buf, n);
    CHECK(qn_transport_poll(&t, 1001) == QN_TR_NEED);
    CHECK(qn_transport_recv(&t, &f) == 1);
    CHECK(f.type == QN_T_PING && f.seq == 2u);
    n = frame(buf, QN_T_PONG, 9, (const uint8_t[]){8}, 1); /* gap is fine */
    write_all(fd, buf, n);
    CHECK(qn_transport_poll(&t, 1002) == QN_TR_NEED); /* drain to buffer */
    CHECK(qn_transport_recv(&t, &f) == 1);
    CHECK(f.seq == 9u);
    n = frame(buf, QN_T_PING, 8, (const uint8_t[]){0}, 1); /* regression */
    write_all(fd, buf, n);
    CHECK(qn_transport_poll(&t, 1003) == QN_TR_NEED); /* drain to buffer */
    CHECK(qn_transport_recv(&t, &f) == -1);
    CHECK(strcmp(t.reason, "seq regression") == 0);
    close(fd);
    qn_transport_close(&t);

    /* AUTH again after the gate passed: §4.5 — never accepted twice */
    pair_init(&t, &fd, 1000);
    auth_in(fd);
    CHECK(qn_transport_poll(&t, 1000) == QN_TR_AUTHED);
    n = frame(buf, QN_T_AUTH, 2, TOK, QN_AUTH_TOKEN_LEN);
    write_all(fd, buf, n);
    CHECK(qn_transport_poll(&t, 1001) == QN_TR_NEED); /* poll drains silently */
    CHECK(qn_transport_recv(&t, &f) == -1);
    CHECK(strcmp(t.reason, "auth replay") == 0);
    close(fd);
    qn_transport_close(&t);

    /* engine->peer send: sequence starts at 1 and never restarts */
    pair_init(&t, &fd, 1000);
    auth_in(fd);
    CHECK(qn_transport_poll(&t, 1000) == QN_TR_AUTHED);
    CHECK(qn_transport_send(&t, QN_T_PONG, (const uint8_t[]){1, 2, 3, 4}, 4) == 1);
    CHECK(qn_transport_send(&t, QN_T_SV_DATA, (const uint8_t[]){9}, 1) == 1);
    {
        uint8_t rb[2 * QN_MAX_FRAME];
        ssize_t got = read_tmo(fd, rb, sizeof rb);
        qn_frame_t g;
        CHECK(got > 0);
        CHECK(qn_frame_parse(rb, (size_t)got, &g) == QN_PARSE_OK);
        CHECK(g.type == QN_T_PONG && g.seq == 1u && g.len == 4u);
        CHECK(qn_frame_parse(rb + g.consumed, (size_t)got - g.consumed, &g) == QN_PARSE_OK);
        CHECK(g.type == QN_T_SV_DATA && g.seq == 2u);
    }
    close(fd);
    qn_transport_close(&t);
}

/* --- socket path: directory modes, bind, accept --- */

static int dial(const char *path)
{
    struct sockaddr_un sa;
    int fd = (int)socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        return -1;
    }
    memset(&sa, 0, sizeof sa);
    sa.sun_family = AF_UNIX;
    memcpy(sa.sun_path, path, strlen(path) + 1u);
    if (connect(fd, (struct sockaddr *)&sa, sizeof sa) != 0) {
        close(fd);
        return -1;
    }
    return fd;
}

static char tmpdir[64];

static void test_sockets(void)
{
    const char *reason = NULL;
    struct stat st;
    char path[128], junk[128];
    uint8_t buf[QN_MAX_FRAME];
    qn_transport_t t;
    int lfd, cfd, afd;
    size_t n;

    strcpy(tmpdir, "/tmp/qntr-XXXXXX");
    CHECK(mkdtemp(tmpdir) != NULL);
    snprintf(path, sizeof path, "%s/qn.sock", tmpdir);

    /* listen: real socket file, private to us */
    lfd = qn_transport_listen(path, &reason);
    CHECK(lfd >= 0);
    CHECK(lstat(path, &st) == 0 && S_ISSOCK(st.st_mode));
    CHECK((st.st_mode & 0777u) == 0600u);

    /* full round trip through the real pipe incl. SO_PEERCRED accept */
    cfd = dial(path);
    CHECK(cfd >= 0);
    afd = qn_transport_accept(lfd, &reason);
    CHECK(afd >= 0);
    qn_transport_init(&t, afd, TOK, 500);
    n = frame(buf, QN_T_AUTH, 1, TOK, QN_AUTH_TOKEN_LEN);
    write_all(cfd, buf, n);
    CHECK(qn_transport_poll(&t, 500) == QN_TR_AUTHED);
    CHECK(qn_transport_send(&t, QN_T_PONG, (const uint8_t[]){5, 6}, 2) == 1);
    {
        uint8_t rb[64];
        qn_frame_t f;
        ssize_t got = read_tmo(cfd, rb, sizeof rb);
        CHECK(got > 0);
        CHECK(qn_frame_parse(rb, (size_t)got, &f) == QN_PARSE_OK);
        CHECK(f.type == QN_T_PONG && f.seq == 1u);
    }
    qn_transport_close(&t);
    close(cfd);

    /* re-listen while the original listener still owns the path is
     * refused outright: a second engine stealing a live path would run
     * both daemons on one identity dir (hyperswarm self-meet). */
    {
        int busy = qn_transport_listen(path, &reason);
        CHECK(busy == -1);
        CHECK(reason && strcmp(reason, "listener already live") == 0);
        if (busy >= 0) close(busy);
    }
    close(lfd);

    /* re-listen over our own stale socket file: replaced, not refused */
    lfd = qn_transport_listen(path, &reason);
    CHECK(lfd >= 0);
    close(lfd);

    /* a planted regular file at the path is a refusal, and survives */
    snprintf(junk, sizeof junk, "%s/planted.sock", tmpdir);
    {
        FILE *fp = fopen(junk, "wb");
        CHECK(fp != NULL);
        if (fp) {
            fputs("x", fp);
            fclose(fp);
        }
    }
    lfd = qn_transport_listen(junk, &reason);
    CHECK(lfd == -1);
    CHECK(strcmp(reason, "foreign file") == 0);
    CHECK(access(junk, F_OK) == 0); /* never unlinked */

    /* directory rules: a missing dir is created private; a looser one we
     * own is tightened; a group/world-writable dir is never bindable */
    {
        char dp[160];
        snprintf(dp, sizeof dp, "%s/wide", tmpdir);
        CHECK(mkdir(dp, 0700) == 0);
        CHECK(chmod(dp, 0777) == 0);
        CHECK(qn_transport_prepare_dir(dp) == 0); /* ours: tightened */
        CHECK(stat(dp, &st) == 0 && (st.st_mode & 0777u) == 0700u);
        snprintf(dp, sizeof dp, "%s/fresh", tmpdir);
        CHECK(qn_transport_prepare_dir(dp) == 0); /* created 0700 */
        CHECK(stat(dp, &st) == 0 && (st.st_mode & 0777u) == 0700u);
        (void)rmdir(dp);
    }
    (void)unlink(junk);
    (void)unlink(path);
    (void)rmdir(tmpdir);
}

/* Two frames delivered in one read(): the first is parsed then memmove-
 * compacted out of t->buf, so any pointer into the pre-compaction buffer
 * would dangle. The engine reads f->payload after recv returns; a frame
 * that shares its segment with a successor must still hand back its own
 * bytes, not the successor's shifted up into its place. */
static void test_coalesced_frames(void)
{
    qn_transport_t t;
    int fd;
    uint8_t seg[2 * QN_MAX_FRAME];
    uint8_t a[10], b[4];
    size_t n, off = 0, i;
    qn_frame_t f;

    for (i = 0; i < sizeof a; i++) {
        a[i] = (uint8_t)(0x30 + i);
    }
    b[0] = 0xAA; b[1] = 0xBB; b[2] = 0xCC; b[3] = 0xDD;

    pair_init(&t, &fd, 1000);
    auth_in(fd);
    CHECK(qn_transport_poll(&t, 1000) == QN_TR_AUTHED);

    n = frame(seg, QN_T_HOST_READY, 2, a, (uint16_t)sizeof a);
    off += n;
    n = frame(seg + off, QN_T_PING, 3, b, (uint16_t)sizeof b);
    off += n;
    write_all(fd, seg, off);          /* both frames in one segment */

    CHECK(qn_transport_poll(&t, 1001) == QN_TR_NEED);
    CHECK(qn_transport_recv(&t, &f) == 1);
    CHECK(f.type == QN_T_HOST_READY && f.len == (uint16_t)sizeof a);
    for (i = 0; i < sizeof a; i++) {
        CHECK(f.payload[i] == a[i]);   /* survives the compaction */
    }
    CHECK(qn_transport_recv(&t, &f) == 1);
    CHECK(f.type == QN_T_PING && f.len == (uint16_t)sizeof b);
    for (i = 0; i < sizeof b; i++) {
        CHECK(f.payload[i] == b[i]);
    }
    close(fd);
    qn_transport_close(&t);
}

/* A frame header lying past the receive buffer is terminal pre-auth and
 * post-auth: never a fake 'peer closed', never a silent stall. */
static void test_frame_overflow(void)
{
    qn_transport_t t;
    int sv[2];
    uint8_t token[QN_AUTH_TOKEN_LEN];
    uint8_t hdr[QN_MAX_FRAME];
    static uint8_t junk[16384];
    size_t i, n;
    qn_frame_t f;

    for (i = 0; i < QN_AUTH_TOKEN_LEN; i++) token[i] = (uint8_t)(0xA0 + i);
    memset(junk, 0x5A, sizeof junk);

    /* pre-auth: the fill loop must not report 'peer closed' on a full
     * buffer, and the unparseable excess must be FAIL */
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) { CHECK(0); return; }
    fcntl(sv[0], F_SETFL, O_NONBLOCK);
    qn_transport_init(&t, sv[0], token, 1000);
    n = qn_frame_write(hdr, sizeof hdr, QN_T_PING, 2, NULL, 0);
    CHECK(n > 12);
    hdr[12] = 0xff; hdr[13] = 0xff; /* declared 65535 either endianness */
    CHECK(write(sv[1], hdr, n) == (ssize_t)n);
    CHECK(write(sv[1], junk, sizeof junk) == (ssize_t)sizeof junk);
    CHECK(qn_transport_poll(&t, 1000) == QN_TR_FAIL);
    CHECK(t.reason && strcmp(t.reason, "frame malformed") == 0);
    qn_transport_close(&t);
    close(sv[1]);

    /* post-auth: recv must terminate the transport, not wait forever */
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) { CHECK(0); return; }
    fcntl(sv[0], F_SETFL, O_NONBLOCK);
    qn_transport_init(&t, sv[0], token, 1000);
    n = qn_frame_write(hdr, sizeof hdr, QN_T_AUTH, 1, token, QN_AUTH_TOKEN_LEN);
    CHECK(n > 0);
    CHECK(write(sv[1], hdr, n) == (ssize_t)n);
    CHECK(qn_transport_poll(&t, 1001) == QN_TR_AUTHED);
    n = qn_frame_write(hdr, sizeof hdr, QN_T_PING, 2, NULL, 0);
    hdr[12] = 0xff; hdr[13] = 0xff;
    CHECK(write(sv[1], hdr, n) == (ssize_t)n);
    CHECK(write(sv[1], junk, sizeof junk) == (ssize_t)sizeof junk);
    CHECK(qn_transport_poll(&t, 1002) == QN_TR_NEED); /* fills the buffer */
    CHECK(qn_transport_recv(&t, &f) == -1);
    CHECK(t.reason && strcmp(t.reason, "frame malformed") == 0);
    qn_transport_close(&t);
    close(sv[1]);
}

int qn_test_transport(int *checks_out)
{
    qn_frame_init();
    test_auth_gate();
    test_post_auth();
    test_coalesced_frames();
    test_frame_overflow();
    test_sockets();
    *checks_out = checks;
    if (failures) {
        printf("QN transport tests FAILED: %d/%d\n", failures, checks);
        return 1;
    }
    return 0;
}
