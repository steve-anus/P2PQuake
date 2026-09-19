/* test_frame.c — Plane A codec conformance suite (spec §2, §8).
 * Every frame type round-trips; every reject rule is exercised.
 * Run under ASan+UBSan via `make check` in the repo root. */
#include "../driver/qn_frame.h"

#include <stdio.h>
#include <string.h>

static int checks;
static int failures;

#define CHECK(cond)                                                      \
    do {                                                                 \
        checks++;                                                        \
        if (!(cond)) {                                                   \
            failures++;                                                   \
            printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond);        \
        }                                                                \
    } while (0)

/* Round-trip a frame through write+parse and check the fields survive. */
static void roundtrip(uint16_t type, const uint8_t *payload, uint16_t len)
{
    uint8_t buf[QN_MAX_FRAME];
    size_t n = qn_frame_write(buf, sizeof buf, type, 1, payload, len);
    CHECK(n == QN_HEADER_LEN + len + QN_CRC_LEN);
    qn_frame_t f;
    CHECK(qn_frame_parse(buf, n, &f) == QN_PARSE_OK);
    CHECK(f.type == type);
    CHECK(f.seq == 1);
    CHECK(f.len == len);
    CHECK(f.consumed == n);
    if (len) {
        CHECK(f.payload && memcmp(f.payload, payload, len) == 0);
    }
}

static void reject(uint8_t *buf, size_t n)
{
    qn_frame_t f;
    CHECK(qn_frame_parse(buf, n, &f) == QN_PARSE_BAD);
}

/* --- golden vectors from src/protocol/qn_protocol.md §7 (Node-generated) --- */
static const uint8_t g_fv1[] = {
    0x31,
    0x46,
    0x4e,
    0x51,
    0x01,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x20,
    0x00,
    0x0a,
    0x9a,
    0x40,
    0x3d,
    0xff,
    0x2b,
    0xd3,
    0xb3,
    0x63,
    0xd3,
    0x39,
    0x01,
    0xf7,
    0x35,
    0x64,
    0x9f,
    0x21,
    0xfe,
    0x33,
    0x94,
    0xaa,
    0xaf,
    0xc1,
    0x7a,
    0xfd,
    0x22,
    0x1e,
    0x52,
    0x3e,
    0xbd,
    0x6e,
    0x10,
    0x4a,
    0x46,
    0xbc,
    0xa2
};

static const uint8_t g_fv2[] = {
    0x31,
    0x46,
    0x4e,
    0x51,
    0x01,
    0x00,
    0x20,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x0a,
    0x00,
    0x65,
    0x36,
    0x58,
    0xbe,
    0x59,
    0x97,
    0x01,
    0xdc,
    0x8f,
    0x4e,
    0xb7,
    0x77,
    0x9f,
    0xd3
};

static const uint8_t g_fv3[] = {
    0x31, 0x46, 0x4e, 0x51, 0x01, 0x00, 0x40, 0x00,
    0x03, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x01, 0x00,
    0x20, 0x00, 0x0e, 0xe9, 0x93, 0xf3, 0x31, 0xcc,
    0x2f, 0x34, 0xe5, 0x0f, 0xd5, 0xd9, 0x2b, 0x7e,
    0x02, 0xb2, 0x5c, 0x64, 0x07, 0xbe, 0x7a, 0x49,
    0xd6, 0x38, 0x2a, 0x45, 0xd9, 0x4f, 0x12, 0xa0,
    0x3b, 0x93, 0x02, 0x00, 0x04, 0x00, 0x62, 0x6f,
    0x64, 0x79, 0x7c, 0x72, 0xee, 0xda
};

static const uint8_t g_fv4[] = {
    0x31,
    0x46,
    0x4e,
    0x51,
    0x01,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x20,
    0x00,
    0x0a,
    0x9a,
    0x40,
    0x3d,
    0xff,
    0x2b,
    0xd3,
    0xb3,
    0x63,
    0xd3,
    0x39,
    0x01,
    0xf7,
    0x35,
    0x64,
    0x9f,
    0x21,
    0xfe,
    0x33,
    0x94,
    0xaa,
    0xaf,
    0xc1,
    0x7a,
    0xfd,
    0x22,
    0x1e,
    0x52,
    0x3e,
    0xbd,
    0x6e,
    0x10,
    0x4a,
    0x46,
    0xbc,
    0x5d
};

