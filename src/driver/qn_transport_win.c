/* qn_transport_win.c — named-pipe Plane A (see qn_transport_win.h).
 * Security: DACL = current user + LocalSystem only, remote clients
 * rejected; the accept gate additionally demands the connecting process
 * image equal the expected daemon path armed via qnw_expect_peer. The
 * in-band AUTH token stays the authoritative gate; these bound who can
 * reach it. */
#include "qn_transport_win.h"

/* Keep the translation unit non-empty for the unix build of the same
 * directory (every definition below is _WIN32-only). */
typedef struct qnw_keepalive { int only_a_type; } qnw_keepalive_t;

#ifdef _WIN32

#include <windows.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define QNW_PIPE_MAX 128
#define QNW_OUT_BUF 65536u
#define QNW_IN_BUF  8192u

typedef struct {
    HANDLE h;         /* listener: pipe instance; connection: same handle */
    int kind;         /* 0 free, 1 listener, 2 connection */
    int owner;        /* connection -> listener slot; -1 otherwise */
    int armed;        /* listener: ConnectNamedPipe outstanding */
    OVERLAPPED conn;  /* listener connect completion */
} qnw_slot_t;

static qnw_slot_t g_slots[QNW_PIPE_MAX];
static char g_expected[4096]; /* normalized; empty = accept refuses all */

static void qnw_norm(const char *in, char *out, size_t outlen)
{
    char tmp[4096];
    size_t j = 0;

    out[0] = '\0';
    if (GetLongPathNameA(in, tmp, sizeof tmp) == 0)
        snprintf(tmp, sizeof tmp, "%s", in);
    if (strncmp(tmp, "\\\\?\\", 4) == 0)
        memmove(tmp, tmp + 4, strlen(tmp + 4) + 1);
    for (size_t i = 0; tmp[i] != '\0' && j + 1 < outlen; i++)
        out[j++] = (tmp[i] >= 'a' && tmp[i] <= 'z') ? (char)(tmp[i] - 32) : tmp[i];
    out[j] = '\0';
}

static qnw_slot_t *qnw_alloc(void)
{
    for (int i = 0; i < QNW_PIPE_MAX; i++)
        if (g_slots[i].kind == 0)
            return &g_slots[i];
    return NULL;
}

static int qnw_id(const qnw_slot_t *s)
{
    return (int)(s - g_slots);
}

void qnw_expect_peer(const char *abs_image)
{
    if (abs_image == NULL || abs_image[0] == '\0')
        g_expected[0] = '\0';
    else
        qnw_norm(abs_image, g_expected, sizeof g_expected);
}

static int owner_sd(SECURITY_ATTRIBUTES *sa, PSECURITY_DESCRIPTOR *desc)
{
    /* D:P(A;;GA;;;SY)(A;;GA;;;<user SID>): system + us, nothing else;
     * protected DACL so an inheritable parent grants nothing. */
    TOKEN_USER *tu;
    HANDLE tok;
    DWORD got;
    char *sid_str = NULL;
    char sddl[512];
    char sid[256];

    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok))
        return -1;
    tu = (TOKEN_USER *)malloc(1024);
    if (tu == NULL || !GetTokenInformation(tok, TokenUser, tu, 1024, &got)) {
        free(tu);
        CloseHandle(tok);
        return -1;
    }
    CloseHandle(tok);
    if (!ConvertSidToStringSidA(tu->User.Sid, &sid_str)) {
        free(tu);
        return -1;
    }
    snprintf(sid, sizeof sid, "%s", sid_str);
    LocalFree(sid_str);
    free(tu);
    snprintf(sddl, sizeof sddl, "D:P(A;;GA;;;SY)(A;;GA;;;%s)", sid);
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorA(
            sddl, SDDL_REVISION_1, desc, NULL))
        return -1;
    memset(sa, 0, sizeof *sa);
    sa->nLength = sizeof *sa;
    sa->lpSecurityDescriptor = *desc;
    sa->bInheritHandle = FALSE;
    return 0;
}

int qnw_prepare_dir(const char *dir)
{
    DWORD attr = GetFileAttributesA(dir);

    if (attr == INVALID_FILE_ATTRIBUTES) {
        if (!CreateDirectoryA(dir, NULL))
            return -1;
        attr = GetFileAttributesA(dir);
        if (attr == INVALID_FILE_ATTRIBUTES)
            return -1;
    }
    return (attr & FILE_ATTRIBUTE_DIRECTORY) != 0 ? 0 : -1;
}

