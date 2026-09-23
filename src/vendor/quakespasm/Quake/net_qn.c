/*
 * net_qn.c -- p2pquake landriver: virtual sockets for the local qn-peer
 * daemon. All game traffic over this driver travels through the engine's
 * own qn-peer child over the Plane A Unix-domain socket (the frame
 * grammar is src/protocol/qn_protocol.md); the daemon owns every remote
 * byte.
 *
 * Postures:
 *  - Absent (default): without -qn on the command line QN_Init returns
 *    INVALID_SOCKET and the datagram layer skips the driver entirely.
 *  - Standby: with -qn the driver registers but refuses every data-plane
 *    operation; no daemon is spawned until a lane actually needs one
 *    (the server goes active, or the console connects to a qn: name).
 *  - Running: reached only when the engine's own spawned child passes
 *    the AUTH gate (spec section 4). Only then do virtual sockets exist
 *    and frames move.
 *
 * Command-line surface (no secrets -- the AUTH token is handed to the
 * child on stdin and never appears here):
 *   -qn                    register the landriver
 *   -qn-peer <abspath>     peer program (default: "qn-peer" beside the
 *                          engine binary; never a PATH search)
 *   -qn-dir <abspath>      socket directory (default: $XDG_RUNTIME_DIR/
 *                          p2pquake, else /tmp/p2pquake-<uid>; ownership
 *                          and the 0700 mode are re-validated by the
 *                          transport on every use)
 *   -qn-name <text>        display name forwarded to the daemon
 *   -qn-pin <64hex>        pin the client lane to one host identity key
 *                          (spec section 4.1); a malformed pin fails the
 *                          join closed rather than silently dropping it
 */

#include "q_stdinc.h"
#include "arch_def.h"
#include "net_sys.h"
#include "quakedef.h"
#include "net_defs.h"

#include <poll.h>

#include "qn_frame.h"
#include "qn_spawn.h"
#include "qn_stext.h"
#include "qn_transport.h"

#include "net_qn.h"

extern char	**environ;	/* process environment, checked for the token
				 * by qn_spawn_start before any exec */

/* Synthetic address family tag: no Linux/BSD AF_* occupies 'q'. The
 * datagram layer only ever passes struct qsockaddr through, so any
 * private value that cannot collide works; identity comes from
 * AddrCompare below. */
#define QN_AF 0x71

#define MAX_QN_SOCKETS 48	/* two table slots per player (the
			 * accepted id forwards to the live one),
			 * the client lane, and churn headroom */
#define QN_QDEPTH 6
#define QN_QCAP 1400
#define QN_WIRE_MAX 1100	/* daemon body cap (src/peer/qn-peer.cjs) */
#define QN_PUMP_BUDGET 64	/* frames digested per pump tick */
#define QN_DROP_RUN 10	/* spec 2.3: close after this many in a row */

/* Layout mirrors struct qsockaddr (net_defs.h): short family + 14 data
 * bytes. Key holds the first eight bytes of the remote identity key --
 * grinding a collision costs ~2^32 keypairs, far past the eight-player
 * table this driver serves. An all-zero key means the one client-lane
 * socket (real identity keys are never all zero). */
typedef struct
{
	short family;
	unsigned short lane;
	unsigned short port;
	unsigned char key[8];
	unsigned short spare;
} qnqsockaddr_t;

/* The datagram layer memcpy's struct qsockaddr around; the mirror above
 * must stay exactly that size or every address touch is a row-shift. */
typedef char qn_addr_size_check
	[(sizeof (qnqsockaddr_t) == sizeof (struct qsockaddr)) ? 1 : -1];

typedef struct
{
	qboolean	inuse;
	qboolean	listening;	/* pending hand-off to the datagram layer */
	qboolean	dead;		/* PEER_DOWN pending: Read reports -1 once */
	qboolean	isclient;	/* this process's own outgoing lane */
	qboolean	alias;		/* write/read follows aliasof: the slot the
				 * datagram layer still references after it
				 * opened a fresh socket for an accepted
				 * player (UDP keeps one fd for both; this
				 * table keeps two, so the old id must
				 * forward, not vanish) */
	int		aliasof;
	qnqsockaddr_t	addr;
	qnqsockaddr_t	connect_addr;	/* the address this socket was
					 * opened for: what the datagram
					 * layer compares replies against.
					 * PEER_UP stamps the live key onto
					 * addr (membership sweeps match on
					 * it); the handshake must keep the
					 * identity the connect carried --
					 * a join code cannot know the
					 * host key before the lane is up */
	unsigned char	q[QN_QDEPTH][QN_QCAP + 8];
	size_t		qlen[QN_QDEPTH];
	unsigned	qh, qt;
	/* A connect request (CCREQ_CONNECT) that arrives for a slot
	 * already holding a live session: kept OUT of the shared queue
	 * (the session reader would eat it as a stray CTL packet) and
	 * served only to the accept path while an offer is live. */
	unsigned char	ccreq[QN_QCAP + 8];
	size_t		ccreq_n;
	qboolean	ccreq_ready;
	qboolean	ccreq_offer;
	unsigned char	peer32[32];	/* SV_DATA fan-out target: the live
					   peer key, stamped by PEER_UP */
} qn_socket_t;

static qn_socket_t	qn_sockets[MAX_QN_SOCKETS];
static qn_state_t	qn_state = QN_OFF;
static qboolean		qn_wantlisten = false;

/* Plane A session machinery (only meaningful once a lane demanded it) */
static qn_transport_t	qn_tr;
static qn_spawn_t	qn_child;
static int		qn_listenfd = -1;
static uint8_t		qn_token[QN_AUTH_TOKEN_LEN];
static qboolean		qn_token_live = false;
static qboolean		qn_daemon_retired;	/* daemon exited status 0:
					   it ended the session by
					   choice; respawn is crash
					   policy, not resurrection */
static char		qn_sockpath[512];

/* lane bookkeeping */
static qboolean		qn_host_lane_up;
static qboolean		qn_host_ready_shown;
static qboolean		qn_client_lane_up;
static qboolean		qn_client_was_connected;	/* the lane has served a
						   live client session */
static uint8_t		qn_join_code[10];
static qboolean		qn_join_pending;
static qboolean		qn_join_code_valid;	/* a code was parsed at least once this run */
static uint8_t		qn_pin_key[32];
static qboolean		qn_pin_set, qn_pin_malformed;

/* counters (fixed-string reporting only) */
static unsigned		qn_drops_run, qn_drops_total, qn_queue_drops;
static unsigned long long qn_pump_ms;

/* spawn-failure latch: a refused spawn is reported once, not once per
 * frame; it re-arms only on a fresh lane demand */
static unsigned		qn_demand, qn_demand_reported;
static qboolean		qn_sv_was_active;
static const char	*qn_last_note;

void QN_SetState (qn_state_t state)
{
	qn_state = state;
}

qn_state_t QN_GetState (void)
{
	return qn_state;
}

/* All call sites pass string literals from this file (or fixed literals
 * from the transport/spawn modules), so a pointer-equality dedup is
 * exact: the same failure prints once until a different one happens. */
static void qn_note (const char *fixed)
{
	if (qn_last_note == fixed)
		return;
	qn_last_note = fixed;
	Con_SafePrintf ("QN: %s\n", fixed);
}

