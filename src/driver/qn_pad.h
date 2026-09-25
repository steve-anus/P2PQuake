/* qn_pad.h -- pure input sanitizer for menu code/name fields (qn_pad.c). */
#ifndef __qn_pad_h
#define __qn_pad_h

#include <stddef.h>

#define QN_PAD_CODE_LEN	16	/* spec 5.2: 80 bits, Crockford base32 */
#define QN_PAD_NAME_MAX	20	/* daemon contract: printable ASCII <=20 */
#define QN_PAD_MAX_SEPS	8	/* sane dash/space budget in a pasted code */

typedef struct
{
	char	code[QN_PAD_CODE_LEN + 1];
	int	n;
} qn_pad_t;

int  QN_PadCharOk (char c);
void QN_PadReset (qn_pad_t *pad);
int  QN_PadFeed (qn_pad_t *pad, char c);
int  QN_PadBack (qn_pad_t *pad);
int  QN_PadComplete (const qn_pad_t *pad);
/* complete-only; writes the 4-4-4-4 display form (spec 5.1) */
int  QN_PadGrouped (const qn_pad_t *pad, char *out, size_t outlen);
/* all-or-nothing paste accept; 0 = refuse whole */
int  QN_PadPaste (qn_pad_t *pad, const char *text);
int  QN_PadNameCharOk (char c);

#endif	/* __qn_pad_h */