int qnw_pipe_live(const char *pipe_name)
{
    HANDLE h = CreateFileA(pipe_name, GENERIC_READ,
                           FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                           OPEN_EXISTING, 0, NULL);

    if (h == INVALID_HANDLE_VALUE)
        return 0;
    CloseHandle(h);
    /* The open completes a pending connect: the owning listener sees a
     * broken session (its own client image check refuses us) and re-arms.
     * The liveness verdict is what we came for. */
    return 1;
}

int qnw_pipe_listen(const char *pipe_name, const char **reason)
{
    SECURITY_ATTRIBUTES sa;
    PSECURITY_DESCRIPTOR desc = NULL;
    qnw_slot_t *s;
    HANDLE h;

    for (int i = 0; i < QNW_PIPE_MAX; i++)
        if (g_slots[i].kind == 1) {
            *reason = "listener already live";
            return -1;
        }
    if (strncmp(pipe_name, "\\\\.\\pipe\\", 9) != 0) {
        *reason = "bad pipe name";
        return -1;
    }
    if (qnw_pipe_live(pipe_name)) {
        /* another process is already answering this name: binding
         * through it would silently share one identity dir */
        *reason = "listener already live";
        return -1;
    }
    if (owner_sd(&sa, &desc) != 0) {
        *reason = "dacl setup failed";
        return -1;
    }
    h = CreateNamedPipeA(pipe_name,
                         PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
                         PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT |
                         PIPE_REJECT_REMOTE_CLIENTS,
                         1, QNW_OUT_BUF, QNW_IN_BUF, 0, &sa);
    LocalFree(desc);
    if (h == INVALID_HANDLE_VALUE) {
        *reason = "pipe create failed";
        return -1;
    }
    s = qnw_alloc();
    if (s == NULL) {
        CloseHandle(h);
        *reason = "slot exhausted";
        return -1;
    }
    memset(s, 0, sizeof *s);
    s->h = h;
    s->kind = 1;
    s->owner = -1;
    s->conn.hEvent = CreateEventA(NULL, TRUE, FALSE, NULL);
    if (s->conn.hEvent == NULL) {
        CloseHandle(h);
        memset(s, 0, sizeof *s);
        *reason = "slot alloc failed";
        return -1;
    }
    *reason = NULL;
    return qnw_id(s);
}

static int qnw_client_image(HANDLE h, char *out, size_t outlen)
{
    DWORD pid = 0;
    HANDLE p;
    char raw[4096];
    DWORD len = (DWORD)sizeof raw;

    if (!GetNamedPipeClientProcessId(h, &pid) || pid == 0)
        return -1;
    p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (p == NULL)
        return -1;
    if (!QueryFullProcessImageNameA(p, 0, raw, &len)) {
        CloseHandle(p);
        return -1;
    }
    CloseHandle(p);
    qnw_norm(raw, out, outlen);
    return 0;
}

int qnw_pipe_can_accept(int listener, const char **reason)
{
    qnw_slot_t *s;
    DWORD done;

    if (listener < 0 || listener >= QNW_PIPE_MAX ||
        g_slots[listener].kind != 1) {
        *reason = "bad listener";
        return -1;
    }
    s = &g_slots[listener];
    if (!s->armed) {
        BOOL ok = ConnectNamedPipe(s->h, &s->conn);
        DWORD e = ok ? ERROR_SUCCESS : GetLastError();
        if (!ok && e != ERROR_IO_PENDING && e != ERROR_PIPE_CONNECTED) {
            *reason = "connect issue failed";
            return -1;
        }
        s->armed = 1;
    }
    if (!GetOverlappedResult(s->h, &s->conn, &done, FALSE)) {
        DWORD e = GetLastError();
        if (e == ERROR_IO_INCOMPLETE || e == ERROR_PIPE_LISTENING)
            return 0;
        /* broken handshake (liveness probe or abandoned connect):
         * recycle the instance transparently */
        DisconnectNamedPipe(s->h);
        s->armed = 0;
        return 0;
    }
    *reason = NULL;
    return 1;
}

int qnw_pipe_accept(int listener, const char **reason)
{
    qnw_slot_t *s, *c;
    char actual[4096];

    if (listener < 0 || listener >= QNW_PIPE_MAX ||
        g_slots[listener].kind != 1) {
        *reason = "bad listener";
        return -1;
    }
    s = &g_slots[listener];
    for (int i = 0; i < QNW_PIPE_MAX; i++)
        if (g_slots[i].kind == 2) {
            *reason = "second client refused";
            return -1;
        }
    s->armed = 0; /* the completed handshake is consumed by this adopt */
    if (g_expected[0] == '\0') {
        /* fail-closed: the win twin has no uid fallback; the engine arms
         * the gate with the daemon image path before spawning */
        *reason = "peer image not armed";
        DisconnectNamedPipe(s->h);
        return -1;
    }
    if (qnw_client_image(s->h, actual, sizeof actual) != 0) {
        *reason = "client pid unreadable";
        DisconnectNamedPipe(s->h);
        return -1;
    }
    if (strcmp(actual, g_expected) != 0) {
        *reason = "client image mismatch";
        DisconnectNamedPipe(s->h);
        return -1;
    }
    c = qnw_alloc();
    if (c == NULL) {
        *reason = "slot exhausted";
        DisconnectNamedPipe(s->h);
        return -1;
    }
    memset(c, 0, sizeof *c);
    c->h = s->h;
    c->kind = 2;
    c->owner = qnw_id(s);
    *reason = NULL;
    return qnw_id(c);
}