static void qn_stext_exec (const char *line, size_t len)
{
	char	cmdbuf [QN_STEXT_MAXLINE + 2];
	size_t	t = len;

	while (t && (line[t - 1] == '\n' || line[t - 1] == '\r'))
		t--;
	memcpy (cmdbuf, line, t);
	cmdbuf[t] = '\n';		/* exactly one terminator: an empty
					   re-enter would replay the previous
					   command into the line buffer */
	cmdbuf[t + 1] = '\0';
	Cbuf_AddText (cmdbuf);
	qn_note ("stufftext allowlisted");
}

/* Game-protocol entry (cl_parse.c's svc_stufftext arm). Plane A drops
 * feed the drop totals, game-protocol drops do not: the drop storm is a
 * Plane A contract signal (spec 2.3). */
void QN_StufftextFromGame (const char *line)
{
	size_t	len = strlen (line);

	if (len >= 1 && len <= QN_STEXT_MAXLINE && QN_StextAllowed (line, len))
		qn_stext_exec (line, len);
	else
		qn_note ("stufftext dropped (not allowlisted)");
}

/* Only ever true from the RUNNING window, so no virtual socket can
 * exist while the module stands by -- the data-plane refusals below are
 * belt-and-braces, not reachable policy surfaces. */
static qboolean qn_live (void)
{
	return qn_state == QN_RUNNING;
}

static void qn_zero_secret (void)
{
	memset (qn_token, 0, sizeof (qn_token));
	qn_token_live = false;
	memset (&qn_tr, 0, sizeof (qn_tr));
	qn_tr.fd = -1;
}

/*
 * ------------------------------------------------------- join code text
 */

static const char CROCKFORD[] = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

static int crockford_value (int c)
{
	if (c >= '0' && c <= '9')
		return c - '0';
	if (c >= 'a' && c <= 'z')
		c -= 'a' - 'A';
	if (c >= 'A' && c <= 'Z')
	{
		const char *p = strchr (CROCKFORD + 10, c);
		if (p == NULL)
			return -1;	/* I, L, O, U are not in the alphabet */
		return (int) (10 + (p - (CROCKFORD + 10)));
	}
	return -1;
}

/* The 10 CSPRNG bytes behind a 16-symbol display string (hyphens
 * allowed anywhere between symbols and ignored; spec section 5.1). */
static qboolean crockford_decode16 (const char *s, size_t n, uint8_t out[10])
{
	unsigned int acc = 0;
	int bits = 0, chars = 0, bytes = 0;

	memset (out, 0, 10);
	for (; n--; s++)
	{
		int v;
		if (*s == '-')
			continue;
		v = crockford_value ((unsigned char) *s);
		if (v < 0)
			return false;
		acc = (acc << 5) | (unsigned int) v;
		bits += 5;
		chars++;
		if (bits >= 8)
		{
			bits -= 8;
			if (bytes >= 10)
				return false;	/* more than 16 symbols cannot be a
						   code: refuse before storing, the
						   final count check alone would
						   reject only after the overrun */
			out[bytes++] = (unsigned char) ((acc >> bits) & 0xff);
			acc &= (1u << bits) - 1;
		}
	}
	return chars == 16 && bytes == 10;
}

/* Display form without the hyphens (the caller groups 4-4-4-4). */
static void crockford_encode10 (const uint8_t in[10], char out[17])
{
	unsigned int acc = 0;
	int bits = 0, o = 0;
	size_t i;

	for (i = 0; i < 10; i++)
	{
		acc = (acc << 8) | in[i];
		bits += 8;
		while (bits >= 5)
		{
			bits -= 5;
			out[o++] = CROCKFORD[(acc >> bits) & 31];
			acc &= (1u << bits) - 1;
		}
	}
	out[o] = '\0';
}

/*
 * ------------------------------------------------------- daemon control
 */

/* Build the daemon argv: program identity plus the socket path and an
 * optional display name. Flags are not secrets; the AUTH token is never
 * anywhere near argv, env, or any log line (spec section 4). */
static void qn_paravec (const char *prog, const char *uds, const char *dir,
                        const char *name, char *argv[8])
{
	static char nm[32];
	int i = 0;

	argv[i++] = (char *) prog;
	argv[i++] = "--uds";
	argv[i++] = (char *) uds;
	/* The daemon's state directory (identity key, pinning epochs) is
	 * this process's p2p state: two engines sharing a socket dir share
	 * nothing else, and two engines on one box must not share the
	 * noise identity -- hyperswarm refuses a swarm that meets its own
	 * public key, so a common identity.key would silently seal every
	 * same-box join. The transport already enforces the 0700/ownership
	 * posture on this dir that the daemon will write 0600 keys into. */
	argv[i++] = "--dir";
	argv[i++] = (char *) dir;
	if (name != NULL && *name != '\0')
	{
		q_strlcpy (nm, name, sizeof (nm));
		argv[i++] = "--name";
		argv[i++] = nm;
	}
	argv[i] = NULL;
}

static char qn_statedir[256];	/* resolved -qn-dir; also the daemon's
				   --dir state root (identity, epochs) */

static qboolean qn_open_socket_dir (void)
{
	const char *reason = NULL;
	const char *dir = NULL;
	static char fallback[256];
	int p;

	p = COM_CheckParm ("-qn-dir");
	if (p && p < com_argc - 1)
		dir = com_argv[p + 1];
	if (dir == NULL)
	{
		const char *xdg = getenv ("XDG_RUNTIME_DIR");
		if (xdg != NULL && *xdg != '\0')
			q_snprintf (fallback, sizeof (fallback), "%s/p2pquake",
			          xdg);
		else
			q_snprintf (fallback, sizeof (fallback),
			          "/tmp/p2pquake-%lu", (unsigned long) getuid ());
		/* The transport re-validates ownership and the 0700 mode of
		 * whatever this resolves to; a hostile preexisting dir is
		 * refused there, not here. */
		dir = fallback;
	}
	if (dir[0] != '/')
	{
		qn_note ("socket directory must be an absolute path");
		return false;
	}
	if (qn_transport_prepare_dir (dir) != 0)
	{
		qn_note ("refused socket directory");
		return false;
	}
	q_strlcpy (qn_statedir, dir, sizeof (qn_statedir));
	q_snprintf (qn_sockpath, sizeof (qn_sockpath), "%s/engine.sock", dir);
	qn_listenfd = qn_transport_listen (qn_sockpath, &reason);
	if (qn_listenfd < 0)
	{
		/* reason is a fixed literal from the transport module */
		qn_note (reason != NULL ? reason : "listen failed");
		return false;
	}
	return true;
}

static void qn_teardown (const char *why)
{
	if (qn_tr.fd >= 0)
		qn_transport_close (&qn_tr);
	/* stop() is guarded on a live pid (kill targets only our child)
	 * and scrubs the token history either way */
	qn_spawn_stop (&qn_child);
	qn_zero_secret ();
	qn_host_lane_up = false;
	qn_host_ready_shown = false;
	qn_client_lane_up = false;
	qn_join_pending = false;
	qn_drops_run = 0;
	memset (qn_sockets, 0, sizeof (qn_sockets));
	if (qn_state == QN_RUNNING)
		QN_SetState (QN_STANDBY);
	/* A fresh session after a teardown is a fresh demand: let the
	 * next lane event report its outcome even if it repeats. */
	qn_demand_reported = 0;
	qn_note (why);
}

/* Spawn on demand: called when a lane actually needs the daemon. The
 * failure latch keeps a broken setup from narrating every frame. */
