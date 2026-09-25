/* qn_causes.h -- fixed strings for the daemon FATAL cause byte (spec 6.3),
 * shared by the engine console, qn_status and the Join page. Pure data:
 * every return is a static literal, never derived from network bytes. */
#ifndef QN_CAUSES_H
#define QN_CAUSES_H

const char *QN_CauseText (unsigned int cause);	/* never NULL */
int QN_CauseKnown (unsigned int cause);		/* 1 when cause has its own text */

const char *QN_JoinNoText (unsigned int cause);	/* spec 6.2, never NULL */
int QN_JoinNoKnown (unsigned int cause);

#endif
