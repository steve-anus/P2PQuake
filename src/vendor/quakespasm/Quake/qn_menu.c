/*
 * qn_menu.c -- the p2pquake hosting page (Multiplayer menu -> Host p2pquake).
 * Starts and stops a listen-gated private room from the menu alone: no
 * engine flags, no typed commands. All strings that reach the command
 * buffer from this file are fixed texts or integers; map names are drawn
 * from a locally filtered list (pak filenames, validated at build time
 * and again at use); nothing user-typed is ever interpolated into command
 * text (join codes and names, when those pages land, set state through
 * direct calls for the same reason).
 */

#include "q_stdinc.h"
#include "arch_def.h"
#include "net_sys.h"
#include "quakedef.h"
#include "draw.h"
#include "menu.h"
#include <SDL.h>		/* clipboard for the paste key only */

#include "net_qn.h"
#include "qn_menu.h"
#include "qn_pad.h"
#include "qn_maps.h"

extern void IN_Activate (void);
extern qboolean m_return_onerror;
extern char m_return_reason[32];

#define QN_HOST_MAX_MAPS	64
#define QN_HOST_MAPNAME_LEN	16

extern void M_Print (int cx, int cy, const char *str);
extern void M_PrintWhite (int cx, int cy, const char *str);
extern void M_DrawTextBox (int x, int y, int width, int lines);
extern void M_DrawCharacter (int cx, int line, int num);
extern void M_Menu_MultiPlayer_f (void);

enum
{
	QN_H_ITEM_MODE,
	QN_H_ITEM_MAP,
	QN_H_ITEM_PLAYERS,
	QN_H_ITEM_ACTION,
	QN_H_ITEM_ADVANCE,
	QN_H_ITEM_BACK,
	QN_H_NUM_ITEMS
};

static int		qn_host_cursor;
static int		qn_host_mode;		/* 0 = deathmatch, 1 = co-op */
static int		qn_host_players = 2;	/* counts the host itself */
static int		qn_host_map;
static int		qn_host_mapcount;
static char		qn_host_maps[QN_HOST_MAX_MAPS][QN_HOST_MAPNAME_LEN];
static const char	*qn_host_note;
static double		qn_host_note_time;

static qboolean QN_HostNameOk (const char *s)
{
	int	i, n = 0;

	if (!s || !s[0])
		return false;
	for (i = 0; s[i]; i++)
	{
		char c = s[i];
		if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
		      (c >= '0' && c <= '9') || c == '_'))
			return false;
		n++;
	}
	return n < QN_HOST_MAPNAME_LEN;
}

static int qn_cmp_story (const void *a, const void *b)
{
	return QN_MapCompareStory ((const char *) a, (const char *) b);
}

static int qn_cmp_dm (const void *a, const void *b)
{
	return QN_MapCompareDm ((const char *) a, (const char *) b);
}

static void QN_HostBuildMaps (void)
{
	const filelist_item_t	*it;
	int	i;

	qn_host_mapcount = 0;
	for (it = extralevels; it; it = it->next)
	{
		if (qn_host_mapcount >= QN_HOST_MAX_MAPS)
			break;
		if (!QN_HostNameOk (it->name))
			continue;
		if (!QN_MapInPool (it->name,
		                   qn_host_mode ? QN_POOL_COOP : QN_POOL_DM))
			continue;
		for (i = 0; i < qn_host_mapcount; i++)
			if (!q_strcasecmp (qn_host_maps[i], it->name))
				break;
		if (i < qn_host_mapcount)
			continue;
		q_strlcpy (qn_host_maps[qn_host_mapcount], it->name,
		           QN_HOST_MAPNAME_LEN);
		qn_host_mapcount++;
	}
	if (qn_host_mapcount > 1)
		qsort (qn_host_maps, (size_t) qn_host_mapcount,
		       sizeof (qn_host_maps[0]),
		       qn_host_mode ? qn_cmp_story : qn_cmp_dm);
	if (qn_host_map >= qn_host_mapcount || qn_host_map < 0)
		qn_host_map = 0;
}

void QN_Menu_HostInit (void)
{
	qn_host_cursor = 0;
	QN_HostBuildMaps ();
	qn_host_note = NULL;
}

