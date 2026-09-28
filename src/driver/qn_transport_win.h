/* qn_transport_win.h — Windows twin of the Plane A OS seam (named pipes).
 * The int-fd contract of qn_transport.h is preserved through a small
 * handle table, so the framing/auth state machine and all callers are
 * platform-neutral. Credential model: DACL pins the pipe to the current
 * user (+ LocalSystem), the accept gate matches the connecting process
 * image against the expected daemon path, and the AUTH token remains the
 * real gate (weaker kernel guarantee than SO_PEERCRED-uid; stated in the
 * Windows port notes). */
#ifndef QN_TRANSPORT_WIN_H
#define QN_TRANSPORT_WIN_H

#ifdef _WIN32

#include <stddef.h>
#include <stdint.h>

/* Arm the accept credential gate with the absolute image path of the
 * daemon process expected to connect (packaged runtime\node.exe).
 * Unarmed = every accept is refused (fail-closed). */
void qnw_expect_peer(const char *abs_image);

/* 1 if a live listener answers pipe_name right now (open succeeds while
 * an instance waits); 0 otherwise. */
int qnw_pipe_live(const char *pipe_name);

/* Create the listener (byte mode, reject-remote, private DACL, one
 * session at a time). Returns the table id or -1 with *reason. */
int qnw_pipe_listen(const char *pipe_name, const char **reason);

/* 1 = a client handshake completed and is ready to adopt, 0 = none yet,
 * -1 = listener dead. */
int qnw_pipe_can_accept(int listener, const char **reason);

/* Adopt the pending client: applies the credential gate; on mismatch or
 * missing expected image the client is disconnected and -1 returned.
 * Returns the connection table id (a distinct id sharing the listener's
 * handle: closing it disconnects, it never destroys the listener). */
int qnw_pipe_accept(int listener, const char **reason);

/* Pump-loop primitives. qnw_read: >0 bytes moved, 0 = nothing waiting
 * (*eof set on peer disconnect), -1 = terminal error. qnw_write: >0
 * bytes, -1 = terminal. qnw_close: connection id disconnects (listener
 * survives); listener id closes the handle. */
int qnw_read(int id, uint8_t *buf, size_t space, int *eof,
             const char **reason);
int qnw_write(int id, const uint8_t *buf, size_t n, const char **reason);
void qnw_close(int id);

/* Windows twin of qn_transport_prepare_dir: dir must exist as a real
 * directory or be creatable; 0 = ok, -1 = refuse. */
int qnw_prepare_dir(const char *dir);

#endif /* _WIN32 */
#endif /* QN_TRANSPORT_WIN_H */
