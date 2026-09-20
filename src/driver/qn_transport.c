/* qn_transport.c — engine-side Plane A endpoint (spec §2, §4, §8).
 * See qn_transport.h for the contract. No clock reads, no allocations
 * after init, failure reasons are always fixed strings: raw bytes from a
 * remote side must never reach log or console output. */
#define _GNU_SOURCE
#include "qn_transport.h"

#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

/* Constant-time compare for the AUTH token: any early-exit optimisation
 * here would turn a secret into a timing oracle. volatile per-byte loads
 * defeat folding; the loop itself never branches on the secret. */
static int ct_equal32(const uint8_t *a, const uint8_t *b)
{
    volatile const uint8_t *x = a;
    volatile const uint8_t *y = b;
    unsigned diff = 0;
    for (unsigned i = 0; i < QN_AUTH_TOKEN_LEN; i++) {
        diff |= (unsigned)(x[i] ^ y[i]);
    }
    return diff == 0u;
}

int qn_transport_prepare_dir(const char *dir)
{
    struct stat st;
    if (mkdir(dir, 0700) != 0 && errno != EEXIST) {
        return -1;
    }
    if (lstat(dir, &st) != 0 || !S_ISDIR(st.st_mode)) {
        return -1;
    }
    if (st.st_uid != geteuid()) {
        return -1; /* never bind through a directory someone else owns */
    }
    if ((st.st_mode & 0777u) != 0700u) {
        /* Ours, and only tightening: 0700 removes bits, adds none. */
        if (chmod(dir, 0700) != 0) {
            return -1;
        }
        if (lstat(dir, &st) != 0 || (st.st_mode & 0777u) != 0700u) {
            return -1;
        }
    }
    return 0;
}

int qn_transport_listen(const char *path, const char **reason)
{
    char dirbuf[4096];
    const char *slash = strrchr(path, '/');
    size_t dlen;
    struct stat st;
    struct sockaddr_un sa;
    int fd;

    if (!slash || slash == path || strlen(path) >= sizeof sa.sun_path) {
        *reason = "bad path";
        return -1;
    }
    dlen = (size_t)(slash - path);
    if (dlen >= sizeof dirbuf) {
        *reason = "bad path";
        return -1;
    }
    memcpy(dirbuf, path, dlen);
    dirbuf[dlen] = '\0';
    if (qn_transport_prepare_dir(dirbuf) != 0) {
        *reason = "dir not private";
        return -1;
    }

    fd = (int)socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) {
        *reason = "socket failed";
        return -1;
    }

    if (lstat(path, &st) == 0) {
        /* Only a socket file we own may be replaced; an attacker-planted
         * name (regular file, foreign owner, symlink) is a refusal. */
        if (!S_ISSOCK(st.st_mode) || st.st_uid != geteuid()) {
            *reason = "foreign file";
            close(fd);
            return -1;
        }
        if (unlink(path) != 0) {
            *reason = "unlink failed";
            close(fd);
            return -1;
        }
    } else if (errno != ENOENT) {
        *reason = "stat failed";
        close(fd);
        return -1;
    }

    memset(&sa, 0, sizeof sa);
    sa.sun_family = AF_UNIX;
    memcpy(sa.sun_path, path, strlen(path) + 1u);
    if (fchmod(fd, 0600) != 0) { /* the pipe is ours alone: 0600 */
        *reason = "chmod failed";
        close(fd);
        return -1;
    }
    if (bind(fd, (struct sockaddr *)&sa,
             (socklen_t)(offsetof(struct sockaddr_un, sun_path) +
                         strlen(path) + 1u)) != 0) {
        *reason = "bind failed";
        close(fd);
        return -1;
    }
    if (listen(fd, 1) != 0) {
        *reason = "listen failed";
        close(fd);
        return -1;
    }
    *reason = NULL;
    return fd;
}

int qn_transport_accept(int listen_fd, const char **reason)
{
    struct ucred uc;
    socklen_t len = (socklen_t)sizeof uc;
    /* accept4 flags are an O_*-style mask: SOCK_CLOEXEC|SOCK_NONBLOCK only.
     * (SOCK_STREAM is 1, not 0 — passing it there is EINVAL.) */
    int fd = accept4(listen_fd, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK);
    if (fd < 0) {
        *reason = "accept failed";
        return -1;
    }
    /* The pipe belongs to this user alone: reject a peer we did not spawn
     * (uid equality covers everything short of root). */
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &uc, &len) != 0 ||
        len != (socklen_t)sizeof uc || uc.uid != getuid()) {
        close(fd);
        *reason = "peer uid mismatch";
        return -1;
    }
    *reason = NULL;
    return fd;
}