static void QN_HostNote (const char *fixed)
{
	qn_host_note = fixed;
	qn_host_note_time = realtime;
}

static void QN_HostChange (int dir)
{
	if (sv.active)
	{
		QN_HostNote ("stop hosting to change settings");
		return;
	}
	switch (qn_host_cursor)
	{
	case QN_H_ITEM_MODE:
		qn_host_mode = !qn_host_mode;
		QN_HostBuildMaps ();	/* re-filter; clamps the map cursor */
		qn_host_players = QN_PlayerBounds (
		    qn_host_mode ? QN_POOL_COOP : QN_POOL_DM,
		    qn_host_players, svs.maxclientslimit);
		break;
	case QN_H_ITEM_MAP:
		if (!qn_host_mapcount)
			QN_HostNote ("no playable maps found in gamedata");
		else
		{
			qn_host_map += dir;
			if (qn_host_map < 0)
				qn_host_map = qn_host_mapcount - 1;
			if (qn_host_map >= qn_host_mapcount)
				qn_host_map = 0;
		}
		break;
	case QN_H_ITEM_PLAYERS:
	{
		qn_map_pool_t pool = qn_host_mode ? QN_POOL_COOP : QN_POOL_DM;
		int lo = QN_PlayersLo (pool);
		int hi = QN_PlayersHi (pool, svs.maxclientslimit);
		int want = qn_host_players + dir;

		if (want > hi)
			want = lo;
		else if (want < lo)
			want = hi;
		qn_host_players = QN_PlayerBounds (pool, want, svs.maxclientslimit);
		break;
	}
	default:
		break;
	}
}

static void QN_HostStart (void)
{
	char	cmd[32];

	if (sv.active)
		return;
	QN_HostBuildMaps ();	/* the pak/game dir may have moved under us */
	if (!qn_host_mapcount || qn_host_map >= qn_host_mapcount)
	{
		QN_HostNote ("no playable maps found in gamedata");
		return;
	}
	if (!QN_MapInPool (qn_host_maps[qn_host_map],
	                   qn_host_mode ? QN_POOL_COOP : QN_POOL_DM))
	{
		QN_HostNote ("map not available for this game type");
		return;
	}
	/* Fixed command texts only, one queued sequence: listen down, the
	 * engine's own maxplayers path (allocation floor is raised to the
	 * engine ceiling at host init), then the mode cvars queued LAST so
	 * the deathmatch flip inside MaxPlayers_f always loses to them -
	 * the same ordering the LAN GameOptions flow relies on. */
	Cbuf_AddText ("listen 0\n");
	if (q_snprintf (cmd, sizeof (cmd), "maxplayers %d\n",
	                qn_host_players) >= (int) sizeof (cmd))
		return;
	Cbuf_AddText (cmd);
	Cbuf_AddText (qn_host_mode ? "coop 1\ndeathmatch 0\n"
	                           : "coop 0\ndeathmatch 1\n");
	Cbuf_AddText ("listen 1\n");
	SCR_BeginLoadingPlaque ();
	if (q_snprintf (cmd, sizeof (cmd), "map %s\n",
	                qn_host_maps[qn_host_map]) >= (int) sizeof (cmd))
		return;
	Cbuf_AddText (cmd);
}

static void QN_HostStop (void)
{
	if (!sv.active)
		return;
	/* listen 0 retires the host lane (HOST_DOWN, code dies) before
	 * the server shuts down under it. */
	Cbuf_AddText ("listen 0\ndisconnect\n");
}

static qboolean qn_host_item_visible (int item)
{
	if (item == QN_H_ITEM_ADVANCE)
		return sv.active && qn_host_mode;
	return true;
}

/* Manual host advance: next campaign entry of the story-sorted pool as a
 * fixed changelevel re-issue (the riding primitive: continues the game on
 * the new level), never free-form text. */
