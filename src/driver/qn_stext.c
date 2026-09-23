/* qn_stext.c -- the spec 6.4 remote-console allowlist.
 *
 * Derivation (never guessed; re-derive and diff on any engine or gamedata
 * change):
 *   - The shipped engine's only remote-sourced STUFFTEXT writers are
 *     SV_SendReconnect (Quake/sv_main.c: MSG_WriteChar (svc_stufftext)
 *     + "reconnect\n") and the Host_ClientCommands builtin path
 *     (Quake/host.c, driven from Quake/pr_cmds.c stuffcmd).
 *   - The shipped gamedata progs (gamedata/id1/pak0.pak progs.dat, string
 *     table ) contain no console-command-shaped string,
 *     so the builtin path contributes nothing.
 *   - Chat is not in scope: SV_ClientPrintf delivers svc_print, not
 *     stufftext.
 * Anything added here must cite a shipping sender or a progs string. */
#include "qn_stext.h"

#include <string.h>

/* Exact phrases only: whole-line match, no argument positions. The
 * printable-ASCII rule below is what keeps continuation and control
 * trickery out before a name is ever consulted. */
static const char *const qn_stext_exact[] = {
	"reconnect",	/* SV_SendReconnect (see header) */
};

int QN_StextFrameOk (const char *payload, size_t len)
{
	size_t	i;

	if (len < 2 || len > QN_STEXT_MAXLINE + 1)
		return 0;
	if (payload[len - 1] != 0)
		return 0;
	for (i = 0; i + 1 < len; i++)
		if (payload[i] == 0)
			return 0;	/* embedded NUL: not one line */
	return 1;
}

int QN_StextAllowed (const char *line, size_t len)
{
	size_t	i;

	if (len == 0 || len > QN_STEXT_MAXLINE)
		return 0;
	while (len && (line[len - 1] == '\n' || line[len - 1] == '\r'))
		len--;
	if (len == 0)
		return 0;
	for (i = 0; i < len; i++)
		if ((unsigned char) line[i] < 0x20 || (unsigned char) line[i] > 0x7E)
			return 0;
	for (i = 0; i < sizeof (qn_stext_exact) / sizeof (qn_stext_exact[0]); i++)
		if (len == strlen (qn_stext_exact[i]) &&
		    !memcmp (line, qn_stext_exact[i], len))
			return 1;
	return 0;
}
