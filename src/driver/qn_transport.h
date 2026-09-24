/* qn_transport.h — the engine's Plane A endpoint (spec §2, §4).
 *
 * The engine owns the listening Unix-domain socket; qn-peer dials it and
 * authenticates with a one-shot token as the first frame. Every parse or
 * protocol failure is terminal for the connection (spec §8) — `reason` is
 * always a fixed string, never attacker bytes: remote content must never
 * reach log output, where it could forge lines.
 *
 * Time never enters this module: callers pass `now_ms` to poll(), which
 * keeps the 5 s auth deadline testable without sleeping. */
#ifndef QN_TRANSPORT_H
#define QN_TRANSPORT_H

#include <stddef.h>
#include <stdint.h>

#include "qn_frame.h"

#define QN_AUTH_TOKEN_LEN 32u   /* spec §4.1 */
#define QN_AUTH_TIMEOUT_MS 5000u /* spec §4.4 */

typedef enum {
    QN_TR_NEED   = 0,  /* keep waiting for bytes/time */
    QN_TR_AUTHED = 1,  /* AUTH passed (reported once) */
    QN_TR_FAIL   = -1, /* terminal: close, consult reason */
    QN_TR_CLOSED = -2  /* peer closed the socket */
} qn_tr_t;

typedef struct {
    int      fd;
    const char *reason; /* fixed string once terminal */
    uint8_t  token[QN_AUTH_TOKEN_LEN];
    int      authed;
    uint32_t seq_in;    /* last accepted peer→engine sequence */
    uint32_t seq_out;   /* last sent engine→peer sequence */
    uint64_t deadline_ms;
    uint8_t  buf[2 * QN_MAX_FRAME];
    /* Owned copy: qn_frame_t.payload borrows from buf and head_frame
     * compacts buf after parsing; callers read the payload after return,
     * so the frame must outlive its position in the stream buffer. */
    uint8_t  frame_payload[QN_MAX_PAYLOAD];
    size_t   n;
} qn_transport_t;

/* Prepare the socket's containing directory: create 0700 if absent; an
 * existing dir must be a real directory owned by us, normalised to exactly
 * 0700 (tightened if looser, never loosened). 0 = ok, -1 = refuse. */
int qn_transport_prepare_dir(const char *dir);

/* Bind + listen at `path` (socket file 0600). A pre-existing regular file
 * or a file owned by someone else is refused — only a socket file of ours
 * is ever unlinked. Returns the listen fd, or -1 with *reason set. */
int qn_transport_listen(const char *path, const char **reason);

/* accept + SO_PEERCRED uid equality (the pipe belongs to this user alone).
 * Returns the connected fd (set non-blocking), or -1 with *reason set. */
int qn_transport_accept(int listen_fd, const char **reason);

/* Adopt an accepted fd. Sets the fd non-blocking, arms the auth deadline. */
void qn_transport_init(qn_transport_t *t, int fd,
                       const uint8_t token[QN_AUTH_TOKEN_LEN],
                       uint64_t now_ms);

/* Drain input and drive the AUTH gate. Before auth: the first complete
 * frame must be AUTH at seq 1 carrying exactly the expected token, or the
 * deadline passes — either way terminal. After auth: just drains. */
qn_tr_t qn_transport_poll(qn_transport_t *t, uint64_t now_ms);

/* Next post-auth frame; 1 = *out filled, 0 = none waiting, -1 = terminal
 * (reason set; AUTH replays and sequence regressions close per §4/§2.2). */
int qn_transport_recv(qn_transport_t *t, qn_frame_t *out);

/* Write one engine→peer frame with the next send sequence. 1 = ok,
 * -1 = refused or broken pipe (reason set). */
int qn_transport_send(qn_transport_t *t, uint16_t type,
                      const uint8_t *payload, uint16_t len);

void qn_transport_close(qn_transport_t *t);

#endif /* QN_TRANSPORT_H */
