/* qn_causes.c -- fixed player-facing text for the daemon's FATAL cause
 * byte (spec 6.3). Pure data; strings derive from the spec's cause names.
 * The join-refuse classes (spec 6.2) need a Plane-A relay the spec does
 * not define yet and are NOT mapped here. */
#include "qn_causes.h"

static const char *const fatal_text[] = {
	"peer left",				/* 0 */
	"session key rejected",			/* 1 */
	"internal service error",			/* 2 */
	"local service closed the session",		/* 3 */
	"connection to host lost",		/* 4 */
	"host signature rejected",		/* 5 */
	"suspected interference; session reset",	/* 6 */
};

#define QN_FATAL_LAST 7u

const char *QN_CauseText (unsigned int cause)
{
	if (cause >= QN_FATAL_LAST)
		return "session ended unexpectedly";
	return fatal_text[cause];
}

int QN_CauseKnown (unsigned int cause)
{
	return cause < QN_FATAL_LAST;
}

/* spec 6.2 JOIN_NO: player-visible strings verbatim from the table */
static const char *const joinno_text[] = {
	"host refused the join",			/* 0 / unknown: never NULL */
	"update p2pquake",				/* 1 */
	"wrong or stale join code",			/* 2 */
	"match is full",					/* 3 */
	"match no longer accepting",		/* 4 */
	"already playing",				/* 5 */
	"slow down and retry",			/* 6 */
	"game files or engine build differ from the host", /* 7 */
};

#define QN_JOINNO_LAST 7u

const char *QN_JoinNoText (unsigned int cause)
{
	if (cause > QN_JOINNO_LAST)
		return joinno_text[0];
	return joinno_text[cause];
}

int QN_JoinNoKnown (unsigned int cause)
{
	return cause >= 1u && cause <= QN_JOINNO_LAST;
}
