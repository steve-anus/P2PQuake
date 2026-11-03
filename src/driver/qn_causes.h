/* qn_causes.h -- fixed strings for the daemon FATAL cause byte (spec 6.3),
 * shared by the engine console, qn_status and the Join page. Every return
 * is a static literal except QN_MismatchText, which composes its line only
 * from charset-checked build ids. */
#ifndef QN_CAUSES_H
#define QN_CAUSES_H

#include <stddef.h>

const char *QN_CauseText (unsigned int cause);	/* never NULL */
int QN_CauseKnown (unsigned int cause);		/* 1 when cause has its own text */

const char *QN_JoinNoText (unsigned int cause);	/* spec 6.2, never NULL */
int QN_JoinNoKnown (unsigned int cause);
/* JOIN_NO cause 7 with the host's build id: which side differs, as one line
 * in buf (host id is remote bytes, checked against the build-id charset
 * first). NULL when either id fails that check. */
const char *QN_MismatchText (const char *host_id, size_t host_len,
                             const char *own_id, char *buf, size_t n);

#endif
