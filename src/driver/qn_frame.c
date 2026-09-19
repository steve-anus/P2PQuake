/* qn_frame.c — Plane A codec per src/protocol/qn_protocol.md §2.
 * Linear in input size; no rescans, no re-sync hunting (spec §8). */
#include "qn_frame.h"

#include <string.h>

/* ---- CRC32 (IEEE: poly 0xEDB88320, init/final inversion) ---- */

static uint32_t crc_tab[256];
static int crc_ready;

static void crc_init(void)
{
    if (crc_ready) {
        return;
    }
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int k = 0; k < 8; k++) {
            c = (c & 1u) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        }
        crc_tab[i] = c;
    }
    crc_ready = 1;
}

uint32_t qn_crc32(const uint8_t *data, size_t n)
{
    crc_init();
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++) {
        c = crc_tab[(c ^ data[i]) & 0xFFu] ^ (c >> 8);
    }
    return c ^ 0xFFFFFFFFu;
}

/* ---- little-endian reads ---- */

static uint16_t rd16(const uint8_t *p)
{
    return (uint16_t)(p[0] | (p[1] << 8));
}

static uint32_t rd32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

static void wr16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v & 0xFFu);
    p[1] = (uint8_t)(v >> 8);
}

static void wr32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v & 0xFFu);
    p[1] = (uint8_t)((v >> 8) & 0xFFu);
    p[2] = (uint8_t)((v >> 16) & 0xFFu);
    p[3] = (uint8_t)(v >> 24);
}

/* ---- frame parse / write ---- */

qn_parse_t qn_frame_parse(const uint8_t *buf, size_t n, qn_frame_t *out)
{
    if (n < QN_HEADER_LEN) {
        return QN_PARSE_NEED_MORE;
    }
    if (rd32(buf) != QN_MAGIC) {
        return QN_PARSE_BAD;
    }
    uint16_t version = rd16(buf + 4);
    uint16_t type = rd16(buf + 6);
    uint32_t seq = rd32(buf + 8);
    uint16_t len = rd16(buf + 12);

    if (version == 0 || (version >> 8) != 0) {
        return QN_PARSE_BAD; /* major mismatch or the forbidden zero */
    }
    if (len > QN_MAX_PAYLOAD) {
        return QN_PARSE_BAD;
    }
    if (seq == 0) {
        return QN_PARSE_BAD; /* sequences start at 1 (spec §2.2) */
    }

    size_t total = QN_HEADER_LEN + (size_t)len + QN_CRC_LEN;
    if (n < total) {
        return QN_PARSE_NEED_MORE; /* between frames only — caller buffers */
    }
    if (rd32(buf + QN_HEADER_LEN + len) != qn_crc32(buf, QN_HEADER_LEN + len)) {
        return QN_PARSE_BAD;
    }

    out->version = version;
    out->type = type;
    out->seq = seq;
    out->len = len;
    out->payload = len ? buf + QN_HEADER_LEN : NULL;
    out->consumed = total;
    return QN_PARSE_OK;
}

size_t qn_frame_write(uint8_t *out, size_t cap, uint16_t type, uint32_t seq,
                      const uint8_t *payload, uint16_t len)
{
    if (seq == 0 || len > QN_MAX_PAYLOAD) {
        return 0;
    }
    size_t total = QN_HEADER_LEN + (size_t)len + QN_CRC_LEN;
    if (cap < total) {
        return 0;
    }
    wr32(out, QN_MAGIC);
    wr16(out + 4, QN_VERSION);
    wr16(out + 6, type);
    wr32(out + 8, seq);
    wr16(out + 12, len);
    if (len) {
        memcpy(out + QN_HEADER_LEN, payload, len);
    }
    wr32(out + QN_HEADER_LEN + len, qn_crc32(out, QN_HEADER_LEN + len));
    return total;
}

int qn_seq_accept(uint32_t *last, uint32_t got)
{
    if (got == 0 || got <= *last) {
        return 0;
    }
    *last = got;
    return 1;
}

/* ---- TLV ---- */

void qn_tlv_iter_init(qn_tlv_iter_t *it, const uint8_t *buf, size_t n)
{
    it->buf = buf;
    it->n = n;
    it->pos = 0;
    it->prev = 0; /* tag 0 is unassigned; first tag must exceed it */
}

int qn_tlv_iter_next(qn_tlv_iter_t *it, qn_tlv_t *out)
{
    if (it->pos == it->n) {
        return 0;
    }
    if (it->n - it->pos < 4) {
        return -1;
    }
    uint16_t tag = rd16(it->buf + it->pos);
    uint16_t len = rd16(it->buf + it->pos + 2);
    if (tag <= it->prev) {
        return -1; /* descending or duplicate */
    }
    if (it->n - it->pos - 4 < len) {
        return -1; /* truncated value */
    }
    out->tag = tag;
    out->val = it->buf + it->pos + 4;
    out->len = len;
    it->pos += 4 + (size_t)len;
    it->prev = tag;
    return 1;
}

int qn_tlv_find(const uint8_t *buf, size_t n, uint16_t tag, qn_tlv_t *out)
{
    qn_tlv_iter_t it;
    qn_tlv_iter_init(&it, buf, n);
    qn_tlv_t f;
    while (qn_tlv_iter_next(&it, &f) == 1) {
        if (f.tag == tag) {
            *out = f;
            return 1;
        }
        if (f.tag > tag) {
            return 0; /* ascending order: can't appear later */
        }
    }
    return -1;
}

size_t qn_tlv_write(uint8_t *out, size_t cap, const uint16_t *tags,
                    const uint8_t *const *vals, const uint16_t *lens,
                    size_t count)
{
    size_t need = 0;
    uint16_t prev = 0;
    for (size_t i = 0; i < count; i++) {
        if (tags[i] <= prev || lens[i] > QN_MAX_PAYLOAD) {
            return 0;
        }
        prev = tags[i];
        need += 4 + (size_t)lens[i];
    }
    if (need > cap) {
        return 0;
    }
    size_t p = 0;
    for (size_t i = 0; i < count; i++) {
        wr16(out + p, tags[i]);
        wr16(out + p + 2, lens[i]);
        if (lens[i]) {
            memcpy(out + p + 4, vals[i], lens[i]);
        }
        p += 4 + (size_t)lens[i];
    }
    return p;
}
