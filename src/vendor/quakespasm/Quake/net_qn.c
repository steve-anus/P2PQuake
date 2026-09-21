/*
 * net_qn.c -- p2pquake landriver: virtual sockets for the local qn-peer
 * daemon. All game traffic over this driver travels through the engine's
 * own qn-peer child over the Plane A Unix-domain socket (the frame
 * grammar is src/protocol/qn_protocol.md); the daemon owns every remote
 * byte. This file holds the driver plumbing: the virtual socket table
 * and the address model.
 *
 * Default posture: absent. Without -qn on the command line QN_Init
 * returns INVALID_SOCKET and the datagram layer skips the driver
 * entirely. With -qn the driver initializes into QN_STANDBY, where
 * every data-plane operation refuses; the spawn and pump hooks move it
 * to QN_RUNNING only after the local daemon has passed the AUTH gate.
 */

#include "q_stdinc.h"
#include "arch_def.h"
#include "net_sys.h"
#include "quakedef.h"
#include "net_defs.h"

#include "net_qn.h"

/* Synthetic address family tag: no Linux/BSD AF_* occupies 'q'. The
 * datagram layer only ever passes struct qsockaddr through, so any
 * private value that cannot collide works; identity comes from
 * AddrCompare below. */
#define QN_AF 0x71

#define MAX_QN_SOCKETS 16

/* Layout mirrors struct qsockaddr (net_defs.h): short family + 14 data
 * bytes. Key holds the first eight bytes of the remote identity key --
 * grinding a collision costs ~2^32 keypairs, far past the eight-player
 * table this driver serves. */
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
	qboolean	listening;
	qnqsockaddr_t	addr;
} qn_socket_t;

static qn_socket_t	qn_sockets[MAX_QN_SOCKETS];
static qn_state_t	qn_state = QN_OFF;
static qboolean	qn_wantlisten = false;

void QN_SetState (qn_state_t state)
{
	qn_state = state;
}

qn_state_t QN_GetState (void)
{
	return qn_state;
}

/* Only ever true from the RUNNING window, so no virtual socket can
 * exist while the module stands by -- the data-plane refusals below are
 * belt-and-braces, not reachable policy surfaces. */
static qboolean qn_live (void)
{
	return qn_state == QN_RUNNING;
}

sys_socket_t QN_Init (void)
{
	if (!COM_CheckParm ("-qn"))
		return INVALID_SOCKET;

	memset (qn_sockets, 0, sizeof (qn_sockets));
	qn_state = QN_STANDBY;
	qn_wantlisten = false;
	Con_SafePrintf ("QN: p2pquake landriver standby\n");
	/* There is no control socket: the daemon owns the transport. The
	 * id must be OUT of the virtual socket table's range so the
	 * datagram layer's LAN-browse read of controlSock can never alias
	 * slot 0 -- every table access bounds-checks against
	 * MAX_QN_SOCKETS, making that read a provable no-op. */
	return (sys_socket_t) MAX_QN_SOCKETS;
}

void QN_Shutdown (void)
{
	memset (qn_sockets, 0, sizeof (qn_sockets));
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

	if (!qn_live ())
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
	if (socketid < 0 || socketid >= MAX_QN_SOCKETS)
		return SOCKET_ERROR;
	memset (&qn_sockets[socketid], 0, sizeof (qn_sockets[socketid]));
	return 0;
}

int QN_Connect (sys_socket_t socketid, struct qsockaddr *addr)
{
	if (!qn_live ())
		return SOCKET_ERROR;
	if (socketid < 0 || socketid >= MAX_QN_SOCKETS)
		return SOCKET_ERROR;
	if (((const qnqsockaddr_t *) addr)->family != QN_AF)
		return SOCKET_ERROR;
	qn_sockets[socketid].addr = *(const qnqsockaddr_t *) addr;
	return 0;
}

sys_socket_t QN_CheckNewConnections (void)
{
	int	i;

	if (!qn_live () || !qn_wantlisten)
		return INVALID_SOCKET;

	/* Inbound virtual sockets appear here once the pump feeds peer
	 * introductions; no table slot is ever marked ready before that. */
	for (i = 0; i < MAX_QN_SOCKETS; i++)
	{
		if (qn_sockets[i].inuse && qn_sockets[i].listening)
		{
			qn_sockets[i].listening = false;
			return i;
		}
	}
	return INVALID_SOCKET;
}