static qboolean qn_ensure_daemon (void)
{
	const char *reason = NULL;
	const char *prog_over = NULL;
	char prog[512];
	char *argv[8];
	const char *name = NULL;
	int p;

	if (qn_demand_reported == qn_demand && qn_demand != 0)
		return false;	/* latched: waiting for a fresh demand */
	if (qn_daemon_retired)
		return false;	/* it left by choice; leave it gone */

	if (qn_listenfd < 0 && !qn_open_socket_dir ())
	{
		qn_demand_reported = qn_demand;
		return false;
	}
	if (qn_token_live || qn_spawn_running (&qn_child))
		return true;	/* child pending auth or already running */

	p = COM_CheckParm ("-qn-peer");
	if (p && p < com_argc - 1)
		prog_over = com_argv[p + 1];
	if (qn_spawn_resolve (prog, sizeof (prog), prog_over, &reason) != 0)
	{
		qn_demand_reported = qn_demand;
		qn_note (reason != NULL ? reason : "peer program refused");
		return false;
	}
	p = COM_CheckParm ("-qn-name");
	if (p && p < com_argc - 1)
		name = com_argv[p + 1];
	if (qn_spawn_make_token (qn_token) != 0)
	{
		qn_demand_reported = qn_demand;
		qn_note ("entropy failure; not spawning");
		return false;
	}
	qn_paravec (prog, qn_sockpath, qn_statedir, name, argv);
	/* The child inherits the engine's environment (it behaves as if the
	 * user launched the daemon themselves): a node-backed peer must find
	 * its interpreter via PATH. qn_spawn_start refuses if the AUTH token
	 * is found anywhere in argv or envp (spec section 4). */
	if (qn_spawn_start (&qn_child, prog, argv, environ, qn_token,
	                     qn_pump_ms, &reason) != 0)
	{
		qn_demand_reported = qn_demand;
		qn_note (reason != NULL ? reason : "spawn refused");
		return false;
	}
	qn_token_live = true;
	qn_note ("daemon spawned, awaiting auth");
	return true;
}

/*
 * ------------------------------------------------- virtual socket table
 */

static int qn_slot_by_key (const uint8_t key8[8])
{
	int i;

	for (i = 0; i < MAX_QN_SOCKETS; i++)
	{
		if (qn_sockets[i].inuse && !qn_sockets[i].isclient &&
		    !qn_sockets[i].alias &&
		    memcmp (qn_sockets[i].addr.key, key8, 8) == 0)
			return i;
	}
	return -1;
}

/* First live client-role slot: the engine plays one client at a time
 * (the datagram layer owns at most one outbound qsocket per connect),
 * so first match is the only match while a connect is pending. */
static int qn_client_slot (void)
{
	int i;

	for (i = 0; i < MAX_QN_SOCKETS; i++)
		if (qn_sockets[i].inuse && qn_sockets[i].isclient)
			return i;
	return -1;
}

static void qn_enqueue (qn_socket_t *s, const uint8_t *data, size_t n)
{
	size_t next;

	if (n == 0 || n > QN_QCAP)
	{
		qn_queue_drops++;
		return;
	}
	next = (s->qt + 1) % QN_QDEPTH;
	if (next == s->qh)
	{
		qn_queue_drops++;	/* bounded: drop, never grow */
		return;
	}
	memcpy (s->q[s->qt], data, n);
	s->qlen[s->qt] = n;
	s->qt = (unsigned) next;
}

/* A forwarding slot outliving its target (the datagram layer closed the
 * player's socket with no PEER_DOWN for the sweep to follow) must not
 * strand table entries through re-dials of the same key. */
static void qn_gc_dead_aliases (const uint8_t key8[8])
{
	int i;

	for (i = 0; i < MAX_QN_SOCKETS; i++)
	{
		if (qn_sockets[i].inuse && qn_sockets[i].alias &&
		    qn_sockets[i].aliasof >= 0 &&
		    qn_sockets[i].aliasof < MAX_QN_SOCKETS &&
		    !qn_sockets[qn_sockets[i].aliasof].inuse &&
		    memcmp (qn_sockets[i].addr.key, key8, 8) == 0)
			memset (&qn_sockets[i], 0, sizeof (qn_sockets[i]));
	}
}

static qn_socket_t *qn_introduce (const uint8_t pub32[32],
                                  const uint8_t *pkt, size_t pktn,
                                  qboolean *held)
{
	int i;
	uint32_t word = 0;
	qboolean redial = false;

	*held = false;
	if (pkt != NULL && pktn >= 5 && pktn <= QN_QCAP)
	{
		word = ((uint32_t) pkt[0] << 24) |
		       ((uint32_t) pkt[1] << 16) |
		       ((uint32_t) pkt[2] << 8) | (uint32_t) pkt[3];
		redial = ((word & ~0xffffu) == (uint32_t) NETFLAG_CTL &&
			  (word & 0xffffu) == (uint32_t) pktn &&
			  pkt[4] == CCREQ_CONNECT) ? true : false;
	}

	qn_gc_dead_aliases (pub32);
	i = qn_slot_by_key (pub32);
	if (i >= 0)
	{
		if (redial)
		{
			/* crash re-connect for a live key: the shared
			 * queue cannot carry it -- the session's own
			 * reader consumes CTL packets unheeding. Hold
			 * it for the accept path alone; the newest
			 * request wins (resends collapse). */
			memcpy (qn_sockets[i].peer32, pub32, 32);
			memcpy (qn_sockets[i].ccreq, pkt, pktn);
			qn_sockets[i].ccreq_n = pktn;
			qn_sockets[i].ccreq_ready = true;
			qn_sockets[i].ccreq_offer = false;
			qn_sockets[i].listening = true;
			*held = true;
		}
		return &qn_sockets[i];
	}
	for (i = 0; i < MAX_QN_SOCKETS; i++)
	{
		if (!qn_sockets[i].inuse)
		{
			memset (&qn_sockets[i], 0, sizeof (qn_sockets[i]));
			qn_sockets[i].inuse = true;
			qn_sockets[i].listening = true;
			qn_sockets[i].addr.family = QN_AF;
			qn_sockets[i].addr.lane = (unsigned short) i;
			qn_sockets[i].addr.port = (unsigned short) net_hostport;
			memcpy (qn_sockets[i].addr.key, pub32, 8);
			memcpy (qn_sockets[i].peer32, pub32, 32);
			return &qn_sockets[i];
		}
	}
	qn_queue_drops++;	/* table full: the room holds more than we serve */
	return NULL;
}

/*
 * ----------------------------------------------- frame dispatch (recv)
 */

static void qn_data_frame (const qn_frame_t *f, qboolean clientrole)
{
	qn_tlv_t t_from, t_body;
	qn_socket_t *s = NULL;

	if (f->len == 0 ||
	    qn_tlv_find (f->payload, f->len, 1, &t_from) != 1 ||
	    qn_tlv_find (f->payload, f->len, 2, &t_body) != 1)
	{
		qn_teardown ("malformed data frame");
		return;
	}
	if (t_from.len != 32 || t_body.len == 0 || t_body.len > QN_QCAP)
	{
		qn_teardown ("malformed data frame");
		return;
	}
	if (clientrole)
	{
		/* One outgoing lane: whatever the daemon tags as `from`,
		 * it authenticated the sender on Plane B for us, so the
		 * bytes belong to our one client socket. */
		int i = qn_client_slot ();
		if (i < 0)
			return;	/* data before any Connect: nothing to feed */
		s = &qn_sockets[i];
	}
	else
	{
		qboolean held = false;
		s = qn_introduce (t_from.val, t_body.val, t_body.len, &held);
		if (s == NULL)
			return;
		if (held)
			return;	/* connect request: the accept path will
				   serve it, the session queue must not */
	}
	qn_enqueue (s, t_body.val, t_body.len);
}

