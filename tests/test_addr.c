/* test_addr.c — accept/reject table for the qn landriver's address
 * strings. The canonical grammar lives in
 * src/vendor/quakespasm/Quake/net_qn.c (QN_StringToAddr); this mirrors
 * its sscanf arms case by case so the table runs on every `make check`.
 * The end-to-end path through the datagram layer arrives with the
 * spawn/pump hooks. Keep the mirror in step with any change to the real
 * formats. */
#include <stdio.h>
#include <string.h>
#include <strings.h>

static int net_hostport = 26000; /* stands in for the engine global */

static int checks;
static int failures;

#define CHECK(cond)                                                     \
    do {                                                                \
        checks++;                                                       \
        if (!(cond)) {                                                  \
            failures++;                                                 \
            printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond);      \
        }                                                               \
    } while (0)

/* Mirror of QN_StringToAddr's parse (net_qn.c): canonical
 * "qn:<16hex>:<port>" or the port-stripped "qn:<16hex>" that the
 * datagram layer hands over after its port splitting. */
static int parse_addr(const char *string, unsigned int *k0,
                      unsigned int *k1, unsigned int *port_out)
{
    unsigned int keywords[2] = { 0, 0 };
    unsigned int port = 0;
    char rest[32];
    int n;

    /* strncasecmp under the engine's own name (q_strncasecmp): the
     * mirror must call what net_qn.c actually calls. */
    if (strncasecmp(string, "qn:", 3) != 0)
        return -1;
    rest[0] = '\0';
    n = sscanf(string + 3, "%8x%8x:%u%31s",
               &keywords[0], &keywords[1], &port, rest);
    if (n < 3 || rest[0] != '\0') {
        rest[0] = '\0';
        n = sscanf(string + 3, "%8x%8x%31s",
                   &keywords[0], &keywords[1], rest);
        if (n != 2 || rest[0] != '\0')
            return -1;
        port = (unsigned int) net_hostport;
    }
    if (port > 0xffffu)
        return -1;
    *k0 = keywords[0];
    *k1 = keywords[1];
    *port_out = port;
    return 0;
}

static void case_ok(const char *in, unsigned int e0, unsigned int e1,
                    unsigned int eport)
{
    unsigned int k0 = 0, k1 = 0, p = 0;
    CHECK(parse_addr(in, &k0, &k1, &p) == 0);
    CHECK(k0 == e0 && k1 == e1 && p == eport);
}

static void case_no(const char *in)
{
    unsigned int k0, k1, p;
    CHECK(parse_addr(in, &k0, &k1, &p) == -1);
}

static void test_grammar(void)
{
    const unsigned int K0 = 0xAAAA1111u, K1 = 0xBBBB2222u;

    case_ok("qn:AAAA1111BBBB2222:26000", K0, K1, 26000); /* canonical */
    case_ok("qn:AAAA1111BBBB2222", K0, K1, 26000);       /* port-stripped */
    case_ok("qn:aaaa1111bbbb2222:1", K0, K1, 1);         /* case-free hex */
    case_ok("qn:0A0B0C0D0E0F1011:65535", 0x0A0B0C0Du, 0x0E0F1011u, 65535);
    case_ok("qn:AAAA1111BBBB2222 ", K0, K1, 26000);      /* trailing space */
    case_ok("qn:1234567890ABCDEF:2099", 0x12345678u, 0x90ABCDEFu, 2099);

    case_no("qn:AAAA1111BBBB2222:65536");   /* port overflow rejected */
    case_no("qn:AAAA1111BBBB2222:x");       /* garbage rejected */
    case_no("qn:AAAA1111BBBB2222:1junk");
    case_no("qn:AAAA1111BBBB2222more");     /* key garbage rejected */
    case_no("qn:AAAA1111:2222");            /* short key */
    case_no("qn:AAAA1111BBBB2222AAAA:1");   /* long key */
    case_no("qn::1");
    case_no("host.example");                /* non-qn falls to UDP */
    case_no("");
    case_no("qn:");
}

static void test_roundtrip(void)
{
    /* The canonical string QN_AddrToString emits must parse back to the
     * same key halves and port (lane/spare are zero on this path). */
    unsigned char key[8] = { 0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4 };
    char s[32], hx[17];
    unsigned int k0 = 0, k1 = 0, p = 0;

    for (int i = 0; i < 8; i++)
        sprintf(hx + i * 2, "%02x", key[i]);
    hx[16] = '\0';
    sprintf(s, "qn:%s:%u", hx, 26000u);
    CHECK(parse_addr(s, &k0, &k1, &p) == 0);
    CHECK(k0 == 0xdeadbeefu && k1 == 0x01020304u && p == 26000u);
}

int qn_test_addr(int *checks_out)
{
    checks = 0;
    failures = 0;
    test_grammar();
    test_roundtrip();
    if (checks_out)
        *checks_out = checks;
    if (failures)
        printf("QN addr-grammar tests FAILED: %d/%d\n", failures, checks);
    return failures;
}
