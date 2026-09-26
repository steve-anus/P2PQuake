/* qn_scmd.h -- clc_stringcmd handshake-phrase allowlist predicate. Pure (no engine symbols) so the unit battery links the shipped
 * bytes while sv_user dispatches through the same predicate. */
#ifndef QN_SCMD_H
#define QN_SCMD_H

/* 1 iff the first token of `s` (space/tab/CR/LF/NUL terminated,
 * case-insensitive) is exactly one handshake phrase the Q1 client wire is
 * known to need: the engine's own signon switch (prespawn/name/color/
 * spawn/begin, cl_main.c) plus the chat family (Host_Say_f is built for
 * src_client origin; proven live -- the loopback fake peer asserts a
 * loopback-online echo). Admin-class verbs (kick/ban/give), cheat verbs
 * (god/notarget/fly/noclip/setpos) and host self-service
 * (kill/pause/status/ping) are rejected from the client wire
 * unconditionally. Exact-token matching also defeats the legacy
 * strncasecmp(n) prefix class ("spawner" passing as "spawn"). */
int QN_ScmdAllowed (const char *s);

#endif	/* QN_SCMD_H */