static const uint8_t g_fv5[] = {
    0x31,
    0x46,
    0x4e,
    0x51,
    0x01,
    0xff,
    0x20,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x0a,
    0x00,
    0x65,
    0x36,
    0x58,
    0xbe,
    0x59,
    0x97,
    0x01,
    0xdc,
    0x8f,
    0x4e,
    0xb7,
    0x77,
    0x9f,
    0xd3
};


static void check_golden(void)
{
    qn_frame_t f;
    CHECK(qn_frame_parse(g_fv1, sizeof g_fv1, &f) == QN_PARSE_OK);
    CHECK(f.type == QN_T_AUTH && f.seq == 1 && f.len == 32);
    CHECK(qn_frame_parse(g_fv2, sizeof g_fv2, &f) == QN_PARSE_OK);
    CHECK(f.type == QN_T_JOIN_OPEN && f.len == 10);
    CHECK(qn_frame_parse(g_fv3, sizeof g_fv3, &f) == QN_PARSE_OK);
    CHECK(f.type == QN_T_SV_DATA && f.seq == 3 && f.len == 44);
    CHECK(qn_frame_parse(g_fv4, sizeof g_fv4, &f) == QN_PARSE_BAD); /* crc */
    CHECK(qn_frame_parse(g_fv5, sizeof g_fv5, &f) == QN_PARSE_BAD); /* major */
}

