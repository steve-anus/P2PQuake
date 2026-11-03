/* test_causes.c -- the engine's honest-failure contract: every daemon FATAL
 * cause (spec 6.3) maps to one fixed literal, unknown causes never invent
 * text, and the pointers are stable literals (the note machinery dedups on
 * identity). Exact strings are pinned here and asserted by the
 * loopback-fatal battery lane. */
#include <stdio.h>
#include <string.h>

#include "../src/driver/qn_causes.h"

static int failures;
static int checks;

#define CHECK(cond) do { checks++; if (!(cond)) { \
	fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
	failures++; } } while (0)

static void expect_text(unsigned int cause, const char *want)
{
	const char *got = QN_CauseText(cause);

	CHECK(got != NULL);
	CHECK(got == QN_CauseText(cause));	/* stable literal */
	CHECK(strcmp(got, want) == 0);
}

int qn_test_causes(int *checks_out);
int qn_test_causes(int *checks_out)
{
	const char *generic = QN_CauseText(99);
	int i;

	expect_text(0, "peer left");
	expect_text(1, "session key rejected");
	expect_text(2, "internal service error");
	expect_text(3, "local service closed the session");
	expect_text(4, "connection to host lost");
	expect_text(5, "host signature rejected");
	expect_text(6, "suspected interference; session reset");
	expect_text(7, "session ended unexpectedly");

	{
		const char *g2 = QN_JoinNoText(0);
		CHECK(QN_JoinNoText(8) == g2);
		CHECK(QN_JoinNoText(4294967295u) == g2);
		CHECK(strcmp(g2, "host refused the join") == 0);
		CHECK(QN_JoinNoText(1) == QN_JoinNoText(1));
		CHECK(strcmp(QN_JoinNoText(1), "update p2pquake") == 0);
		CHECK(strcmp(QN_JoinNoText(2), "wrong or stale join code") == 0);
		CHECK(strcmp(QN_JoinNoText(3), "match is full") == 0);
		CHECK(strcmp(QN_JoinNoText(4), "match no longer accepting") == 0);
		CHECK(strcmp(QN_JoinNoText(5), "already playing") == 0);
		CHECK(strcmp(QN_JoinNoText(6), "slow down and retry") == 0);
		CHECK(strcmp(QN_JoinNoText(7),
			"game files or engine build differ from the host") == 0);
		CHECK(QN_JoinNoKnown(1) && QN_JoinNoKnown(7));
		CHECK(!QN_JoinNoKnown(0) && !QN_JoinNoKnown(8));
	}

	{
		char buf[80];
		const char *own = "0.15.0p0123456789abcdef";
		const char *t;

		t = QN_MismatchText("0.15.1p0123456789abcdef", 23, own, buf, sizeof buf);
		CHECK(t == buf && strcmp(t, "host has 0.15.1, you have 0.15.0") == 0);
		t = QN_MismatchText("0.15.0pfedcba9876543210", 23, own, buf, sizeof buf);
		CHECK(t && strcmp(t, "same version, different build: host fedcba98, you 01234567") == 0);
		t = QN_MismatchText(own, strlen(own), own, buf, sizeof buf);
		CHECK(t && strcmp(t, "game files differ from the host") == 0);
		t = QN_MismatchText("0.14.0pa0a20ff2643d4523-dirty", 29, own, buf, sizeof buf);
		CHECK(t && strcmp(t, "host has 0.14.0, you have 0.15.0") == 0);
		t = QN_MismatchText("legacy-build", 12, own, buf, sizeof buf);
		CHECK(t && strcmp(t, "host has legacy-build, you have 0.15.0") == 0);
		/* remote bytes outside the build-id charset never reach the text */
		CHECK(QN_MismatchText("0.15.1\n say hi", 15, own, buf, sizeof buf) == NULL);
		CHECK(QN_MismatchText("0.15.1 x", 8, own, buf, sizeof buf) == NULL);
		CHECK(QN_MismatchText("", 0, own, buf, sizeof buf) == NULL);
		CHECK(QN_MismatchText("0.15.1p0123456789abcdef", 65, own, buf, sizeof buf) == NULL);
		CHECK(QN_MismatchText("0.15.1p0123456789abcdef", 23, "bad id!", buf, sizeof buf) == NULL);
		/* a short buffer truncates, never overflows */
		{
			char small[8];
			t = QN_MismatchText("0.15.1p0123456789abcdef", 23, own, small, sizeof small);
			CHECK(t == small && strlen(small) == 7);
		}
	}

	for (i = 7; i < 4103; i++)			/* anything past the table */
		CHECK(QN_CauseText((unsigned int)i) == generic);
	CHECK(QN_CauseText(4294967295u) == generic);

	for (i = 0; i <= 6; i++)
		CHECK(QN_CauseKnown((unsigned int)i));
	CHECK(!QN_CauseKnown(7));
	CHECK(!QN_CauseKnown(255));

	/* distinct classes must never collapse onto one another */
	for (i = 0; i <= 6; i++) {
		int j;
		for (j = i + 1; j <= 6; j++)
			CHECK(QN_CauseText((unsigned int)i) != QN_CauseText((unsigned int)j));
	}

	*checks_out = checks;
	return failures ? 1 : 0;
}