static void QN_HostAdvance (void)
{
	char	cmd[32];
	int	i, at = -1;

	if (!sv.active || !qn_host_mode)
		return;
	for (i = 0; i < qn_host_mapcount; i++)
		if (!q_strcasecmp (qn_host_maps[i], sv.name))
			at = i;
	if (at < 0 || at + 1 >= qn_host_mapcount ||
	    !QN_MapInPool (qn_host_maps[at + 1], QN_POOL_COOP))
	{
		QN_HostNote ("end of the campaign list");
		return;
	}
	if (qn_host_map == at + 1)
		return;	/* queued but not landed: a ride is already pending */
	if (q_snprintf (cmd, sizeof (cmd), "changelevel %s\n",
	                qn_host_maps[at + 1]) >= (int) sizeof (cmd))
		return;
	Cbuf_AddText (cmd);
	qn_host_map = at + 1;
}

static int QN_ClientPing (const client_t *c)
{
	int		j, n = c->num_pings;
	double	tot = 0;

	if (n > NUM_PING_TIMES)
		n = NUM_PING_TIMES;
	if (n <= 0)
		return -1;
	for (j = 0; j < n; j++)
		tot += c->ping_times[j];
	tot /= n;
	if (!(tot >= 0.0) || tot > 9999.0)	/* NaN and absurd values */
		return 9999;
	return (int) tot;
}

/* who is in, straight from the server's own bookkeeping; names are remote
 * data, so every character outside the printable band renders as '.' */
static void QN_RosterDraw (void)
{
	char	line[32];
	int		shown = 0, extra = 0, used = 0;
	int			i;

	if (!svs.clients || svs.maxclients < 1)
		return;
	line[0] = '\0';
	for (i = 0; i < svs.maxclients; i++)
	{
		client_t	*c = &svs.clients[i];
		char	safe[16];
		const char	*p;
		int		k, need;

		if (!c->active || !c->name[0] || Q_strcmp (c->name, "unconnected") == 0)
			continue;
		if (shown >= 8)
		{
			extra++;
			continue;
		}
		for (k = 0; k < 15 && c->name[k]; k++)
			safe[k] = (c->name[k] < ' ' || (unsigned char) c->name[k] > '~')
			          ? '.' : c->name[k];
		safe[k] = '\0';
		need = (used ? 2 : 0) + k + 5;
		if (used + need >= (int) sizeof (line) - 1)
		{
			extra++;
			continue;
		}
		if (used)
			line[used++] = ' ', line[used++] = ' ';
		for (p = safe; *p; p++)
			line[used++] = *p;
		line[used++] = '@';
		need = QN_ClientPing (c);
		if (need < 0)
			line[used++] = '-';
		else
		{
			char	num[8];
			q_snprintf (num, sizeof (num), "%d", need);
			for (p = num; *p; p++)
				line[used++] = *p;
		}
		line[used] = '\0';
		shown++;
	}
	if (!shown)
		return;
	if (extra)
		q_strlcat (line, " (+)", sizeof (line));
	M_Print (64, 176, line);
}