static void qn_show_join_code (const uint8_t code[10])
{
	char enc[17], grouped[19 + 1], line[48];
	int g, c = 0;

	crockford_encode10 (code, enc);
	for (g = 0; g < 4; g++)
	{
		if (g)
			grouped[c++] = '-';
		memcpy (grouped + c, enc + g * 4, 4);
		c += 4;
	}
	grouped[c] = '\0';
	/* The join code is minted by the daemon for local display only
	 * (spec 5.1 display surface); it is not attacker content. */
	q_snprintf (line, sizeof (line), "Join code: %s\n", grouped);
	Con_SafePrintf ("%s", line);
}

static void qn_dispatch (const qn_frame_t *f)
{
	qn_tlv_t t;

	switch (f->type)
	{
	case QN_T_PING:
		if (f->len != 4)
		{
			qn_teardown ("malformed ping");
			return;
		}
		/* Echo the nonce verbatim: no decoding needed, and no
		 * peer-controlled value ever becomes ours. */
		if (qn_transport_send (&qn_tr, QN_T_PONG, f->payload,
		                       f->len) != 1)
			qn_teardown ("send failed");
		qn_drops_run = 0;
		return;

	case QN_T_PEER_UP:
		if (qn_tlv_find (f->payload, f->len, 1, &t) != 1 || t.len != 32)
		{
			qn_teardown ("malformed peer_up");
			return;
		}
		if (qn_client_lane_up)
		{
			/* Client lane: the announced peer is the host.
			 * Stamp its key onto our client socket; it must
			 * not join the host-side table. */
			int i = qn_client_slot ();
			if (i >= 0)
				memcpy (qn_sockets[i].addr.key, t.val, 8);
		}
		else
		{
			qboolean held_unused = false;
			(void) qn_introduce (t.val, NULL, 0, &held_unused);
		}
		qn_drops_run = 0;
		return;

	case QN_T_PEER_DOWN:
		if (qn_tlv_find (f->payload, f->len, 1, &t) != 1 || t.len != 32)
		{
			qn_teardown ("malformed peer_down");
			return;
		}
		{
			int i;
			/* Sweep the whole table, not the first key match: the
			 * connection cycle leaves a forwarding slot behind,
			 * and one that survives its subject would eat a
			 * table entry for the rest of the run. */
			for (i = 0; i < MAX_QN_SOCKETS; i++)
			{
				if (!qn_sockets[i].inuse ||
				    memcmp (qn_sockets[i].addr.key, t.val, 8) != 0)
					continue;
				if (qn_sockets[i].alias)
					memset (&qn_sockets[i], 0, sizeof (qn_sockets[i]));
				else
				{
					qn_sockets[i].dead = true;
					qn_sockets[i].listening = false;
				}
			}
		}
		qn_drops_run = 0;
		return;

	case QN_T_SV_DATA:
		qn_data_frame (f, true);
		if (qn_state == QN_RUNNING)
			qn_drops_run = 0;
		return;

	case QN_T_CL_DATA:
		if (qn_client_lane_up)
			return;	/* host-lane frame on a client lane: ignore */
		qn_data_frame (f, false);
		if (qn_state == QN_RUNNING)
			qn_drops_run = 0;
		return;

	case QN_T_FATAL:
		/* spec 2.3 and 6.3: a peer's FATAL ends the match. Report
		 * the cause and tear the session down; what happens next
		 * belongs to the supervisor (a peer that then exits 0 has
		 * ended the session by choice, retirement covers it). */
		/* numeric-only format: no untrusted bytes reach the console,
		 * and qn_note's pointer-identity dedup stays literals-only */
		Con_SafePrintf ("QN: daemon FATAL (cause %u)\n",
		                (unsigned int) (f->len >= 1 ?
		                          f->payload[0] : 255));
		qn_teardown ("daemon sent FATAL");
		return;

	case QN_T_HOST_READY:
		if (qn_host_ready_shown ||
		    qn_tlv_find (f->payload, f->len, 1, &t) != 1 || t.len != 10)
		{
			/* exactly one HOST_READY per HOST_UP (spec 4.1):
			 * a second one is lane confusion, terminal */
			qn_teardown ("malformed host_ready");
			return;
		}
		qn_show_join_code (t.val);
		qn_host_ready_shown = true;
		qn_drops_run = 0;
		return;

	case QN_T_STUFFTEXT:
		/* Spec 6.4: only the derived allowlist (src/driver/
		 * qn_stext.c) reaches the console. A known type is not
		 * part of the drop storm, which counts only unknown
		 * types (spec 2.3). */
		if (QN_StextFrameOk ((const char *) f->payload, f->len) &&
		    QN_StextAllowed ((const char *) f->payload, f->len - 1))
			qn_stext_exec ((const char *) f->payload, f->len - 1);
		else
		{
			qn_drops_total++;
			qn_note ("stufftext dropped (not allowlisted)");
		}
		return;

	default:
		qn_drops_run++;
		qn_drops_total++;
		if (qn_drops_run >= QN_DROP_RUN)
			qn_teardown ("drop storm");
		return;
	}
}

/*
 * --------------------------------------------------------------- pump
 *
 * Driven from main_sdl.c once per frame. Does nothing until -qn registered
 * the driver; never blocks (every fd is non-blocking, every loop bounded).
 */

