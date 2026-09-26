#ifndef __net_qn_h
#define __net_qn_h

/* These three are the same preamble net_qn.c itself compiles under:
 * net_sys.h branches on the platform macros arch_def.h provides. */
#include "q_stdinc.h"
#include "arch_def.h"
#include "net_sys.h"
struct qsockaddr;

/* DATA-payload ceiling advertised to the datagram layer: the relay-body
 * cap (protocol spec, plane B caps table) minus the 8-byte datagram
 * header, so every datagram fits exactly one relay body end to end. */
#define QN_DATAGRAM_MAX	1092

typedef enum
{
	QN_OFF = 0,		/* landriver not initialized (-no-qn on the command line) */
	QN_STANDBY,		/* registered; no authenticated local peer yet:
			   every data-plane operation refuses */
	QN_RUNNING		/* local qn-peer authenticated on Plane A;
			   virtual sockets may open, read and write */
} qn_state_t;

sys_socket_t  QN_Init (void);
void QN_Shutdown (void);
void QN_Listen (qboolean state);

/* Grouped join code for the host page (spec 5.1 display surface), or ""
 * when no room is currently announced. */
const char *QN_JoinCodeText (void);

/* Host-page Visibility row state (spec 5.1): private until the host says
 * otherwise; the pump drives announce/withdraw off it live. */
void QN_SetHostPublic (qboolean v);
qboolean QN_GetHostPublic (void);
void QN_Visibility_f (void);

/* public lobby view (spec 3.6; adverts arrive daemon-verified) */
void QN_LobbyWatch (void);
void QN_LobbyUnwatch (void);
int  QN_LobbyCount (void);
qboolean QN_LobbyHave (void);
const char *QN_LobbyName (int i);
const char *QN_LobbyMap (int i);
int  QN_LobbyMode (int i);
int  QN_LobbyPlayers (int i);
int  QN_LobbyMax (int i);
int  QN_LobbyMine (int i);
int  QN_LobbyCodeGrouped (int i, char *out, size_t outlen);
void QN_Status_f (void);
sys_socket_t  QN_OpenSocket (int port);
int  QN_CloseSocket (sys_socket_t socketid);
int  QN_Connect (sys_socket_t socketid, struct qsockaddr *addr);
sys_socket_t  QN_CheckNewConnections (void);
int  QN_Read (sys_socket_t socketid, byte *buf, int len, struct qsockaddr *addr);
int  QN_Write (sys_socket_t socketid, byte *buf, int len, struct qsockaddr *addr);
int  QN_Broadcast (sys_socket_t socketid, byte *buf, int len);
const char *QN_AddrToString (struct qsockaddr *addr);
int  QN_StringToAddr (const char *string, struct qsockaddr *addr);
int  QN_GetSocketAddr (sys_socket_t socketid, struct qsockaddr *addr);
int  QN_GetNameFromAddr (struct qsockaddr *addr, char *name);
int  QN_GetAddrFromName (const char *name, struct qsockaddr *addr);
int  QN_AddrCompare (struct qsockaddr *addr1, struct qsockaddr *addr2);
int  QN_GetSocketPort (struct qsockaddr *addr);
int  QN_SetSocketPort (struct qsockaddr *addr, int port);
int  QN_PollFd (sys_socket_t socketid);

/* Module state. The state is driven by the Plane A lifecycle hooks in
 * main_sdl.c: STANDBY after the landriver initializes, RUNNING once the
 * engine's own qn-peer child has passed the AUTH gate. Everything but
 * statekeeping refuses unless RUNNING. */
void QN_SetState (qn_state_t state);
qn_state_t QN_GetState (void);

/* Drive the Plane A session once per frame (called from main_sdl.c's
 * host loops). Non-blocking: bounded frame budget, no sleeping, no
 * spawning until a lane actually demands the daemon. now_ms is any
 * monotonic millisecond clock. */
void QN_Pump (unsigned long long now_ms);

/* Spec 6.4 dispatch: game-protocol svc_stufftext (cl_parse.c) reaches the
 * console only through here; the allowlist predicate is qn_stext.h. */
void QN_StufftextFromGame (const char *line);

/* Join-page honest failure surface: the landriver remembers the last
 * daemon FATAL cause seen on a joiner lane as a fixed literal
 * (qn_causes.h, spec 6.3). Valid from that FATAL until the next qn: dial
 * attempt. */
const char *QN_JoinCauseText (void);		/* fixed literal or NULL */
void QN_JoinAttemptReset (void);

#endif	/* __net_qn_h */
