/* qn_winsock_win.c — winsock lifetime for the Windows engine build.
 *
 * The win64 link uses the BSD UDP landriver (net_bsd.c + net_udp.c), the
 * only landriver whose table the qn registration (qn-patches/0007)
 * extends. net_wins.c — the vendored file that owns the only WSAStartup
 * call — is NOT linked, so no one ever initializes winsock and every
 * socket/gethostname call fails WSANOTINITIALISED, disabling UDP.
 *
 * Winsock must be up before NET_Init opens its control socket, and the
 * UDP landriver initializes first in net_landrivers[], so no later hook
 * can cover it: this runs as a load-time constructor. A failure here is
 * left silent — the engine's own UDP_Init diagnostics report it exactly
 * as before. WSACleanup is intentionally not registered: the OS tears
 * down winsock handles at process exit and quakespasm's shutdown path
 * was never written to expect mid-run deinitialization.
 */
#ifdef _WIN32

#include <winsock2.h>

__attribute__((constructor))
static void qnw_winsock_startup(void)
{
	WSADATA wsa;
	(void)WSAStartup(MAKEWORD(2, 2), &wsa);
}

#endif