void QN_Menu_HostDraw (void)
{
	qpic_t	*p;
	char	line[96];
	const char	*code;

	M_DrawTransPic (16, 4, Draw_CachePic ("gfx/qplaque.lmp"));
	p = Draw_CachePic ("gfx/p_multi.lmp");
	M_DrawPic ((320 - p->width) / 2, 4, p);

	M_Print (64, 56, "Game Type");
	M_Print (176, 56, qn_host_mode ? "Cooperative" : "Deathmatch");

	M_Print (64, 72, "Map");
	{
		const char	*map = qn_host_mapcount ? qn_host_maps[qn_host_map]
		                                     : "none";
		char		mapline[18];
		int			i;

		for (i = 0; i < 16 && map[i]; i++)
			mapline[i] = map[i];
		mapline[i] = '\0';
		M_Print (176, 72, mapline);
	}

	M_Print (64, 88, "Players");
	q_snprintf (line, sizeof (line), "%d (%d open slot%s)",
	            qn_host_players,
	            qn_host_players > 0 ? qn_host_players - 1 : 0,
	            (qn_host_players - 1) == 1 ? "" : "s");
	M_Print (176, 88, line);

	M_DrawTextBox (168, 100, 14, 1);
	M_Print (176, 108, sv.active ? "stop hosting" : "start hosting");

	if (qn_host_item_visible (QN_H_ITEM_ADVANCE))
	{
		M_Print (64, 128, "Campaign");
		M_Print (176, 128, "advance map");
	}

	M_Print (176, 136, "back");

	if (qn_host_cursor <= QN_H_ITEM_PLAYERS)
		M_DrawCharacter (158, 56 + (qn_host_cursor - QN_H_ITEM_MODE) * 16, 10 + ((int)(realtime*4)&1));
	else if (qn_host_cursor == QN_H_ITEM_ACTION)
		M_DrawCharacter (158, 108, 10 + ((int)(realtime*4)&1));
	else if (qn_host_cursor == QN_H_ITEM_ADVANCE &&
	         qn_host_item_visible (QN_H_ITEM_ADVANCE))
		M_DrawCharacter (158, 128, 10 + ((int)(realtime*4)&1));
	else if (qn_host_cursor == QN_H_ITEM_BACK)
		M_DrawCharacter (158, 136, 10 + ((int)(realtime*4)&1));

	if (sv.active)
	{
		code = QN_JoinCodeText ();
		if (code[0])
		{
			M_DrawTextBox (64, 148, 20, 2);
			M_Print (72, 156, "share this code:");
			M_PrintWhite (72, 164, code);
		}
		else
		{
			M_Print (72, 156, "opening room...");
		}
	}

	QN_RosterDraw ();

	if (qn_host_note && realtime - qn_host_note_time < 4.0)
		M_PrintWhite (40, 184, qn_host_note);
}

void QN_Menu_HostKey (int key)
{
	switch (key)
	{
	case K_ESCAPE:
	case K_BBUTTON:
		M_Menu_MultiPlayer_f ();
		return;

	case K_UPARROW:
		S_LocalSound ("misc/menu1.wav");
		do
		{
			qn_host_cursor--;
			if (qn_host_cursor < 0)
				qn_host_cursor = QN_H_NUM_ITEMS - 1;
		} while (!qn_host_item_visible (qn_host_cursor));
		return;

	case K_DOWNARROW:
		S_LocalSound ("misc/menu1.wav");
		do
		{
			qn_host_cursor++;
			if (qn_host_cursor >= QN_H_NUM_ITEMS)
				qn_host_cursor = 0;
		} while (!qn_host_item_visible (qn_host_cursor));
		return;

	case K_LEFTARROW:
		if (qn_host_cursor <= QN_H_ITEM_PLAYERS)
		{
			S_LocalSound ("misc/menu3.wav");
			QN_HostChange (-1);
		}
		return;

	case K_RIGHTARROW:
		if (qn_host_cursor <= QN_H_ITEM_PLAYERS)
		{
			S_LocalSound ("misc/menu3.wav");
			QN_HostChange (1);
		}
		return;

	case K_ENTER:
	case K_KP_ENTER:
	case K_ABUTTON:
		m_entersound = true;
		switch (qn_host_cursor)
		{
		case QN_H_ITEM_MODE:
		case QN_H_ITEM_MAP:
		case QN_H_ITEM_PLAYERS:
			S_LocalSound ("misc/menu3.wav");
			QN_HostChange (1);
			break;
		case QN_H_ITEM_ACTION:
			if (sv.active)
				QN_HostStop ();
			else
				QN_HostStart ();
			if (!qn_host_item_visible (qn_host_cursor))
				qn_host_cursor = QN_H_ITEM_ACTION;
			break;
		case QN_H_ITEM_ADVANCE:
			QN_HostAdvance ();
			break;
		default:
			M_Menu_MultiPlayer_f ();
			break;
		}
		return;

	default:
		return;
	}
}

//=============================================================================
/* JOIN PAGE — code entry through qn_pad; this page is the code's only
 * client-side display surface. */

static qn_pad_t	qn_join_pad;
static const char	*qn_join_note;
static double	qn_join_note_time;

static void QN_JoinNote (const char *fixed)
{
	qn_join_note = fixed;
	qn_join_note_time = realtime;
}

void QN_Menu_JoinInit (void)
{
	QN_PadReset (&qn_join_pad);
	qn_join_note = NULL;
	m_return_reason[0] = 0;
}

