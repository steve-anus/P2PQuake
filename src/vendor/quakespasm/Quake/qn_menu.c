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
		for (i = 0; i < qn_host_mapcount; i++)
			if (!q_strcasecmp (qn_host_maps[i], it->name))
				break;
		if (i < qn_host_mapcount)
			continue;
		q_strlcpy (qn_host_maps[qn_host_mapcount], it->name,
		           QN_HOST_MAPNAME_LEN);
		qn_host_mapcount++;
	}
	if (qn_host_map >= qn_host_mapcount)
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
		int limit = 8;
		if (svs.maxclientslimit < limit)
			limit = svs.maxclientslimit;
		if (limit < 1)
			limit = 1;
		qn_host_players += dir;
		if (qn_host_players < 1)
			qn_host_players = limit;
		if (qn_host_players > limit)
			qn_host_players = 1;
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
	if (!qn_host_mapcount || qn_host_map >= qn_host_mapcount)
	{
		QN_HostNote ("no playable maps found in gamedata");
		return;
	}
	/* Fixed command texts only. listen 0 first so the port and every
	 * driver re-examine the change (same sequence the LAN GameOptions
	 * flow uses); svs.maxclients is written directly because the
	 * maxplayers command would flip deathmatch on its own. */
	Cbuf_AddText ("listen 0\n");
	svs.maxclients = qn_host_players;
	Cvar_Set ("coop", qn_host_mode ? "1" : "0");
	Cvar_Set ("deathmatch", qn_host_mode ? "0" : "1");
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

void QN_Menu_HostDraw (void)
{
	qpic_t	*p;
	char	line[96];
	const char	*code;

	M_DrawTransPic (16, 4, Draw_CachePic ("gfx/qplaque.lmp"));
	p = Draw_CachePic ("gfx/p_multi.lmp");
	M_DrawPic ((320 - p->width) / 2, 4, p);

	M_Print (64, 56, "        Game Type");
	M_Print (160, 56, qn_host_mode ? "Cooperative" : "Deathmatch");

	M_Print (64, 72, "            Map");
	M_Print (160, 72, qn_host_mapcount ? qn_host_maps[qn_host_map]
	                                   : "none");

	M_Print (64, 88, "        Players");
	q_snprintf (line, sizeof (line), "%d (%d open slot%s)",
	            qn_host_players,
	            qn_host_players > 0 ? qn_host_players - 1 : 0,
	            (qn_host_players - 1) == 1 ? "" : "s");
	M_Print (160, 88, line);

	M_DrawTextBox (152, 108, 14, 1);
	M_Print (160, 116, sv.active ? "stop hosting" : "start hosting");

	M_Print (160, 136, "back");

	if (qn_host_cursor <= QN_H_ITEM_PLAYERS)
		M_DrawCharacter (144, 56 + (qn_host_cursor - QN_H_ITEM_MODE) * 16, 10 + ((int)(realtime*4)&1));
	else if (qn_host_cursor == QN_H_ITEM_ACTION)
		M_DrawCharacter (144, 116, 10 + ((int)(realtime*4)&1));
	else if (qn_host_cursor == QN_H_ITEM_BACK)
		M_DrawCharacter (144, 136, 10 + ((int)(realtime*4)&1));

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
		qn_host_cursor--;
		if (qn_host_cursor < 0)
			qn_host_cursor = QN_H_NUM_ITEMS - 1;
		return;

	case K_DOWNARROW:
		S_LocalSound ("misc/menu1.wav");
		qn_host_cursor++;
		if (qn_host_cursor >= QN_H_NUM_ITEMS)
			qn_host_cursor = 0;
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
	Cbuf_AddText (cmd);
	memset (cmd, 0, sizeof (cmd));
	memset (grouped, 0, sizeof (grouped));
	QN_PadReset (&qn_join_pad);	/* the secret leaves this page */
	m_entersound = true;		/* only an accepted dial clicks */
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

	if (m_return_reason[0])
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