void QN_Pump (unsigned long long now_ms)
{
	qn_frame_t f;
	qn_tr_t st;
	int r, budget, wd;

	if (qn_state == QN_OFF)
		return;			/* no -qn: nothing has been initialized */
	qn_pump_ms = now_ms;

	/* The watchdog reaps what it kills, and qn_spawn_check is blind to
	 * an already-reaped pid: its verdict must be consumed here or a
	 * daemon that hangs before dialing would wedge standby with no
	 * report, no teardown and no respawn. */
	wd = qn_spawn_watchdog (&qn_child, now_ms);
	if (qn_spawn_check (&qn_child, now_ms) == 1 || wd == 1)
	{
		/* child exited -- before auth the gate re-spawns on the
		 * next lane demand; after auth this is a transport loss.
		 * An exit status of 0 says the daemon ended the session
		 * by choice: no respawn for the rest of this run. */
		if (qn_spawn_exited_cleanly (&qn_child))
		{
			qn_daemon_retired = true;
			/* the session is over: stop welcoming would-be daemons
			 * through a listener nobody asked to keep open */
			if (qn_listenfd >= 0)
			{
				close (qn_listenfd);
				qn_listenfd = -1;
				unlink (qn_sockpath);
			}
			qn_note ("daemon ended the session");
		}
		if (qn_token_live || qn_state == QN_RUNNING)
		{
			qn_teardown ("daemon exited");
			return;
		}
	}

	if (qn_listenfd >= 0 && qn_tr.fd < 0)
	{
		struct pollfd pt;
		/* poll() first: the accept wrapper does not distinguish an
		 * empty listener from a real failure, and an empty listener
		 * is the normal case, not a condition to report. */
		pt.fd = qn_listenfd;
		pt.events = POLLIN;
		pt.revents = 0;
		if (poll (&pt, 1, 0) == 1 && (pt.revents & POLLIN) != 0)
		{
			const char *reason = NULL;
			int fd = qn_transport_accept (qn_listenfd, &reason);
			if (fd >= 0)
			{
				if (qn_token_live)
					qn_transport_init (&qn_tr, fd, qn_token,
					                     now_ms);
				else
					close (fd);	/* no session pending: drop */
			}
			else if (reason != NULL)
				qn_note (reason);
		}
		else if (pt.revents != 0)
		{
			/* listener error (never POLLIN-less success) */
			close (qn_listenfd);
			qn_listenfd = -1;
			qn_demand_reported = 0;
		}
	}

	if (qn_tr.fd >= 0)
	{
		st = qn_transport_poll (&qn_tr, now_ms);
		if (st == QN_TR_AUTHED)
		{
			qn_child.authed = 1;	/* watchdog exempts an authed child */
			QN_SetState (QN_RUNNING);
			qn_note ("daemon authenticated");
		}
		else if (st == QN_TR_FAIL || st == QN_TR_CLOSED)
		{
			const char *why = qn_tr.reason != NULL ? qn_tr.reason
			                                       : "peer closed";
			qn_teardown (why);
			return;
		}
	}

	/* lane edges: the server going up/down drives HOST_UP/HOST_DOWN,
	 * the client connect/disconnect drives JOIN_OPEN/JOIN_CLOSE; the
	 * daemon itself is spawned on the first demand */
	if (sv.active && !qn_host_lane_up)
	{
		if (!qn_sv_was_active)
		{
			qn_demand++;		/* fresh demand: re-arm the latch */
			qn_sv_was_active = true;
		}
		if (!qn_ensure_daemon ())
			return;
		if (qn_live ())
		{
			uint8_t pl[16 + 20 + 1 + 24];
			const uint16_t tags[3] = { 1, 2, 3 };
			const uint8_t *vals[3];
			uint16_t lens[3];
			uint8_t maxp;
			size_t n;
			char map[17], host[21];

			q_strlcpy (map, sv.name, sizeof (map));
			q_strlcpy (host, hostname.string, sizeof (host));
			maxp = (unsigned char) (svs.maxclients > 255
			                     ? 255 : svs.maxclients);
			vals[0] = (const uint8_t *) map;
			lens[0] = (uint16_t) strlen (map);
			vals[1] = (unsigned char *) host;
			lens[1] = (uint16_t) strlen (host);
			vals[2] = &maxp;
			lens[2] = 1;
			n = qn_tlv_write (pl, sizeof (pl), tags, vals, lens, 3);
			if (n == 0)
			{
				qn_teardown ("host_up encode failed");
				return;
			}
			if (qn_transport_send (&qn_tr, QN_T_HOST_UP, pl,
			                       (uint16_t) n) != 1)
			{
				qn_teardown ("host_up send failed");
				return;
			}
			qn_host_lane_up = true;
			qn_host_ready_shown = false;
		}
	}
	else if (!sv.active)
	{
		/* No HOST_DOWN here: SV_ShutdownServer's sv.active window is a
		 * map change, not a host leaving -- and this pump runs inside
		 * that window (the connect/read paths self-service it), so an
		 * edge here retired the lane mid-map and re-minted the room.
		 * The host lane lives until the plane itself goes down. */
		qn_sv_was_active = false;
	}

	/* ca_disconnected covers the connect attempt itself -- CL only
	 * leaves it once NET_Connect returns -- so closing the lane on
	 * that edge alone would tear down the join before the daemon's
	 * lookup could land. Close only after the lane has actually
	 * served an established session. */
	if (cls.state == ca_connected)
		qn_client_was_connected = true;	/* the lane has served an
						   established session */
	if (qn_client_lane_up && cls.state == ca_disconnected &&
	    qn_client_was_connected)
	{
		if (qn_live () &&
		    qn_transport_send (&qn_tr, QN_T_JOIN_CLOSE, NULL, 0) != 1)
			qn_teardown ("join_close send failed");
		else
			qn_client_lane_up = false;
	}

	if (qn_join_pending && !qn_client_lane_up && qn_live ())
	{
		if (qn_pin_set)
		{
			const uint16_t tags[1] = { 1 };
			const uint8_t *vals[1];
			uint16_t lens[1];
			uint8_t pl[64];
			size_t n;

			vals[0] = qn_pin_key;
			lens[0] = 32;
			n = qn_tlv_write (pl, sizeof (pl), tags, vals, lens, 1);
			if (n == 0 ||
			    qn_transport_send (&qn_tr, QN_T_JOIN_PIN, pl,
			                       (uint16_t) n) != 1)
			{
				qn_teardown ("join_pin send failed");
				return;
			}
		}
		else
		{
			/* spec 4.1: without a pinned key the lane is the
			 * explicit open-invite mode; say so, in fixed text */
			qn_note ("open invite: host impersonation not detectable");
		}
		if (qn_transport_send (&qn_tr, QN_T_JOIN_OPEN, qn_join_code,
		                       sizeof (qn_join_code)) != 1)
		{
			qn_teardown ("join_open send failed");
			return;
		}
		qn_client_lane_up = true;
		qn_client_was_connected = false;
		qn_join_pending = false;
	}

	if (qn_state != QN_RUNNING)
		return;		/* not authenticated: no frames are owed to us */

	budget = QN_PUMP_BUDGET;
	while (budget-- > 0)
	{
		r = qn_transport_recv (&qn_tr, &f);
		if (r == 0)
			break;
		if (r < 0)
		{
			qn_teardown (qn_tr.reason != NULL ? qn_tr.reason
			                              : "peer protocol failed");
			return;
		}
		qn_dispatch (&f);
		if (qn_tr.fd < 0 || qn_state != QN_RUNNING)
			return;	/* a dispatch tore us down */
	}
}

/*
 * --------------------------------------------------------- registration
 */

sys_socket_t QN_Init (void)
{
	if (!COM_CheckParm ("-qn"))
		return INVALID_SOCKET;

	memset (qn_sockets, 0, sizeof (qn_sockets));
	memset (&qn_tr, 0, sizeof (qn_tr));
	qn_tr.fd = -1;
	qn_listenfd = -1;
	qn_pump_ms = 0;
	qn_spawn_init (&qn_child);
	qn_state = QN_STANDBY;
	qn_daemon_retired = false;
	qn_wantlisten = false;
	Con_SafePrintf ("QN: p2pquake landriver standby\n");
	/* There is no control socket: the daemon owns the transport. The
	 * id must be OUT of the virtual socket table's range so the
	 * datagram layer's LAN-browse read of controlSock can never
	 * alias slot 0 -- every table access bounds-checks against
	 * MAX_QN_SOCKETS, making that read a provable no-op. */
	return (sys_socket_t) MAX_QN_SOCKETS;
}

void QN_Shutdown (void)
{
	if (qn_tr.fd >= 0)
		qn_transport_close (&qn_tr);
	if (qn_listenfd >= 0)
	{
		close (qn_listenfd);
		qn_listenfd = -1;
	}
	qn_spawn_stop (&qn_child);
	qn_zero_secret ();
	memset (qn_sockets, 0, sizeof (qn_sockets));
	qn_host_lane_up = qn_client_lane_up = qn_join_pending = false;
	qn_join_code_valid = false;
	qn_sv_was_active = false;
	qn_wantlisten = false;
	qn_state = QN_OFF;
}

void QN_Listen (qboolean state)
{
	qn_wantlisten = state;
}

