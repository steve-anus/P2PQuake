/* qn_pad.c -- menu field sanitizer: code = 16 Crockford chars, name =
 * printable ASCII (wire contract <=20; the editor caps at 15).
 * Every write site clamps. */

#include <string.h>

#include "qn_pad.h"

static size_t qn_pad_strlcpy (char *dst, const char *src, size_t dstsize)
{
	size_t	n = strlen (src);

	if (n + 1 > dstsize)
	{
		if (dstsize)
		{
			memcpy (dst, src, dstsize - 1);
			dst[dstsize - 1] = '\0';
		}
		return n;
	}
	memcpy (dst, src, n + 1);
	return n;
}

/* spec 5.2 display form: Crockford base32, no I L O U */
static const char qn_pad_alphabet[] = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

static int qn_pad_code_value (char c)
{
	int i;

	if (c >= 'a' && c <= 'z')
		c -= ('a' - 'A');
	for (i = 0; qn_pad_alphabet[i]; i++)
	{
		if (qn_pad_alphabet[i] == c)
			return i;
	}
	return -1;
}

int QN_PadCharOk (char c)
{
	return qn_pad_code_value (c) >= 0;
}

void QN_PadReset (qn_pad_t *pad)
{
	memset (pad->code, 0, sizeof (pad->code));	/* scrub, not just terminate */
	pad->n = 0;
}

int QN_PadFeed (qn_pad_t *pad, char c)
{
	int	v;

	if (pad->n >= QN_PAD_CODE_LEN)
		return 0;				/* full: reject before any write */
	v = qn_pad_code_value (c);
	if (v < 0)
		return 0;
	pad->code[pad->n] = qn_pad_alphabet[v];
	pad->n++;
	pad->code[pad->n] = '\0';
	return 1;
}

int QN_PadBack (qn_pad_t *pad)
{
	if (pad->n == 0)
		return 0;
	pad->n--;
	pad->code[pad->n] = '\0';
	return 1;
}

int QN_PadComplete (const qn_pad_t *pad)
{
	return pad->n == QN_PAD_CODE_LEN;
}

int QN_PadGrouped (const qn_pad_t *pad, char *out, size_t outlen)
{
	char	grouped[19 + 1];
	int	g, c = 0;

	if (!QN_PadComplete (pad))
		return 0;
	for (g = 0; g < 4; g++)
	{
		if (g)
			grouped[c++] = '-';
		memcpy (grouped + c, pad->code + g * 4, 4);
		c += 4;
	}
	grouped[c] = '\0';
	return qn_pad_strlcpy (out, grouped, outlen) < outlen ? 1 : 0;
}

/* all-or-nothing: refuse the whole paste on any mismatch */
int QN_PadPaste (qn_pad_t *pad, const char *text)
{
	qn_pad_t	fresh;
	int	seps = 0;

	if (!text)
		return 0;
	QN_PadReset (&fresh);
	for (; *text; text++)
	{
		char c = *text;
		if (c == '-' || c == ' ' || c == '\t' || c == '\r' || c == '\n')
		{
			seps++;
			if (seps > QN_PAD_MAX_SEPS)
				return 0;
			continue;
		}
		if (!QN_PadFeed (&fresh, c))
			return 0;			/* non-code char or overflow: reject */
	}
	if (!QN_PadComplete (&fresh))
		return 0;
	*pad = fresh;
	return 1;
}

/* name charset: printable ASCII, minus quote/backslash/hash */
int QN_PadNameCharOk (char c)
{
	if ((unsigned char) c < 0x20 || (unsigned char) c > 0x7E)
		return 0;
	if (c == '"' || c == '\\' || c == '#')
		return 0;
	return 1;
}