int QN_Read (sys_socket_t socketid, byte *buf, int len, struct qsockaddr *addr)
{
	if (!qn_live ())
		return 0;	/* no data, no verdict -- never claim a death */
	if (socketid < 0 || socketid >= MAX_QN_SOCKETS)
		return SOCKET_ERROR;
	if (!qn_sockets[socketid].inuse)
		return SOCKET_ERROR;
	/* Delivery queues fill from the Plane A pump; nothing can be
	 * queued before RUNNING, and the pump lands with the hooks that
	 * set RUNNING, so a standby read is structurally unreachable. */
	return 0;
}

int QN_Write (sys_socket_t socketid, byte *buf, int len, struct qsockaddr *addr)
{
	if (!qn_live ())
		return SOCKET_ERROR;
	if (socketid < 0 || socketid >= MAX_QN_SOCKETS)
		return SOCKET_ERROR;
	if (!qn_sockets[socketid].inuse)
		return SOCKET_ERROR;
	/* The pump frames buf as SV_DATA / CLIENT_CMD / RELIABLE by role.
	 * Same reachability argument as QN_Read: refused unless RUNNING. */
	return SOCKET_ERROR;
}

int QN_Broadcast (sys_socket_t socketid, byte *buf, int len)
{
	return 0;	/* LAN discovery belongs to the UDP landriver */
}

const char *QN_AddrToString (struct qsockaddr *addr)
{
	static char	buffer[32];
	const qnqsockaddr_t *a = (const qnqsockaddr_t *) addr;
	int		i;
	char		keyhex[17];

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
	int		n;
	int		i;

	if (q_strncasecmp (string, "qn:", 3) != 0)
		return -1;
	/* Accept both the canonical "qn:<16hex>:<port>" this driver emits
	 * and the port-less "qn:<16hex>" the datagram layer hands over
	 * after its port stripping. The trailing %31s slot makes either
	 * form reject trailing garbage: a clean parse leaves it empty, so
	 * sscanf has matched no field for it. */
	rest[0] = '\0';
	n = sscanf (string + 3, "%8x%8x:%u%31s",
	            &keywords[0], &keywords[1], &port, rest);
	if (n < 3 || rest[0] != '\0')
	{
		/* Not the canonical full form: take the port-stripped one the
		 * datagram layer hands over after its port splitting. */
		rest[0] = '\0';
		n = sscanf (string + 3, "%8x%8x%31s",
		            &keywords[0], &keywords[1], rest);
		if (n != 2 || rest[0] != '\0')
			return -1;
		port = (unsigned int) net_hostport;
	}
	if (port > 0xffffu)
		return -1;
	memset (a, 0, sizeof (*a));
	a->family = QN_AF;
	a->port = (unsigned short) port;
	for (i = 0; i < 4; i++)
	{
		a->key[i] = (unsigned char) (keywords[0] >> (24 - i * 8));
		a->key[i + 4] = (unsigned char) (keywords[1] >> (24 - i * 8));
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

int QN_GetAddrFromName (const char *name, struct qsockaddr *addr)
{
	/* Only the canonical "qn:" form resolves here; every other name
	 * stays with the UDP landriver (join-code resolution arrives
	 * with the pump hooks).
	 * Known datagram-layer interaction: the connect path splits the
	 * name at its LAST colon before asking any landriver, so an
	 * all-decimal key (e.g. "qn:1234567890123456") is cut at the
	 * "qn:" colon itself: the remainder reaches UDP as a host named
	 * "qn" and the decimal tail can overwrite net_hostport. Identity
	 * keys are pubkey hashes -- sixteen digits with no hex letter a-f
	 * is not a realistic key, but if one ever must be typed, enter
	 * it with an explicit ":port". An out-of-range ":port" tail
	 * likewise leaves net_hostport at its previous value here. */
	return QN_StringToAddr (name, addr);
}

int QN_AddrCompare (struct qsockaddr *addr1, struct qsockaddr *addr2)
{
	const qnqsockaddr_t *a = (const qnqsockaddr_t *) addr1;
	const qnqsockaddr_t *b = (const qnqsockaddr_t *) addr2;

	if (a->family != b->family)
		return -1;
	if (a->lane != b->lane || memcmp (a->key, b->key, sizeof (a->key)) != 0)
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
