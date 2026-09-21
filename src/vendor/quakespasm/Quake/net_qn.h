#ifndef __net_qn_h
#define __net_qn_h

#include "net_sys.h"
struct qsockaddr;

typedef enum
{
	QN_OFF = 0,		/* landriver not initialized (no -qn on the command line) */
	QN_STANDBY,		/* registered; no authenticated local peer yet:
			   every data-plane operation refuses */
	QN_RUNNING		/* local qn-peer authenticated on Plane A;
			   virtual sockets may open, read and write */
} qn_state_t;

sys_socket_t  QN_Init (void);
void QN_Shutdown (void);
void QN_Listen (qboolean state);
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

/* Module state. The state is driven by the Plane A lifecycle hooks in
 * main_sdl.c: STANDBY after the landriver initializes, RUNNING once the
 * engine's own qn-peer child has passed the AUTH gate. Everything but
 * statekeeping refuses unless RUNNING. */
void QN_SetState (qn_state_t state);
qn_state_t QN_GetState (void);

#endif	/* __net_qn_h */
