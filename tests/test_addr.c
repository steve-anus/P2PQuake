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

/* Mirror of QN_StringToAddr's parse (net_qn.c): the join-code display
 * form "qn:XXXX-XXXX-XXXX-XXXX" (hyphens ignored, count 0 or 3,
 * case-insensitive Crockford base32) or the key forms
 * "qn:<16hex>:<port>" / port-stripped. */
static const char CROCKFORD[] = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

static int crockford_value(int c)
{
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'a' && c <= 'z')
        c -= 'a' - 'A';
    if (c >= 'A' && c <= 'Z')
    {
        const char *p = strchr(CROCKFORD + 10, c);
        if (p == NULL)
            return -1;        /* I, L, O, U are not in the alphabet */
        return (int)(10 + (p - (CROCKFORD + 10)));
    }
    return -1;
}

static int crockford_decode16(const char *s, size_t n, unsigned char out[10])
{
    unsigned int acc = 0;
    int bits = 0, chars = 0, bytes = 0;

    memset(out, 0, 10);
    for (; n--; s++)
    {
        int v;
        if (*s == '-')
            continue;
        v = crockford_value((unsigned char)*s);
        if (v < 0)
            return 0;
        acc = (acc << 5) | (unsigned int)v;
        bits += 5;
        chars++;
        if (bits >= 8)
        {
            bits -= 8;
            if (bytes >= 10)
                return 0;   /* >16 symbols: refuse before storing past
                             * the 10-byte code buffer (mirror of the
                             * engine bound) */
            out[bytes++] = (unsigned char)((acc >> bits) & 0xff);
            acc &= (1u << bits) - 1;
        }
    }
    return chars == 16 && bytes == 10;
}

/* pin_malformed mirrors the -qn-pin latch: a broken pin fails joins
 * closed rather than silently dropping the pin. */
static int pin_malformed;        /* test-settable */
static unsigned char last_code[10];
static int join_armed;           /* mirrors qn_join_pending */