sys_socket_t QN_OpenSocket (int port)
{
	int	i;

	/* A join-only boot must reach QN_Connect before any lane exists --
	 * that call is what arms the daemon. A pending join code therefore
	 * opens slots while the lane is down; the armed client's QN_Connect
	 * succeeds on the daemon spawn and its handshake rides the lane up,
	 * while any other caller fails fast until the lane is live. */
	if (!qn_live () && !(qn_join_pending && !qn_daemon_retired))
		return INVALID_SOCKET;

	for (i = 0; i < MAX_QN_SOCKETS; i++)
	{
		if (!qn_sockets[i].inuse)
		{
			memset (&qn_sockets[i], 0, sizeof (qn_sockets[i]));
			qn_sockets[i].inuse = true;
			qn_sockets[i].addr.family = QN_AF;
			qn_sockets[i].addr.lane = (unsigned short) i;
			qn_sockets[i].addr.port = (unsigned short) port;
			return i;
		}
	}
	return INVALID_SOCKET;
}

int QN_CloseSocket (sys_socket_t socketid)
{
	/* STANDBY must free too: join-bootstrap slots exist BEFORE the
	 * daemon authenticates (OpenSocket admits them on a parsed join
	 * code) and the datagram layer closes them when Connect fails
	 * fast -- refusing that close would strand the entry for the
	 * rest of the run, one per failed attempt. A memset of a free
	 * slot is benign, so only the fully-off posture refuses. */
	if (qn_state == QN_OFF)
		return SOCKET_ERROR;
	if (socketid < 0 || socketid >= MAX_QN_SOCKETS)
		return SOCKET_ERROR;
	/* memset of an already-free slot is a benign no-op: a duplicate
	 * Close_Socket verdict from the datagram layer closes nothing twice */
	memset (&qn_sockets[socketid], 0, sizeof (qn_sockets[socketid]));
	return 0;
}

int QN_Connect (sys_socket_t socketid, struct qsockaddr *addr)
{
	qboolean isclient;
	qboolean armed_join = false;

	if (socketid < 0 || socketid >= MAX_QN_SOCKETS)
		return SOCKET_ERROR;
	if (((const qnqsockaddr_t *) addr)->family != QN_AF)
		return SOCKET_ERROR;
	/* Lane role by process role, not by call site: the datagram layer
	 * also calls Connect on the ACCEPT side (a new server-side socket
	 * per inbound player), and framing that output as CLIENT_CMD would
	 * put the horse before the cart. A process is host or client for a
	 * session, decided by which lane frames the engine established. */
	isclient = !(qn_host_lane_up || (qn_wantlisten && sv.active));
	if (isclient && !qn_join_pending && qn_join_code_valid &&
	    qn_client_was_connected)
	{
		/* Reconnect (classic 'reconnect' stufftext, CL budget retries):
		 * the datagram layer reuses the cached address and skips the
		 * string parse, so no fresh demand arrives by itself. Only an
		 * engine that actually played can mean this: a Connect retry
		 * of a still-pending join (lane armed, JOIN_OK not home) must
		 * not retire the in-flight lane and re-join it in a storm. */
		qn_join_pending = true;
	}
	if (isclient && qn_client_lane_up && qn_join_pending)
	{
		/* Reconnect: a fresh code parse while a client lane is
		 * still marked up. CL_Disconnect and CL_Connect run in
		 * one command buffer, so the pump-side disconnect edge
		 * cannot fire; retire the lane here, synchronously, or
		 * every reconnect rides a phantom lane whose daemon side
		 * silently drops the handshake. */
		(void) qn_transport_send (&qn_tr, QN_T_JOIN_CLOSE, NULL, 0);
		qn_client_lane_up = false;
		qn_client_was_connected = false;
	}
	if (!qn_live () || (isclient && !qn_client_lane_up && qn_join_pending))
	{
		/* Join bootstrap: a client connect against a parsed join
		 * code is what summons the daemon -- arming cannot sit
		 * behind a lane only the daemon can create. Every such
		 * call still fails fast until the lane is live, so the
		 * datagram layer's retry loop never spins a dead pipe
		 * authenticates). A join-arm instead succeeds: the
		 * datagram layer's connect handshake -- three CCREQ
		 * rounds, 2.5 s apart -- is the retry vehicle, and
		 * QN_Read services the lane while that loop spins (the
		 * frame-loop pump cannot run from in there). A code
		 * that never joins a room fails as the handshake's
		 * honest "No Response" once its budget is spent. */
		if (isclient && qn_join_pending && !qn_daemon_retired)
		{
			if (!qn_client_lane_up)
				qn_demand++;	/* fresh demand: re-arm the latch */
			if (!qn_ensure_daemon ())
				return SOCKET_ERROR;	/* daemon impossible */
			armed_join = true;	/* lane rides the handshake */
		}
		else
			return SOCKET_ERROR;
	}
	if (!isclient)
	{
		/* The UDP shape of this call is "accept socket == the socket
		 * the player keeps using". Our CheckNewConnections handed out
		 * the introduced slot, but the datagram layer then opens a
		 * fresh slot and Connects it with that same address: adopt
		 * the introduced slot's queues and retire it, so continuing
		 * CL_DATA arrivals (keyed by pubkey) reach the live socket. */
		const qnqsockaddr_t *a = (const qnqsockaddr_t *) addr;
		int from;

		qn_gc_dead_aliases (a->key);
		from = qn_slot_by_key (a->key);
		if (from >= 0 && from != (int) socketid)
		{
			qn_sockets[socketid] = qn_sockets[from];
			memset (&qn_sockets[from], 0, sizeof (qn_sockets[from]));
			/* leave a forwarding slot behind: the datagram
			 * layer writes its accept reply via the old id */
			qn_sockets[from].inuse = true;
			qn_sockets[from].alias = true;
			qn_sockets[from].aliasof = (int) socketid;
			/* keep the identity: the PEER_DOWN sweep and the
			 * dead-forwarding sweep both match on addr.key,
			 * and a zeroed forwarding slot is invisible to
			 * both -- it would strand its entry for the run */
			qn_sockets[from].addr = *(const qnqsockaddr_t *) addr;
			qn_sockets[from].addr.lane = (unsigned short) from;
		}
	}
	qn_sockets[socketid].addr = *(const qnqsockaddr_t *) addr;
	qn_sockets[socketid].connect_addr = qn_sockets[socketid].addr;
	qn_sockets[socketid].isclient = isclient;
	/* An armed join already spawned (or found living) its daemon
	 * above; asking again would hit the demand latch's false verdict
	 * and kill a connect that has its whole service model ahead. */
	if (!armed_join)
	{
		if (!qn_client_lane_up)
			qn_demand++;	/* fresh demand: re-arm the latch */
		if (!qn_ensure_daemon ())
			return SOCKET_ERROR;
		if (!qn_live ())
			return SOCKET_ERROR;	/* armed but not authenticated
						   yet: a frame loop exists on
						   this path, so the pump can
						   raise the lane and the
						   caller may retry */
	}
	return 0;
}

/* The accept path reads exactly one datagram and rejects anything that
 * is not control-class, taking the offer down with it. Only present a
 * slot whose queue head is such a datagram; an ACK parked ahead of a
 * re-dial request must not burn the offer -- listening stays armed and
 * the next pump retries. */
static qboolean qn_head_is_ctl (const qn_socket_t *s)
{
	const uint8_t *e;
	uint32_t word;
	size_t n;

	if (s->qh == s->qt)
		return false;
	n = s->qlen[s->qh];
	if (n < 4)
		return false;
	e = s->q[s->qh];
	word = ((uint32_t) e[0] << 24) | ((uint32_t) e[1] << 16) |
	       ((uint32_t) e[2] << 8) | (uint32_t) e[3];
	return ((word & ~0xffffu) == (uint32_t) NETFLAG_CTL) ? true : false;
}