void qn_transport_init(qn_transport_t *t, int fd,
                       const uint8_t token[QN_AUTH_TOKEN_LEN],
                       uint64_t now_ms)
{
    memset(t, 0, sizeof *t);
    t->fd = fd;
    memcpy(t->token, token, QN_AUTH_TOKEN_LEN);
    t->deadline_ms = now_ms + (uint64_t)QN_AUTH_TIMEOUT_MS;
}

/* Parse and consume one complete frame at the buffer head.
 * 1 = frame in *f, 0 = need more bytes, -1 = terminal (reason set). */
static int head_frame(qn_transport_t *t, qn_frame_t *f)
{
    qn_parse_t r;
    if (t->n == 0u) {
        return 0;
    }
    r = qn_frame_parse(t->buf, t->n, f);
    if (r == QN_PARSE_BAD) {
        t->reason = "frame malformed";
        return -1;
    }
    if (r == QN_PARSE_NEED_MORE) {
        if (t->n == sizeof t->buf) {
            /* A complete frame can never fill the buffer, so a full buffer
             * that yields no frame is a lying length field: terminal. */
            t->reason = "frame malformed";
            return -1;
        }
        return 0;
    }
    memmove(t->buf, t->buf + f->consumed, t->n - f->consumed);
    t->n -= f->consumed;
    return 1;
}

qn_tr_t qn_transport_poll(qn_transport_t *t, uint64_t now_ms)
{
    qn_frame_t f;
    int k;

    if (t->fd < 0) {
        return QN_TR_CLOSED;
    }
    if (!t->authed && now_ms > t->deadline_ms) {
        t->reason = "auth timeout";
        return QN_TR_FAIL;
    }
    for (;;) {
        ssize_t r = read(t->fd, t->buf + t->n, sizeof t->buf - t->n);
        if (r > 0) {
            t->n += (size_t)r;
            continue;
        }
        if (r == 0) {
            t->reason = "peer closed";
            return QN_TR_CLOSED;
        }
        if (errno == EINTR) {
            continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            break;
        }
        t->reason = "read error";
        return QN_TR_FAIL;
    }
    if (t->authed) {
        return QN_TR_NEED;
    }
    k = head_frame(t, &f);
    if (k < 0) {
        return QN_TR_FAIL;
    }
    if (k == 0) {
        return QN_TR_NEED; /* no complete frame yet; deadline still guards */
    }
    if (f.type != QN_T_AUTH) {
        t->reason = "auth missing";
        return QN_TR_FAIL;
    }
    if (f.seq != 1u) {
        t->reason = "auth seq";
        return QN_TR_FAIL;
    }
    if (f.len != (uint16_t)QN_AUTH_TOKEN_LEN ||
        !ct_equal32(f.payload, t->token)) {
        t->reason = "auth token";
        return QN_TR_FAIL;
    }
    t->authed = 1;
    t->seq_in = 1u;
    return QN_TR_AUTHED;
}

int qn_transport_recv(qn_transport_t *t, qn_frame_t *out)
{
    int k;
    if (!t->authed || t->fd < 0) {
        return 0;
    }
    k = head_frame(t, out);
    if (k <= 0) {
        return k;
    }
    if (out->type == QN_T_AUTH) {
        t->reason = "auth replay"; /* §4.5: AUTH never passes twice */
        return -1;
    }
    if (!qn_seq_accept(&t->seq_in, out->seq)) {
        t->reason = "seq regression";
        return -1;
    }
    return 1;
}

int qn_transport_send(qn_transport_t *t, uint16_t type,
                      const uint8_t *payload, uint16_t len)
{
    uint8_t frame[QN_MAX_FRAME];
    size_t n, off = 0;

    if (t->fd < 0) {
        t->reason = "closed";
        return -1;
    }
    n = qn_frame_write(frame, sizeof frame, type, t->seq_out + 1u,
                       payload, len);
    if (n == 0u) {
        t->reason = "frame rejected"; /* our own input: caller bug, no send */
        return -1;
    }
    while (off < n) {
        ssize_t w = write(t->fd, frame + off, n - off);
        if (w < 0 && errno == EINTR) {
            continue;
        }
        if (w <= 0) {
            t->reason = "write error";
            return -1;
        }
        off += (size_t)w;
    }
    t->seq_out++;
    return 1;
}

void qn_transport_close(qn_transport_t *t)
{
    if (t->fd >= 0) {
        close(t->fd);
        t->fd = -1;
    }
}
