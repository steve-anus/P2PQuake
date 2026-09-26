/* qn_scmd.c -- handshake-phrase allowlist, derived from code not habit:
 * the proven client-wire consumers are the Q1 signon switch in
 * cl_main.c (prespawn / name / color / spawn / begin) and the chat family
 * (live: the loopback fake peer asserts its say echo). The shipped
 * LibreQuake progs.dat and qwprogs.dat register no client string commands
 * (string-table enumeration of gamedata/id1/pak0.pak, directory at end,
 * entries name[56]+pos+len). Everything else on the old sv_user prefix
 * chain was engine-host-only privilege reachable by anyone speaking the
 * Q1 client wire inside a room. */
#include <string.h>

#include "qn_scmd.h"

static const char *const qn_scmd_handshake[] = {
    "prespawn", "name", "color", "spawn", "begin",
    "say", "say_team", "tell"
};

#define QN_SCMD_NPHRASES \
    (sizeof (qn_scmd_handshake) / sizeof (qn_scmd_handshake[0]))

static int qn_scmd_is_term (char c)
{
    return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == 0;
}

static int qn_scmd_case_exact (const char *s, const char *word, int n)
{
    int i;
    for (i = 0; i < n; i++)
    {
        char a = s[i];
        if (a >= 'A' && a <= 'Z')
            a += (char) ('a' - 'A');
        if (a != word[i])
            return 0;
    }
    return qn_scmd_is_term (s[n]);
}

int QN_ScmdAllowed (const char *s)
{
    size_t n, j;

    if (!s)
        return 0;
    while (*s == ' ' || *s == '\t')
        s++;
    if (!*s)
        return 0;
    for (n = 0; !qn_scmd_is_term (s[n]); n++)
        ;
    for (j = 0; j < QN_SCMD_NPHRASES; j++)
    {
        const char *w = qn_scmd_handshake[j];
        size_t wl = strlen (w);
        if (n == wl && qn_scmd_case_exact (s, w, (int) n))
            return 1;
    }
    return 0;
}
