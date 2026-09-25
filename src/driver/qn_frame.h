/* qn_frame.h — Plane A frames + TLV codec per src/protocol/qn_protocol.md §2.
 *
 * Parser doctrine: every failure is terminal for the connection (spec §8);
 * NEED_MORE is only legal between frames, never inside one. The stream is
 * never re-scanned for a fresh magic. */
#ifndef QN_FRAME_H
#define QN_FRAME_H

#include <stddef.h>
#include <stdint.h>

#define QN_MAGIC       0x514E4631u
#define QN_VERSION     0x0001u          /* major 0 << 8 | minor 1 */
#define QN_HEADER_LEN  14u
#define QN_CRC_LEN     4u
#define QN_MAX_PAYLOAD 2048u
#define QN_MAX_FRAME   (QN_HEADER_LEN + QN_MAX_PAYLOAD + QN_CRC_LEN)

typedef enum {
    QN_PARSE_OK       = 0,
    QN_PARSE_NEED_MORE = 1, /* not enough bytes buffered yet */
    QN_PARSE_BAD      = -1  /* malformed: caller must close the connection */
} qn_parse_t;

typedef struct {
    uint16_t        version;
    uint16_t        type;
    uint32_t        seq;
    const uint8_t  *payload;
    uint16_t        len;
    size_t          consumed; /* bytes of buffer occupied by this frame */
} qn_frame_t;

/* Plane A type values (spec §2.3). */
enum {
    QN_T_AUTH        = 0x0001,
    QN_T_PING        = 0x0002,
    QN_T_PONG        = 0x0003,
    QN_T_HOST_UP     = 0x0010,
    QN_T_HOST_DOWN   = 0x0011,
    QN_T_HOST_READY  = 0x0012,
    QN_T_JOIN_OPEN   = 0x0020,
    QN_T_JOIN_CLOSE  = 0x0021,
    QN_T_JOIN_PIN    = 0x0022,
    QN_T_JOIN_NO     = 0x0023,
    QN_T_PEER_UP     = 0x0030,
    QN_T_PEER_DOWN   = 0x0031,
    QN_T_SV_DATA     = 0x0040,
    QN_T_CL_DATA     = 0x0041,
    QN_T_STUFFTEXT   = 0x0050,
    QN_T_CLIENT_CMD  = 0x0060,
    QN_T_RELIABLE    = 0x0061,
    QN_T_FATAL       = 0x00FF
};

uint32_t qn_crc32(const uint8_t *data, size_t n);

/* One-time init before parsing anything (pre-warms shared tables). */
void qn_frame_init(void);

qn_parse_t qn_frame_parse(const uint8_t *buf, size_t n, qn_frame_t *out);

/* Serialise one frame; returns total length or 0 on rejection
 * (capacity overflow, zero sequence, oversized payload). */
size_t qn_frame_write(uint8_t *out, size_t cap, uint16_t type, uint32_t seq,
                      const uint8_t *payload, uint16_t len);

/* Sequence tracker (spec §2.2): init *last to 0; accepts a strictly
 * increasing sequence and records it. 1 = accept, 0 = reject (close). */
int qn_seq_accept(uint32_t *last, uint32_t got);

/* --- TLV (spec §2.4) --- */

typedef struct {
    uint16_t       tag;
    const uint8_t *val;
    uint16_t       len;
} qn_tlv_t;

/* Strict iteration over ascending, unique tags (state carries the previous
 * tag, so the check is linear). Experimental tags (>= 0x8000) are yielded
 * like any other; callers skip what they do not know.
 * Returns 1 (yielded), 0 (end), -1 (malformed stream — reject the message). */
typedef struct {
    const uint8_t *buf;
    size_t         n;
    size_t         pos;
    uint16_t       prev;
} qn_tlv_iter_t;

void qn_tlv_iter_init(qn_tlv_iter_t *it, const uint8_t *buf, size_t n);
int  qn_tlv_iter_next(qn_tlv_iter_t *it, qn_tlv_t *out);

/* Fetch one expected tag. The entire stream is validated first, so a
 * find-only consumer and a full iteration can never disagree:
 * 1 = found (out filled), 0 = absent, -1 = malformed (close). */
int qn_tlv_find(const uint8_t *buf, size_t n, uint16_t tag, qn_tlv_t *out);

/* Serialise tags with values; tags must be ascending and unique.
 * Returns total length or 0 on rejection. */
size_t qn_tlv_write(uint8_t *out, size_t cap, const uint16_t *tags,
                    const uint8_t *const *vals, const uint16_t *lens,
                    size_t count);

#endif /* QN_FRAME_H */