int qnw_read(int id, uint8_t *buf, size_t space, int *eof,
             const char **reason)
{
    qnw_slot_t *s;
    DWORD avail = 0;

    *eof = 0;
    if (id < 0 || id >= QNW_PIPE_MAX || g_slots[id].kind != 2) {
        *reason = "read on bad slot";
        return -1;
    }
    s = &g_slots[id];
    if (!PeekNamedPipe(s->h, NULL, 0, NULL, &avail, NULL)) {
        DWORD e = GetLastError();
        if (e == ERROR_BROKEN_PIPE || e == ERROR_PIPE_NOT_CONNECTED ||
            e == ERROR_PIPE_LISTENING) {
            *eof = 1;
            return 0;
        }
        *reason = "read error";
        return -1;
    }
    if (avail == 0)
        return 0;
    {
        OVERLAPPED ov;
        DWORD got = 0;
        DWORD n = avail < (DWORD)space ? avail : (DWORD)space;
        HANDLE ev = CreateEventA(NULL, TRUE, FALSE, NULL);

        if (ev == NULL) {
            *reason = "read error";
            return -1;
        }
        memset(&ov, 0, sizeof ov);
        ov.hEvent = ev;
        if (!ReadFile(s->h, buf, n, &got, &ov)) {
            DWORD e = GetLastError();
            if (e == ERROR_IO_PENDING)
                e = GetOverlappedResult(s->h, &ov, &got, TRUE)
                        ? ERROR_SUCCESS : GetLastError();
            CloseHandle(ev);
            if (e == ERROR_BROKEN_PIPE || e == ERROR_PIPE_NOT_CONNECTED) {
                *eof = 1;
                return 0;
            }
            if (e != ERROR_SUCCESS) {
                *reason = "read error";
                return -1;
            }
        } else
            CloseHandle(ev);
        return (int)got;
    }
}

int qnw_write(int id, const uint8_t *buf, size_t n, const char **reason)
{
    qnw_slot_t *s;
    OVERLAPPED ov;
    HANDLE ev;
    DWORD written = 0;

    if (id < 0 || id >= QNW_PIPE_MAX || g_slots[id].kind != 2) {
        *reason = "write on bad slot";
        return -1;
    }
    s = &g_slots[id];
    memset(&ov, 0, sizeof ov);
    ev = CreateEventA(NULL, TRUE, FALSE, NULL);
    if (ev == NULL) {
        *reason = "write error";
        return -1;
    }
    ov.hEvent = ev;
    if (!WriteFile(s->h, buf, (DWORD)n, &written, &ov)) {
        DWORD e = GetLastError();
        if (e == ERROR_IO_PENDING) {
            /* never block the pump: an undrained peer is a terminal
             * write failure, matching the unix EAGAIN path */
            if (!GetOverlappedResult(s->h, &ov, &written, FALSE)) {
                CancelIoEx(s->h, &ov);
                CloseHandle(ev);
                *reason = "write error";
                return -1;
            }
        } else {
            CloseHandle(ev);
            *reason = (e == ERROR_BROKEN_PIPE || e == ERROR_PIPE_NOT_CONNECTED)
                          ? "peer closed" : "write error";
            return -1;
        }
    }
    CloseHandle(ev);
    return (int)written;
}

void qnw_close(int id)
{
    if (id < 0 || id >= QNW_PIPE_MAX)
        return;
    if (g_slots[id].kind == 2) {
        /* connection end: disconnect the session, the listener handle
         * lives on to accept the respawned daemon */
        qnw_slot_t *s = &g_slots[id];
        if (s->owner >= 0 && s->owner < QNW_PIPE_MAX)
            g_slots[s->owner].armed = 0;
        DisconnectNamedPipe(s->h);
        memset(s, 0, sizeof *s);
        s->owner = -1;
        return;
    }
    if (g_slots[id].kind == 1) {
        CloseHandle(g_slots[id].conn.hEvent);
        CloseHandle(g_slots[id].h);
        memset(&g_slots[id], 0, sizeof g_slots[id]);
        g_slots[id].owner = -1;
    }
}

#endif /* _WIN32 */