static int parse_addr(const char *string, unsigned int *k0,
                      unsigned int *k1, unsigned int *port_out)
{
    unsigned int keywords[2] = { 0, 0 };
    unsigned int port = 0;
    char rest[32];
    const char *body;
    size_t bl;
    int n, k, dashes = 0;
    int codey = 0;

    join_armed = 0;
    /* strncasecmp under the engine's own name (q_strncasecmp): the
     * mirror must call what net_qn.c actually calls. */
    if (strncasecmp(string, "qn:", 3) != 0)
        return -1;

    body = string + 3;
    bl = strlen(body);
    for (k = 0; k < (int)bl; k++)
    {
        if (body[k] == '-')
            dashes++;
        else if (crockford_value((unsigned char)body[k]) >= 16)
            codey = 1;
    }
    if (codey || dashes > 0)
    {
        if (dashes > 0)
        {
            /* the hyphenated display form is exactly 4-4-4-4 */
            if (bl != 19 || body[4] != '-' || body[9] != '-' ||
                body[14] != '-')
                return -1;
        }
        if (pin_malformed)
            return -1;
        if (!crockford_decode16(body, bl, last_code))
            return -1;
        join_armed = 1;
        *k0 = 0;
        *k1 = 0;
        *port_out = (unsigned int)net_hostport;
        return 0;
    }

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

static int hexeq(const unsigned char *a, const char *hex)
{
    char s[21];
    for (int i = 0; i < 10; i++)
        sprintf(s + i * 2, "%02x", a[i]);
    s[20] = '\0';
    return strcmp(s, hex) == 0;
}

static void case_code(const char *in, const char *expect_hex)
{
    unsigned int k0 = 1, k1 = 1, p = 1;
    CHECK(parse_addr(in, &k0, &k1, &p) == 0);
    CHECK(join_armed == 1);
    CHECK(hexeq(last_code, expect_hex));
    CHECK(k0 == 0 && k1 == 0 && p == (unsigned int)net_hostport);
}

static void case_code_no(const char *in)
{
    unsigned int k0, k1, p;
    CHECK(parse_addr(in, &k0, &k1, &p) == -1);
    CHECK(join_armed == 0);
}

static void test_joincodes(void)
{
    /* Adversarial over-long undashed symbol streams: one non-hex Crockford
     * letter sets codey, which skips the 4-4-4-4 dash gate (that only runs
     * when dashes > 0), so the decoder is reached with more than 16
     * symbols.  It must refuse them WITHOUT writing past the 10-byte code
     * buffer -- under -fsanitize=address a missing bound is fatal. */
    {
        char big[64];
        size_t i;
        memcpy(big, "qn:", 3);
        for (i = 0; i < 40; i++) big[3 + i] = 'Z';
        big[43] = '\0';
        case_code_no(big);
    }
    case_code_no("qn:0123456789ABCDEFGHJK");   /* 20 symbols -> 12 bytes */
    case_code_no("qn:0123456789ABCDEFGH");     /* 18 symbols -> 11 bytes */
    /* Expected bytes come from an independent base32 implementation,
     * not from the mirror under test. */
    case_code("qn:7FX2-3K9M-P7QR-5VTW", "3bfa21cd34b1ef82ef5c");
    case_code("qn:7fx2-3k9m-p7qr-5vtw", "3bfa21cd34b1ef82ef5c"); /* case-free */
    case_code("qn:AAAA-AAAA-AAAA-AAAA", "5294a5294a5294a5294a");
    case_code("qn:ZZZZ-ZZZZ-ZZZZ-ZZZZ", "ffffffffffffffffffff");
    case_code("qn:0000-"
              "0000-"
              "0000-"
              "0000", "00000000000000000000");
    case_code("qn:1000-"
              "0000-"
              "0000-"
              "0000", "08000000000000000000");
    case_code("qn:7FX23K9MP7QR5VTW", "3bfa21cd34b1ef82ef5c"); /* ungrouped */
    case_code_no("qn:7FX23-K9MP7-QR5VTW"); /* 3 dashes, ragged split: not 4-4-4-4 */

    /* The alphabet excludes I, L, O, U (spec 5.1) */
    case_code_no("qn:7IX2-3K9M-P7QR-5VTW");
    case_code_no("qn:7LX2-3K9M-P7QR-5VTW");
    case_code_no("qn:7OX2-3K9M-P7QR-5VTW");
    case_code_no("qn:7UX2-3K9M-P7QR-5VTW");
    /* wrong symbol count, wrong grouping */
    case_code_no("qn:7FX2-3K9M-P7QR-5VT");
    case_code_no("qn:7FX2-3K9M-P7QR-5VTWX");
    case_code_no("qn:7FX23K9M-P7QR5VTW-"); /* 3 dashes but tail-heavy */
    case_code_no("qn:7FX23K9MP7QR5VT-W"); /* hmm: 3 dashes, still 16 symbols */
    case_code_no("qn:7FX2-3K9M-P7QR-5VT-W");
    case_code_no("qn:----");
    case_code_no("7FX2-3K9M-P7QR-5VTW");  /* prefix required: UDP first */
    case_code_no("host.example");
    case_code_no("qn:7FX2 3K9M P7QR 5VTW"); /* spaces are not hyphens */

    /* All-hex symbols with no hyphens are the key form, never a code —
     * a code that happens to be typeable that way is addressed by its
     * 16 hex symbols as a key and joins through the code display form
     * instead. (Documented ambiguity resolution of the two grammars.) */
    {
        unsigned int k0, k1, p;
        CHECK(parse_addr("qn:1234567890abcdef:26000", &k0, &k1, &p) == 0);
        CHECK(join_armed == 0);
    }

    /* A malformed pin fails joins closed (no silent downgrade to an
     * open invite). */
    pin_malformed = 1;
    case_code_no("qn:7FX2-3K9M-P7QR-5VTW");
    pin_malformed = 0;
    case_code("qn:7FX2-3K9M-P7QR-5VTW", "3bfa21cd34b1ef82ef5c");
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
    test_joincodes();
    test_roundtrip();
    if (checks_out)
        *checks_out = checks;
    if (failures)
        printf("QN addr-grammar tests FAILED: %d/%d\n", failures, checks);
    return failures;
}
