/* Test-only exec supervisor: parents spawned qn-peers with this marker-carrying
 * image, as the engine does in production (spec §3.4a). */
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#include "qn_buildid.h"

const char qn_build_id_marker[] = "QNBID:" QN_BUILD_ID;

static volatile sig_atomic_t supervised;

static void forward (int sig)
{
    (void)sig;
    if (supervised > 0) (void)kill((pid_t)supervised, sig);
}

int main (int argc, char **argv)
{
    const char *node = getenv("QN_FAKE_ENGINE_NODE");
    const char *script = getenv("QN_FAKE_ENGINE_SCRIPT");
    if (node == NULL || script == NULL) {
        fputs("fake-engine: QN_FAKE_ENGINE_NODE and QN_FAKE_ENGINE_SCRIPT"
              " are required\n", stderr);
        return 2;
    }
    char **av = calloc((size_t)argc + 2, sizeof *av);
    if (av == NULL)
        return 3;
    av[0] = (char *)node;
    av[1] = (char *)script;
    for (int i = 1; i < argc; i++)
        av[i + 1] = argv[i];
    av[argc + 1] = NULL;
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = forward;
    sigemptyset(&sa.sa_mask);
    if (sigaction(SIGTERM, &sa, NULL) < 0 || sigaction(SIGINT, &sa, NULL) < 0
        || sigaction(SIGHUP, &sa, NULL) < 0)
        return 5;
    pid_t pid = fork();
    if (pid < 0) {
        free(av);
        return 4;
    }
    if (pid == 0) {
        execv(node, av);
        _exit(127);
    }
    free(av);
    supervised = (sig_atomic_t)pid;
    int status = 0;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR)
            return 6;
    }
    supervised = 0;
    if (WIFEXITED(status))
        return WEXITSTATUS(status);
    return 1;
}