int main(void)
{
    qn_frame_init();
    check_golden();

    /* CRC32 standard check value proves the IEEE parameter set. */
    CHECK(qn_crc32((const uint8_t *)"123456789", 9) == 0xCBF43926u);

    /* --- every Plane A type round-trips --- */
    uint8_t token[32];
    memset(token, 0xA5, sizeof token);
    roundtrip(QN_T_AUTH, token, sizeof token);
    roundtrip(QN_T_PING, (const uint8_t *)"\x01\x00\x00\x00", 4);
    roundtrip(QN_T_PONG, (const uint8_t *)"\x01\x00\x00\x00", 4);
    roundtrip(QN_T_HOST_DOWN, NULL, 0);
    roundtrip(QN_T_JOIN_CLOSE, NULL, 0);
    uint8_t code[10];
    memset(code, 0x42, sizeof code);
    roundtrip(QN_T_JOIN_OPEN, code, sizeof code);
    roundtrip(QN_T_STUFFTEXT, (const uint8_t *)"say hello", 9);
    roundtrip(QN_T_FATAL, (const uint8_t *)"\x03", 1);
    uint8_t big[2048];
    memset(big, 0x5A, sizeof big);
    roundtrip(QN_T_SV_DATA, big, sizeof big); /* payload at the cap */

    /* --- malformed frames are terminal (spec §2.1) --- */
    uint8_t buf[QN_MAX_FRAME + 8];
    size_t n = qn_frame_write(buf, sizeof buf, QN_T_PING, 1,
                              (const uint8_t *)"\x07\x00\x00\x00", 4);
    CHECK(n > 0);
    uint8_t save[QN_MAX_FRAME + 8];
    memcpy(save, buf, n);

    buf[0] ^= 0xFF;
    reject(buf, n); /* bad magic */
    memcpy(buf, save, n);

    buf[4] = 0; buf[5] = 0;
    reject(buf, n); /* version 0 forbidden */
    memcpy(buf, save, n);

    buf[5] = 1;
    reject(buf, n); /* major mismatch */
    memcpy(buf, save, n);

    buf[12] = (uint8_t)(QN_MAX_PAYLOAD + 1);
    reject(buf, n); /* oversized length field */
    memcpy(buf, save, n);

    memset(buf + 8, 0, 4);
    reject(buf, n); /* zero sequence */
    memcpy(buf, save, n);

    buf[14] ^= 0x01;
    reject(buf, n); /* payload corruption vs CRC */
    memcpy(buf, save, n);

    buf[n - 1] ^= 0x80;
    reject(buf, n); /* stored-CRC corruption */
    memcpy(buf, save, n);

    CHECK(qn_frame_parse(buf, n - 1, &(qn_frame_t){0}) == QN_PARSE_NEED_MORE);
    CHECK(qn_frame_parse(buf, QN_HEADER_LEN - 1, &(qn_frame_t){0}) ==
          QN_PARSE_NEED_MORE);

    /* trailing junk after a whole frame: caller sees exactly one frame */
    memcpy(buf + n, save, n);
    qn_frame_t f;
    CHECK(qn_frame_parse(buf, 2 * n, &f) == QN_PARSE_OK);
    CHECK(f.consumed == n);

    /* --- sequence rules (spec §2.2) --- */
    uint32_t last = 0;
    CHECK(qn_seq_accept(&last, 1));
    CHECK(qn_seq_accept(&last, 9));          /* forward jumps fine */
    CHECK(!qn_seq_accept(&last, 9));         /* duplicate */
    CHECK(!qn_seq_accept(&last, 8));         /* regression */
    CHECK(!qn_seq_accept(&last, 0));         /* zero */
    last = 0;
    CHECK(qn_seq_accept(&last, 5));          /* arbitrary start */

    /* --- writer rejections --- */
    CHECK(qn_frame_write(buf, sizeof buf, QN_T_PING, 0, NULL, 0) == 0);
    CHECK(qn_frame_write(buf, 10, QN_T_PING, 1, NULL, 0) == 0);
    CHECK(qn_frame_write(buf, sizeof buf, QN_T_PING, 1, NULL,
                         (uint16_t)(QN_MAX_PAYLOAD + 1)) == 0);

    /* --- TLV: valid, iteration, find --- */
    uint8_t v1[3] = {1, 2, 3};
    uint8_t v2[1] = {9};
    const uint16_t tags[2] = {0x0001, 0x8000};
    const uint8_t *vals[2] = {v1, v2};
    const uint16_t lens[2] = {3, 1};
    uint8_t tlv[64];
    size_t tl = qn_tlv_write(tlv, sizeof tlv, tags, vals, lens, 2);
    CHECK(tl == 4 + 3 + 4 + 1);
    qn_tlv_iter_t it;
    qn_tlv_iter_init(&it, tlv, tl);
    qn_tlv_t t;
    CHECK(qn_tlv_iter_next(&it, &t) == 1 && t.tag == 0x0001 && t.len == 3 &&
          memcmp(t.val, v1, 3) == 0);
    CHECK(qn_tlv_iter_next(&it, &t) == 1 && t.tag == 0x8000); /* skip rule */
    CHECK(qn_tlv_iter_next(&it, &t) == 0);
    CHECK(qn_tlv_find(tlv, tl, 0x8000, &t) == 1 && t.len == 1);
    CHECK(qn_tlv_find(tlv, tl, 0x0002, &t) == 0); /* absent, well-formed */

    /* malformed TLV: out-of-order, duplicate, truncated */
    uint8_t bad[16];
    size_t bl = qn_tlv_write(bad, sizeof bad, (const uint16_t[]){2, 1},
                             (const uint8_t *[]){v1, v2},
                             (const uint16_t[]){3, 1}, 2);
    CHECK(bl == 0); /* writer rejects out-of-order */
    qn_tlv_iter_init(&it, tlv, tl - 1); /* truncate the last value */
    CHECK(qn_tlv_iter_next(&it, &t) == 1);
    CHECK(qn_tlv_iter_next(&it, &t) == -1);
    CHECK(qn_tlv_find(tlv, tl - 1, 0x0001, &t) == -1);
    /* ^ find validates the whole stream: a defect anywhere rejects it,
     * even after the wanted tag has already been seen */
    {
        /* same-tag twice = malformed, even when the first copy parses */
        static const uint8_t dup[10] = { 0x00, 0x01, 0x00, 0x01, 0x41,
                                         0x00, 0x01, 0x00, 0x01, 0x42 };
        CHECK(qn_tlv_find(dup, sizeof dup, 0x0001, &t) == -1);
    }
    qn_tlv_iter_init(&it, tlv, tl);
    int seen = 0;
    while (qn_tlv_iter_next(&it, &t) == 1) {
        seen++;
    }
    CHECK(seen == 2);

    /* --- TLV writer rejects unsorted and oversized --- */
    CHECK(qn_tlv_write(tlv, sizeof tlv, (const uint16_t[]){1, 1},
                       (const uint8_t *[]){v1, v1},
                       (const uint16_t[]){3, 3}, 2) == 0);
    CHECK(qn_tlv_write(tlv, 4, (const uint16_t[]){1},
                       (const uint8_t *[]){v1}, (const uint16_t[]){3},
                       1) == 0);

    if (failures) {
        printf("QN_TESTS FAILED: %d/%d\n", failures, checks);
        return 1;
    }
    printf("QN_TESTS OK: %d checks\n", checks);
    return 0;
}
