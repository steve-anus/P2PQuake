/* qn_stext.h -- spec 6.4 engine-side STUFFTEXT allowlist predicate.
 * Pure (no engine symbols) so the unit battery links the shipped bytes
 * while the engine dispatches through the same predicate. */
#ifndef QN_STEXT_H
#define QN_STEXT_H

#include <stddef.h>

#define QN_STEXT_MAXLINE 512	/* spec 2 table: 0x0050 printable line cap */

/* 1 iff `line` (len bytes, NUL not required) is exactly one allowlisted
 * remote console phrase, 0 to drop it. Trailing CR/LF are trimmed before
 * matching (the engine's own senders append '\n'). Every retained byte
 * must be printable ASCII (0x20..0x7E): no embedded NUL or newline, no
 * control, high-bit or DEL characters. */
int QN_StextAllowed (const char *line, size_t len);

/* Plane A 0x0050 frame shape (spec 2 table): at most QN_STEXT_MAXLINE
 * printable chars plus a terminating NUL, no embedded NUL. Size/NUL
 * placement only — printability is the predicate's job. 1 = shape ok. */
int QN_StextFrameOk (const char *payload, size_t len);

#endif	/* QN_STEXT_H */
