/* test_scmd.c -- clc_stringcmd handshake-phrase allowlist units. */
#include <stdio.h>
#include <string.h>

#include "../src/driver/qn_scmd.h"

static int checks;
static int failures;

#define WANT(s, expect)                                                   \
    do {                                                                 \
        checks++;                                                        \
        if ((QN_ScmdAllowed (s) != 0) != (expect))                        \
        {                                                                \
            failures++;                                                  \
            printf ("FAIL %s:%d QN_ScmdAllowed(\"%s\") want %d\n",       \
                    __FILE__, __LINE__, (s) ? (s) : "(null)", (expect)); \
        }                                                                \
    } while (0)

/* array form: no null-ternary (an array's address always tests true) */
#define REJECT(s)                                                       \
    do {                                                                 \
        checks++;                                                        \
        if (QN_ScmdAllowed (s) != 0)                                     \
        {                                                                \
            failures++;                                                  \
            printf ("FAIL %s:%d long token accepted\n",                  \
                    __FILE__, __LINE__);                                 \
        }                                                                \
    } while (0)

int qn_test_scmd (int *checks_out);

int qn_test_scmd (int *checks_out)
{
    checks = 0;
    failures = 0;

    /* the exact handshake phrases as cl_main.c sends them */
    WANT("prespawn", 1);
    WANT("name \"QnBob\"\n", 1);
    WANT("color 2 5\n", 1);
    WANT("spawn dm_start anything", 1);
    WANT("begin", 1);
    WANT(" begin\n", 1);
    WANT("NAME q", 1);
    WANT("BeGiN", 1);

    /* admin/cheat/self-service/chat classes inert from the wire */
    WANT("kick 1", 0);
    WANT("kickall", 0);
    WANT("ban 1.2.3.4", 0);
    WANT("give all", 0);
    WANT("god", 0);
    WANT("notarget", 0);
    WANT("fly", 0);
    WANT("noclip", 0);
    WANT("setpos 0 0 0", 0);
    WANT("kill", 0);
    WANT("pause", 0);
    WANT("status", 0);
    WANT("ping", 0);

    /* chat family: live wire feature (fake peer asserts its say echo) */
    WANT("say hello", 1);
    WANT("say_team hi", 1);
    WANT("tell 1 hi", 1);
    WANT("sayx", 0);
    WANT("say_twotoken", 0);
    WANT("telly", 0);

    /* legacy strncasecmp(n) prefix class: longer word, same head */
    WANT("spawner", 0);
    WANT("namestealer", 0);
    WANT("beginner", 0);
    WANT("colorful", 0);
    WANT("prespawned", 0);

    /* boundary asymmetry vs the Cmd tokenizer (deliberate: only these
     * four bytes + NUL terminate a head token) */
    WANT("\tbegin", 1);
    WANT("say\tgod", 1);
    WANT("\rsay hi", 0);
    WANT("\ngod", 0);
    WANT("\x0Bspawn x", 0);
    WANT("spaw", 0);
    WANT("begi", 0);
    WANT("SAY_TEAM hi", 1);
    /* non-ASCII never folds (ASCII-only discipline both layers) */
    WANT("s\xd0\xb0y hi", 0);
    /* MSG_ReadString caps tokens at 2047 chars */
    {
        char big[2100];
        memset (big, 'k', 2047);
        big[2047] = 0;
        REJECT(big);
        memset (big, 'b', 2047);
        big[2047] = 0;
        REJECT(big);
    }

    WANT("", 0);
    WANT(" ", 0);
    WANT("\n", 0);
    WANT(NULL, 0);

    if (checks_out)
        *checks_out = checks;
    return failures;
}
