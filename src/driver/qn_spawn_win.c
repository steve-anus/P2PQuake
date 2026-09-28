/* qn_spawn_win.c — CreateProcess + Job Object twin (see qn_spawn_win.h).
 * Hard rules carried from the unix contract: argv is never a shell
 * string; the token never enters argv/envp; the program is validated
 * through an open handle before launch and re-verified after create. */
#include "qn_spawn_win.h"

/* Keep the translation unit non-empty for the unix build of the same
 * directory (every definition below is _WIN32-only). */
typedef struct qnw_keepalive { int only_a_type; } qnw_keepalive_t;

#ifdef _WIN32

#include <windows.h>
#include <bcrypt.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define QNW_SLOTS 4

typedef struct {
    HANDLE proc;
    HANDLE job;
    int kind; /* 0 free, 1 live, 2 reaped (never handed out again) */
} qnw_slot_t;

static qnw_slot_t g_slots[QNW_SLOTS];

int qnw_make_token(uint8_t out[32])
{
    return BCryptGenRandom(NULL, out, 32,
                           BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0 ? 0 : -1;
}

/* MSVCRT command-line quoting: quote when the arg is empty or contains
 * space/tab/quote; a run of n backslashes before a quote becomes 2n+1
 * backslashes then the literal quote; a trailing run doubles. */
static int qnw_build_cmdline(char *const argv[], char *out, size_t outlen)
{
    size_t o = 0;

    out[0] = '\0';
    for (int i = 0; argv[i] != NULL; i++) {
        const char *a = argv[i];
        int needs = a[0] == '\0';
        size_t bs;

        for (const char *p = a; *p; p++)
            if (*p == ' ' || *p == '\t' || *p == '"')
                needs = 1;
        if (i != 0) {
            if (o + 1 >= outlen)
                return -1;
            out[o++] = ' ';
        }
        if (!needs) {
            size_t l = strlen(a);
            if (o + l >= outlen)
                return -1;
            memcpy(out + o, a, l);
            o += l;
            continue;
        }
        if (o + 2 >= outlen)
            return -1;
        out[o++] = '"';
        for (const char *p = a;;) {
            bs = 0;
            while (*p == '\\') {
                p++;
                bs++;
            }
            if (*p == '"') {
                for (size_t k = 0; k < bs * 2 + 1; k++) {
                    if (o + 1 >= outlen)
                        return -1;
                    out[o++] = '\\';
                }
                if (o + 1 >= outlen)
                    return -1;
                out[o++] = '"';
                p++;
                continue;
            }
            if (*p == '\0') {
                for (size_t k = 0; k < bs; k++) {
                    if (o + 1 >= outlen)
                        return -1;
                    out[o++] = '\\';
                }
                break;
            }
            for (size_t k = 0; k < bs; k++) {
                if (o + 1 >= outlen)
                    return -1;
                out[o++] = '\\';
            }
            if (o + 1 >= outlen)
                return -1;
            out[o++] = *p;
            p++;
        }
        if (o + 1 >= outlen)
            return -1;
        out[o++] = '"';
    }
    out[o] = '\0';
    return 0;
}

static int qnw_pe_image_ok(HANDLE h)
{
    uint8_t hdr[1024];
    DWORD got = 0;
    uint32_t off;

    if (SetFilePointer(h, 0, NULL, FILE_BEGIN) == INVALID_SET_FILE_POINTER)
        return -1;
    if (!ReadFile(h, hdr, sizeof hdr, &got, NULL) || got < 64u)
        return -1;
    if (hdr[0] != 'M' || hdr[1] != 'Z')
        return -1;
    memcpy(&off, hdr + 0x3c, 4);
    if (off + 4u > got)
        return -1;
    return (hdr[off] == 'P' && hdr[off + 1] == 'E' &&
            hdr[off + 2] == 0 && hdr[off + 3] == 0) ? 0 : -1;
}

int qnw_self_image(char *out, size_t cap)
{
    DWORD n = GetModuleFileNameA(NULL, out, (DWORD)cap - 1);
    if (n == 0 || n >= (DWORD)cap - 1) {
        return -1; /* truncation is a refusal, never a prefix probe */
    }
    out[n] = '\0';
    return 0;
}

int qnw_prog_is_pe(const char *path)
{
    HANDLE h = CreateFileA(path, FILE_READ_DATA | FILE_READ_ATTRIBUTES,
                           FILE_SHARE_READ | FILE_SHARE_DELETE, NULL,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    int r;

    if (h == INVALID_HANDLE_VALUE)
        return -1;
    r = qnw_pe_image_ok(h);
    CloseHandle(h);
    return r;
}

static qnw_slot_t *qnw_alloc(void)
{
    for (int i = 0; i < QNW_SLOTS; i++)
        if (g_slots[i].kind == 0)
            return &g_slots[i];
    return NULL;
}

int qnw_spawn_exec(const char *program, char *const argv[],
                   char *const envp[], const uint8_t token[32],
                   const char **reason)
{
    qnw_slot_t *s;
    HANDLE img, rd = NULL, wr = NULL, nul = NULL, job = NULL;
    SECURITY_ATTRIBUTES sa;
    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    BY_HANDLE_FILE_INFORMATION fi, pf;
    char cmdline[8192], got_img[4096];
    DWORD wrote = 0, envlen = 0;
    char *envblk = NULL;

    *reason = "spawn failed";
    memset(&pi, 0, sizeof pi);
    memset(&sa, 0, sizeof sa);
    sa.nLength = sizeof sa;
    sa.bInheritHandle = TRUE;

    img = CreateFileA(program, FILE_READ_DATA | FILE_READ_ATTRIBUTES,
                      FILE_SHARE_READ, NULL,
                      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    /* no delete-share: pins the file object across open -> launch -> probe */
    if (img == INVALID_HANDLE_VALUE) {
        *reason = "program unreadable";
        return -1;
    }
    if (qnw_pe_image_ok(img) != 0 || !GetFileInformationByHandle(img, &fi)) {
        CloseHandle(img);
        *reason = "program not a PE image";
        return -1;
    }
    if (qnw_build_cmdline(argv, cmdline, sizeof cmdline) != 0) {
        CloseHandle(img);
        *reason = "argv too wide";
        return -1;
    }
    if (envp != NULL) {
        for (int i = 0; envp[i] != NULL; i++)
            envlen += (DWORD)strlen(envp[i]) + 1u;
        if (envlen > 32768u) {
            CloseHandle(img);
            *reason = "environment too wide";
            return -1;
        }
        envblk = (char *)malloc(envlen + 2u);
        if (envblk == NULL) {
            CloseHandle(img);
            *reason = "out of memory";
            return -1;
        }
        {
            char *q = envblk;
            for (int i = 0; envp[i] != NULL; i++) {
                size_t l = strlen(envp[i]);
                memcpy(q, envp[i], l + 1u);
                q += l + 1u;
            }
            *q = '\0';
        }
    }
    if (!CreatePipe(&rd, &wr, &sa, 128) ||
        !WriteFile(wr, token, 32, &wrote, NULL) || wrote != 32) {
        free(envblk);
        CloseHandle(img);
        if (rd != NULL)
            CloseHandle(rd);
        if (wr != NULL)
            CloseHandle(wr);
        *reason = "token pipe failed";
        return -1;
    }
    CloseHandle(wr);
    wr = NULL; /* child sees EOF right after the 32 bytes */
    nul = CreateFileA("NUL", GENERIC_WRITE,
                      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                      &sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (nul == INVALID_HANDLE_VALUE) {
        free(envblk);
        CloseHandle(img);
        CloseHandle(rd);
        *reason = "stdout sink failed";
        return -1;
    }
    memset(&si, 0, sizeof si);
    si.cb = sizeof si;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = rd;
    si.hStdOutput = nul;
    si.hStdError = nul;
    if (!CreateProcessA(program, cmdline, NULL, NULL, TRUE,
                        CREATE_SUSPENDED | CREATE_NO_WINDOW,
                        envblk, NULL, &si, &pi)) {
        free(envblk);
        CloseHandle(img);
        CloseHandle(rd);
        CloseHandle(nul);
        *reason = "createprocess failed";
        return -1;
    }
    free(envblk);
    CloseHandle(rd);
    CloseHandle(nul);

    job = CreateJobObjectA(NULL, NULL);
    if (job == NULL) {
        *reason = "daemon job create failed";
        goto fail;
    }
    {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION lim;
        DWORD len = (DWORD)sizeof got_img;
        HANDLE probe;

        memset(&lim, 0, sizeof lim);
        lim.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                     &lim, sizeof lim)) {
            *reason = "daemon job limits failed";
            goto fail;
        }
        /* a parent already inside a non-nestable job lands the daemon in
         * its job and rejects ours; that is environment, not tampering */
        if (!AssignProcessToJobObject(job, pi.hProcess)) {
            *reason = "daemon job assign failed (engine confined to a job?)";
            goto fail;
        }
        /* the thing that ran must be the file object I pre-validated:
         * volume+index pins persistent swaps (the ids are meaningful
         * on NTFS/ReFS); path strings are NOT compared — handle
         * queries resolve junctions, process-image queries do not, so
         * strings diverge for legitimate layouts */
        if (!QueryFullProcessImageNameA(pi.hProcess, 0, got_img, &len)) {
            *reason = "daemon image name query failed";
            goto fail;
        }
        probe = CreateFileA(got_img, FILE_READ_ATTRIBUTES,
                            FILE_SHARE_READ | FILE_SHARE_DELETE, NULL,
                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        if (probe == INVALID_HANDLE_VALUE) {
            *reason = "daemon image reopen failed";
            goto fail;
        }
        if (!GetFileInformationByHandle(probe, &pf)) {
            CloseHandle(probe);
            *reason = "daemon image info query failed";
            goto fail;
        }
        CloseHandle(probe);
        if (pf.dwVolumeSerialNumber != fi.dwVolumeSerialNumber ||
            pf.nFileIndexHigh != fi.nFileIndexHigh ||
            pf.nFileIndexLow != fi.nFileIndexLow) {
            *reason = "daemon image changed between open and launch";
            goto fail;
        }
    }
    if (ResumeThread(pi.hThread) == (DWORD)-1) {
        *reason = "daemon resume failed";
        goto fail;
    }
    CloseHandle(pi.hThread);
    CloseHandle(img);
    s = qnw_alloc();
    if (s == NULL) {
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hProcess);
        CloseHandle(job);
        *reason = "slot exhausted";
        return -1;
    }
    s->proc = pi.hProcess;
    s->job = job;
    s->kind = 1;
    return (int)(s - g_slots);

fail:
    TerminateProcess(pi.hProcess, 1);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    if (job != NULL)
        CloseHandle(job);
    CloseHandle(img);
    return -1;
}

int qnw_spawn_alive(int slot)
{
    DWORD code;

    if (slot < 0 || slot >= QNW_SLOTS || g_slots[slot].kind != 1)
        return 0;
    if (!GetExitCodeProcess(g_slots[slot].proc, &code))
        return 0;
    return code == STILL_ACTIVE ? 1 : 0;
}

int qnw_spawn_check(int slot, int *exit_status)
{
    DWORD code;
    qnw_slot_t *s;

    if (slot < 0 || slot >= QNW_SLOTS || g_slots[slot].kind != 1)
        return 0;
    s = &g_slots[slot];
    if (!GetExitCodeProcess(s->proc, &code))
        return 0;
    if (code == STILL_ACTIVE)
        return 0;
    *exit_status = (int)code;
    CloseHandle(s->job);
    CloseHandle(s->proc);
    memset(s, 0, sizeof *s);
    s->kind = 2;
    return 1;
}

void qnw_spawn_kill(int slot)
{
    if (slot < 0 || slot >= QNW_SLOTS || g_slots[slot].kind != 1)
        return;
    TerminateProcess(g_slots[slot].proc, 1);
    /* the job handle closes at reap; on engine exit every handle dies
     * with the process, so the kernel reaps the child regardless — the
     * orphan promise never depends on this code path running */
}

#endif /* _WIN32 */