static void QN_JoinDial (void)
{
	char	grouped[QN_PAD_CODE_LEN + 3 + 1];
	char	cmd[8 + 3 + sizeof (grouped) + 4];

	if (!QN_PadGrouped (&qn_join_pad, grouped, sizeof (grouped)))
	{
		QN_JoinNote ("code incomplete");
		return;
	}
	if (q_snprintf (cmd, sizeof (cmd), "connect \"qn:%s\"\n",
	                grouped) >= (int) sizeof (cmd))
		return;
	m_return_state = m_qn_join;
	m_return_onerror = true;
	IN_Activate ();
	key_dest = key_game;
	m_state = m_none;
	QN_JoinAttemptReset ();		/* stale cause text dies with this dial */
	Cbuf_AddText (cmd);
	memset (cmd, 0, sizeof (cmd));
	memset (grouped, 0, sizeof (grouped));
	QN_PadReset (&qn_join_pad);	/* the secret leaves this page */
	m_entersound = true;		/* only an accepted dial clicks */
}

static void QN_DrawCause (void)
{
	const char	*t = QN_JoinCauseText ();
	int	i, split = 0;

	if (!t)
		return;
	for (i = 0; i < 32 && t[i]; i++)
		if (t[i] == ' ')
			split = i + 1;
	if (t[i] && split)
	{
		char	head[33];

		for (i = 0; i < split - 1; i++)
			head[i] = t[i];
		head[i] = '\0';
		M_PrintWhite (40, 80, head);
		M_PrintWhite (40, 92, t + split);
	}
	else
		M_PrintWhite (40, 80, t);
}

void QN_Menu_JoinDraw (void)
{
	qpic_t	*p;
	char	shown[QN_PAD_CODE_LEN + 3 + 1];
	int	n = qn_join_pad.n;
	int	i, c = 0, cx;

	M_DrawTransPic (16, 4, Draw_CachePic ("gfx/qplaque.lmp"));
	p = Draw_CachePic ("gfx/p_multi.lmp");
	M_DrawPic ((320 - p->width) / 2, 4, p);

	M_Print (48, 56, "   join code");
	M_DrawTextBox (144, 48, QN_PAD_CODE_LEN + 4, 1);
	/* grouped echo of the typed code; nothing here reaches the console */
	for (i = 0; i < n; i++)
	{
		if (i && (i % 4) == 0)
			shown[c++] = '-';
		shown[c++] = qn_join_pad.code[i];
	}
	shown[c] = '\0';
	if (c)
		M_PrintWhite (152, 56, shown);
	cx = 152 + (n + (n ? (n - 1) / 4 : 0)) * 8;
	M_DrawCharacter (cx, 56, 10 + ((int)(realtime*4)&1));

	if (QN_JoinCauseText ())
		QN_DrawCause ();
	else if (m_return_reason[0])
		M_PrintWhite (64, 80, m_return_reason);
	else if (qn_join_note && realtime - qn_join_note_time < 4.0)
		M_PrintWhite (64, 80, qn_join_note);

	M_Print (48, 176, "type code  L paste  Del clear");
}

void QN_Menu_JoinKey (int key)
{
	switch (key)
	{
	case K_ESCAPE:
	case K_BBUTTON:
		M_Menu_MultiPlayer_f ();
		return;

	case K_ENTER:
	case K_KP_ENTER:
	case K_ABUTTON:
		QN_JoinDial ();
		return;

	case K_BACKSPACE:
		QN_PadBack (&qn_join_pad);
		return;

	case K_DEL:
		QN_PadReset (&qn_join_pad);
		QN_JoinNote ("cleared");
		return;

	default:
		return;
	}
}

void QN_Menu_JoinChar (int key)
{
	if (key == 'l' || key == 'L')	/* L: excluded from the code alphabet */
	{
		/* explicit paste keystroke; clipboard untrusted, never echoed */
		char	*clip = SDL_GetClipboardText ();
		int	ok;

		ok = clip ? QN_PadPaste (&qn_join_pad, clip) : 0;
		if (clip)
			SDL_free (clip);
		if (!ok)
			QN_JoinNote ("paste not a code");	/* keep what was typed */
		return;
	}
	QN_PadFeed (&qn_join_pad, (char)key);
}