sys_socket_t QN_CheckNewConnections (void)
{
	int	i;

	if (!qn_live () || !qn_wantlisten)
		return INVALID_SOCKET;

	for (i = 0; i < MAX_QN_SOCKETS; i++)
	{
		if (qn_sockets[i].inuse && qn_sockets[i].listening &&
		    !qn_sockets[i].alias)
		{
			if (qn_sockets[i].ccreq_ready)
			{
				/* held connect request: QN_Read serves
				 * it and clears the offer marks there */
				qn_sockets[i].ccreq_offer = true;
				return i;
			}
			if (qn_head_is_ctl (&qn_sockets[i]))
			{
				qn_sockets[i].listening = false;
				return i;
			}
			/* head is session traffic (a parked ACK): stay
			 * listening -- an offer would be burned; the
			 * next pump retries */
		}
	}
	return INVALID_SOCKET;
}

int QN_Read (sys_socket_t socketid, byte *buf, int len, struct qsockaddr *addr)
{
	qn_socket_t	*s;
	size_t		n;

	/* Service the transport on demand. The datagram layer's connect
	 * handshake spins inside this read -- trying, still trying --
	 * while the frame-loop pump hook cannot run from in there, so
	 * auth, the join, and the connect reply would all starve behind
	 * a lane nobody is feeding. A landriver that owns its daemon
	 * feeds its own queues; the work is bounded per call by the
	 * pump's budget and a no-op posture (QN_OFF, no child, retired
	 * daemon) does nothing but return. */
	QN_Pump ((unsigned long long) (Sys_DoubleTime () * 1000.0));
	if (!qn_live ())
		return 0;		/* no data, no verdict -- never claim a death */
	if (socketid < 0 || socketid >= MAX_QN_SOCKETS)
		return SOCKET_ERROR;
	s = &qn_sockets[socketid];
	if (!s->inuse)
		return SOCKET_ERROR;
	if (s->alias)
		return 0;		/* forwarding slot: it queues nothing itself */
	if (s->dead)
	{
		/* one -1 report: the datagram layer records the drop */
		s->dead = false;
		s->inuse = false;
		return -1;
	}
	if (s->ccreq_ready && s->ccreq_offer)
	{
		/* bytes of a held connect request -- they never entered
		 * the session queue; only this offered read takes them
		 * out */
		/* a delivery that cannot fit leaves the hold armed (the
		 * next offered read retries); the accept path always
		 * passes a full-datagram buffer, so this refusal is
		 * contract-violation territory */
		if (s->ccreq_n > (size_t) len)
			return SOCKET_ERROR;
		s->ccreq_ready = false;
		s->ccreq_offer = false;
		s->listening = false;
		memcpy (buf, s->ccreq, s->ccreq_n);
		memcpy (addr, &s->addr, sizeof (*addr));
		return (int) s->ccreq_n;
	}
	if (s->qh == s->qt)
		return 0;		/* queue empty */
	n = s->qlen[s->qh];
	{
		const uint8_t *e = s->q[s->qh];
		uint32_t word = ((uint32_t) e[0] << 24) | ((uint32_t) e[1] << 16) |
		              ((uint32_t) e[2] << 8) | (uint32_t) e[3];
		/* The datagram layer trusts the declared length for its
		 * copies; at this boundary an entry whose header disagrees
		 * with its size is refused outright. A control datagram
		 * carries the four-byte header slot plus its command bytes
		 * (browse and player requests are five to seven total);
		 * every other class carries the eight-byte reliable
		 * header. */
		{
			size_t floor =
			    ((word & ~0xffffu) == (uint32_t) NETFLAG_CTL)
			    ? (size_t) 4 : (size_t) NET_HEADERSIZE;
			if (n < floor || (word & 0xffffu) != (uint32_t) n)
			{
				qn_queue_drops++;	/* lying or runt */
				s->qh = (s->qh + 1) % QN_QDEPTH;
				return 0;	/* no verdict; next read takes
						   the next entry */
			}
		}
	}
	if (n > (size_t) len)
		n = (size_t) len;
	memcpy (buf, s->q[s->qh], n);
	s->qh = (s->qh + 1) % QN_QDEPTH;
	memcpy (addr, &s->connect_addr, sizeof (*addr));
	return (int) n;
}

int QN_Write (sys_socket_t socketid, byte *buf, int len, struct qsockaddr *addr)
{
	const qn_socket_t	*s;
	uint8_t			payload[4 + QN_WIRE_MAX + 40];
	const uint16_t		tags_dat[1] = { 1 };
	const uint16_t		tags_sv[2] = { 1, 2 };
	const uint16_t		*tag;
	const uint8_t		*vals[2];
	uint16_t		lens[2];
	uint16_t		type;
	size_t			n;

	(void) addr;
	if (!qn_live ())
		return SOCKET_ERROR;
	if (socketid < 0 || socketid >= MAX_QN_SOCKETS)
		return SOCKET_ERROR;
	s = &qn_sockets[socketid];
	if (!s->inuse)
		return SOCKET_ERROR;
	if (s->alias)
		s = &qn_sockets[s->aliasof];	/* forwarding slot: the accepted
					   player's live queue is there */
	if (!s->inuse)
		return SOCKET_ERROR;
	if (len < 0 || len > QN_WIRE_MAX)
	{	/* negative is a contract violation upstream, not traffic:
	     * (uint16_t)len would smuggle it past the size gate */
		qn_queue_drops++;	/* the daemon would reject it anyway */
		return SOCKET_ERROR;
	}
	if (s->isclient)
	{
		/* client datagrams ride CLIENT_CMD tag 0x0001 */
		type = QN_T_CLIENT_CMD;
		tag = tags_dat;
		vals[0] = buf;
		lens[0] = (uint16_t) len;
		n = qn_tlv_write (payload, sizeof (payload), tag, vals, lens, 1);
	}
	else
	{
		/* host server output rides SV_DATA tags {1,2}: the slot's
		   peer key plus body. Broadcasting would let a stranger's
		   DATA chunk drain another player's reliable window (every
		   DATA is ACKed the moment it arrives). */
		int j;
		qboolean stamped = false;
		for (j = 0; j < 32; j++)
		{
			if (s->peer32[j])
			{
				stamped = true;
				break;
			}
		}
		if (!stamped)
		{
			qn_queue_drops++;
			return SOCKET_ERROR;
		}
		type = QN_T_SV_DATA;
		vals[0] = s->peer32;
		lens[0] = 32;
		vals[1] = buf;
		lens[1] = (uint16_t) len;
		n = qn_tlv_write (payload, sizeof (payload), tags_sv, vals, lens, 2);
	}
	if (n == 0)
		return SOCKET_ERROR;
	if (qn_transport_send (&qn_tr, type, payload, (uint16_t) n) != 1)
		return SOCKET_ERROR;
	return len;
}

int QN_Broadcast (sys_socket_t socketid, byte *buf, int len)
{
	return 0;	/* LAN discovery belongs to the UDP landriver */
}

const char *QN_AddrToString (struct qsockaddr *addr)
{
	static char		buffer[32];
	const qnqsockaddr_t	*a = (const qnqsockaddr_t *) addr;
	int			i;
	char			keyhex[17];

	if (a->family != QN_AF)
		q_strlcpy (buffer, "qn:?", sizeof (buffer));
	else
	{
		for (i = 0; i < 8; i++)
			q_snprintf (keyhex + i * 2, 3, "%02x", a->key[i]);
		keyhex[16] = '\0';
		q_snprintf (buffer, sizeof (buffer), "qn:%s:%u", keyhex,
		            (unsigned int) a->port);
	}
	return buffer;
}

