/* qn_causes.c -- player-facing text for the daemon's FATAL cause byte
 * (spec 6.3) and the JOIN_NO refusal causes (spec 6.2). Fixed literals,
 * except the build-mismatch line, which is composed only from build ids
 * that passed the build-id charset check. */
#include <stdio.h>
#include <string.h>

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

static int qn_id_ok (const char *id, size_t n)
{
	size_t	i;

	if (n < 1 || n > 64)
		return 0;
	for (i = 0; i < n; i++)
	{
		char	c = id[i];
		if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
		      (c >= '0' && c <= '9') || c == '.' || c == '_' ||
		      c == '+' || c == '-'))
			return 0;
	}
	return 1;
}

static int qn_hex16 (const char *s, size_t n)
{
	size_t	i;

	if (n < 16)
		return 0;
	for (i = 0; i < 16; i++)
		if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f')))
			return 0;
	return 1;
}

/* "<version>p<16 hex>[suffix]": length of the version part and offset of
 * the digest, or the whole id as version and no digest */
static void qn_id_split (const char *id, size_t n, size_t *vlen, size_t *dig)
{
	size_t	i;

	*vlen = n;
	*dig = n;
	for (i = n; i-- > 0; )
		if (id[i] == 'p' && qn_hex16 (id + i + 1, n - i - 1))
		{
			*vlen = i;
			*dig = i + 1;
			return;
		}
}

const char *QN_MismatchText (const char *host_id, size_t host_len,
                             const char *own_id, char *buf, size_t n)
{
	size_t	own_len = own_id ? strlen (own_id) : 0;
	size_t	hv, hd, ov, od;

	if (!buf || n == 0 || !host_id || !qn_id_ok (host_id, host_len) ||
	    !qn_id_ok (own_id, own_len))
		return NULL;
	if (host_len == own_len && !memcmp (host_id, own_id, own_len))
	{
		snprintf (buf, n, "game files differ from the host");
		return buf;
	}
	qn_id_split (host_id, host_len, &hv, &hd);
	qn_id_split (own_id, own_len, &ov, &od);
	if (hv != ov || memcmp (host_id, own_id, hv))
		snprintf (buf, n, "host has %.*s, you have %.*s",
		          (int) (hv > 16 ? 16 : hv), host_id,
		          (int) (ov > 16 ? 16 : ov), own_id);
	else
		snprintf (buf, n, "same version, different build: host %.8s, you %.8s",
		          host_id + (hd < host_len ? hd : 0),
		          own_id + (od < own_len ? od : 0));
	return buf;
}
