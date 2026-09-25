/* test_pad.c — the menu input sanitizer: every accept/reject decision and
 * the caps the join-code and name buffers live under. */
#include <stdio.h>
#include <string.h>

#include "../src/driver/qn_pad.h"

static int failures;
static int checks;

#define CHECK(cond) do { checks++; if (!(cond)) { \
	fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
	failures++; } } while (0)

static void feed_all(qn_pad_t *p, const char *s)
{
	for (; *s; s++)
		QN_PadFeed(p, *s);
}

static void test_alphabet(void)
{
	CHECK(QN_PadCharOk('0') && QN_PadCharOk('9'));
	CHECK(QN_PadCharOk('A') && QN_PadCharOk('Z'));
	/* Crockford: no I L O U */
	CHECK(!QN_PadCharOk('I') && !QN_PadCharOk('i'));
	CHECK(!QN_PadCharOk('L') && !QN_PadCharOk('l'));
	CHECK(!QN_PadCharOk('O') && !QN_PadCharOk('o'));
	CHECK(!QN_PadCharOk('U') && !QN_PadCharOk('u'));
	/* command/shell/secret-adjacent characters never type into the pad */
	CHECK(!QN_PadCharOk(';') && !QN_PadCharOk('#') && !QN_PadCharOk('%'));
	CHECK(!QN_PadCharOk('"') && !QN_PadCharOk('\\') && !QN_PadCharOk('/'));
	CHECK(!QN_PadCharOk(' ') && !QN_PadCharOk('-'));
	CHECK(!QN_PadCharOk(0x7f));
	CHECK(!QN_PadCharOk((char)0xa0));
	/* V is code data (only I L O U are excluded); the paste trigger key
	 * must be one of the excluded letters so it can never collide */
	CHECK(QN_PadCharOk('V') && QN_PadCharOk('v'));
	CHECK(!QN_PadCharOk('L') && !QN_PadCharOk('l'));
}

static void test_feed_caps(void)
{
	qn_pad_t p;
	int i, accepted = 0;
	static const char junk[] = "0a1B2;3-4/5 6%789ABCDEF\"\\";

	QN_PadReset(&p);
	/* 100 hostile keystrokes in one go: lowercase normalizes, rejects
	 * never write, and the cap holds forever */
	for (i = 0; i < 100; i++)
		if (QN_PadFeed(&p, junk[i % (sizeof(junk) - 1)]))
			accepted++;
	CHECK(p.n == QN_PAD_CODE_LEN);
	CHECK(strlen(p.code) == QN_PAD_CODE_LEN);
	CHECK(accepted == QN_PAD_CODE_LEN);
	for (i = 0; i < QN_PAD_CODE_LEN; i++)
		CHECK(QN_PadCharOk(p.code[i]));
	/* every feed past full is refused, never shifts content */
	for (i = 0; i < 50; i++)
		CHECK(QN_PadFeed(&p, 'A') == 0);
	CHECK(p.n == QN_PAD_CODE_LEN);
	QN_PadReset(&p);
	feed_all(&p, "0123456789ABCDEF");
	CHECK(QN_PadComplete(&p));
	CHECK(strcmp(p.code, "0123456789ABCDEF") == 0);
}

static void test_back_clear(void)
{
	qn_pad_t p;
	int i;

	QN_PadReset(&p);
	CHECK(QN_PadBack(&p) == 0);	/* empty: nothing to delete */
	feed_all(&p, "0123456789ABC");
	CHECK(QN_PadBack(&p) == 1);
	CHECK(p.n == 12);
	CHECK(strlen(p.code) == 12);
	CHECK(QN_PadComplete(&p) == 0);
	/* reset scrubs every byte, not just the terminator */
	feed_all(&p, "0123456789ABCDEF");
	QN_PadReset(&p);
	CHECK(p.n == 0);
	for (i = 0; i < (int)sizeof(p.code); i++)
		CHECK(p.code[i] == 0);
}

static void test_grouped(void)
{
	qn_pad_t p;
	char out[32];

	QN_PadReset(&p);
	feed_all(&p, "0123456789ABCDEFGH");
	CHECK(QN_PadGrouped(&p, out, sizeof(out)) == 1);
	CHECK(strcmp(out, "0123-4567-89AB-CDEF") == 0);
	/* a too-small output buffer is a refusal, never a truncation */
	CHECK(QN_PadGrouped(&p, out, 19) == 0);
	/* zero room writes nothing at all */
	out[0] = 'X';
	CHECK(QN_PadGrouped(&p, out, 0) == 0);
	CHECK(out[0] == 'X');
	/* incomplete never groups */
	QN_PadReset(&p);
	feed_all(&p, "0123456789ABCDE");
	CHECK(QN_PadGrouped(&p, out, sizeof(out)) == 0);
}

static void test_paste(void)
{
	qn_pad_t p;
	char big[512];
	int i;

	/* exact grouped form */
	QN_PadReset(&p);
	CHECK(QN_PadPaste(&p, "0123-4567-89AB-CDEF") == 1);
	CHECK(QN_PadComplete(&p));
	CHECK(strcmp(p.code, "0123456789ABCDEF") == 0);
	/* lowercase + spaces + tabs + CR/LF */
	QN_PadReset(&p);
	CHECK(QN_PadPaste(&p, "0123 4567\t89ab\rcdef\n") == 1);
	CHECK(QN_PadComplete(&p));
	/* one hostile byte rejects the whole thing... */
	QN_PadReset(&p);
	feed_all(&p, "0123456789ABC0E");	/* known 15-char prefix */
	CHECK(QN_PadPaste(&p, "0123;4567-89AB-CDEF") == 0);
	/* ...and the previous buffer survives untouched */
	CHECK(p.n == 15);
	CHECK(strcmp(p.code, "0123456789ABC0E") == 0);
	/* excluded letters are hostile bytes: 'I' is not in the alphabet */
	QN_PadReset(&p);
	CHECK(QN_PadPaste(&p, "0123456789ABCI0E") == 0);
	/* wrong lengths refuse */
	CHECK(QN_PadPaste(&p, "") == 0);
	CHECK(QN_PadPaste(&p, "0123456789ABCDE") == 0);
	CHECK(QN_PadPaste(&p, "0123456789ABCDEFG") == 0);
	/* separator budget: a wall of dashes cannot smuggle volume */
	for (i = 0; i < (int)sizeof(big) - 1; i++)
		big[i] = '-';
	big[sizeof(big) - 1] = '\0';
	CHECK(QN_PadPaste(&p, big) == 0);
	/* null text refuses */
	CHECK(QN_PadPaste(&p, NULL) == 0);
}

static void test_name_filter(void)
{
	CHECK(QN_PadNameCharOk('a') && QN_PadNameCharOk('Z') &&
	      QN_PadNameCharOk('9'));
	CHECK(QN_PadNameCharOk(' '));
	CHECK(QN_PadNameCharOk('%'));	/* inert data; render sites neutralize */
	CHECK(!QN_PadNameCharOk('"'));
	CHECK(!QN_PadNameCharOk('\\'));
	CHECK(!QN_PadNameCharOk('#'));
	CHECK(!QN_PadNameCharOk('\n'));
	CHECK(!QN_PadNameCharOk('\t'));
	CHECK(!QN_PadNameCharOk(0x7f));
	CHECK(!QN_PadNameCharOk((char)0x80));
}

int qn_test_pad(int *checks_out)
{
	failures = 0;
	checks = 0;
	test_alphabet();
	test_feed_caps();
	test_back_clear();
	test_grouped();
	test_paste();
	test_name_filter();
	*checks_out = checks;
	return failures;
}