int QN_StringToAddr (const char *string, struct qsockaddr *addr)
{
	qnqsockaddr_t	*a = (qnqsockaddr_t *) addr;
	unsigned int	keywords[2];
	unsigned int	port;
	char		rest[32];
	const char	*body;
	size_t		bl;
	int		n, k, dashes = 0;
	qboolean	codey = false;

	if (q_strncasecmp (string, "qn:", 3) != 0)
		return -1;
	memset (a, 0, sizeof (*a));
	a->family = QN_AF;

	/* join-code display form: qn:XXXX-XXXX-XXXX-XXXX. The hyphens
	 * are the discriminator -- an identity-key form never carries
	 * one, so the two grammars cannot be confused (spec 5.1). */
	body = string + 3;
	bl = strlen (body);
	for (k = 0; k < (int) bl; k++)
	{
		if (body[k] == '-')
			dashes++;
		else if (crockford_value ((unsigned char) body[k]) >= 16)
			codey = true;	/* contains a non-hex Crockford letter */
	}
	if (codey || dashes > 0)
	{
		if (dashes > 0)
		{
			/* the hyphenated display form is exactly 4-4-4-4
			 * (spec 5.1); any other hyphen placement is not a
			 * code, and rejecting it keeps a mistyped key
			 * (with a stray dash) from becoming one */
			if (bl != 19 || body[4] != '-' || body[9] != '-' ||
			    body[14] != '-')
				return -1;
		}
		if (qn_pin_malformed)
			return -1;	/* fail closed on a bad pin */
		if (!crockford_decode16 (body, bl, qn_join_code))
			return -1;
		qn_join_pending = true;
		qn_join_code_valid = true;
		a->port = (unsigned short) net_hostport;
		return 0;
	}

	/* canonical key form: qn:<16hex>:<port> or port-stripped */
	rest[0] = '\0';
	n = sscanf (string + 3, "%8x%8x:%u%31s",
	            &keywords[0], &keywords[1], &port, rest);
	if (n < 3 || rest[0] != '\0')
	{
		/* Not the canonical full form: take the port-stripped one
		 * the datagram layer hands over after its port splitting. */
		rest[0] = '\0';
		n = sscanf (string + 3, "%8x%8x%31s",
		            &keywords[0], &keywords[1], rest);
		if (n != 2 || rest[0] != '\0')
			return -1;
		port = (unsigned int) net_hostport;
	}
	if (port > 0xffffu)
		return -1;
	a->port = (unsigned short) port;
	for (k = 0; k < 4; k++)
	{
		a->key[k] = (unsigned char) (keywords[0] >> (24 - k * 8));
		a->key[k + 4] = (unsigned char) (keywords[1] >> (24 - k * 8));
	}
	return 0;
}

int QN_GetSocketAddr (sys_socket_t socketid, struct qsockaddr *addr)
{
	if (socketid < 0 || socketid >= MAX_QN_SOCKETS)
		return -1;
	if (!qn_sockets[socketid].inuse)
		return -1;
	*(qnqsockaddr_t *) addr = qn_sockets[socketid].addr;
	return 0;
}

int QN_GetNameFromAddr (struct qsockaddr *addr, char *name)
{
	q_strlcpy (name, QN_AddrToString (addr), NET_NAMELEN);
	return 0;
}

static void qn_read_pin_parm (void)
{
	const char *hx;
	int p, k, v;
	qboolean ok;

	if (qn_pin_set || qn_pin_malformed)
		return;
	p = COM_CheckParm ("-qn-pin");
	if (!p || p >= com_argc - 1)
		return;
	hx = com_argv[p + 1];
	if (strlen (hx) != 64)
	{
		qn_pin_malformed = true;
		return;
	}
	ok = true;
	for (k = 0; k < 64 && ok; k++)
	{
		char c = hx[k];
		if (c >= '0' && c <= '9')
			v = c - '0';
		else if (c >= 'a' && c <= 'f')
			v = c - 'a' + 10;
		else if (c >= 'A' && c <= 'F')
			v = c - 'A' + 10;
		else
			ok = false;
		if (!ok)
			break;
		if (k % 2 == 0)
			qn_pin_key[k / 2] = (uint8_t) (v << 4);
		else
			qn_pin_key[k / 2] |= (uint8_t) v;
	}
	if (!ok)
	{
		memset (qn_pin_key, 0, sizeof (qn_pin_key));
		qn_pin_malformed = true;
		return;
	}
	qn_pin_set = true;
}

int QN_GetAddrFromName (const char *name, struct qsockaddr *addr)
{
	/* Accepts "qn:<16hex>[:port]" and the join-code display form
	 * "qn:XXXX-XXXX-XXXX-XXXX"; every other name stays with the UDP
	 * landriver. The join code must be entered with the qn: prefix.
	 *
	 * The connect path once fed every name through Strip_Port before
	 * consulting a landriver, which cut the qn: form at its own
	 * prefix ("Could not resolve qn" -- the form this landriver is
	 * named for could never arrive) and let a digit-started code's
	 * leading run be adopted as net_hostport. Strip_Port now passes
	 * qn: strings intact (see the guard in net_dgrm.c). The optional
	 * ":port" tail belongs to the key form only -- the parsers below
	 * own it, and an out-of-range port tail leaves net_hostport at
	 * its previous value here; the hyphenated display form is exactly
	 * 4-4-4-4 (spec 5.1) and carries no tail. */
	qn_read_pin_parm ();
	if (QN_StringToAddr (name, addr) != 0)
		return -1;
	qn_demand++;		/* a typed connect is a fresh demand */
	return 0;
}

int QN_AddrCompare (struct qsockaddr *addr1, struct qsockaddr *addr2)
{
	const qnqsockaddr_t *a = (const qnqsockaddr_t *) addr1;
	const qnqsockaddr_t *b = (const qnqsockaddr_t *) addr2;

	if (a->family != b->family)
		return -1;
	/* Identity is (key, port): the lane field names the table slot,
	 * which the datagram layer legitimately reassigns between accept
	 * and connect, so comparing it would forge its own traffic. The
	 * key carries the full weight: 8 bytes of a verified pubkey
	 * (2^32 work to collide), and it is never attacker-chosen -- the
	 * daemon tags frame senders from Noise-verified plane B identities. */
	if (memcmp (a->key, b->key, sizeof (a->key)) != 0)
		return -1;
	if (a->port != b->port)
		return 1;
	return 0;
}

int QN_GetSocketPort (struct qsockaddr *addr)
{
	return (int) ((qnqsockaddr_t *) addr)->port;
}

int QN_SetSocketPort (struct qsockaddr *addr, int port)
{
	((qnqsockaddr_t *) addr)->port = (unsigned short) port;
	return 0;
}

int QN_PollFd (sys_socket_t socketid)
{
	/* Readiness is the plane A fd: every queued byte this slot could
	 * report arrives through that one pipe. The slot bounds check is
	 * the contract; the fd itself is lane-global. */
	if (socketid < 0 || socketid >= MAX_QN_SOCKETS)
		return -1;
	if (qn_state == QN_OFF || !qn_sockets[socketid].inuse)
		return -1;
	return qn_tr.fd;
}
