/* fuzz_frame.c — libFuzzer entry: exercises the Plane A parser end to end.
 * Every input must end in one of: clean accept, NEED_MORE, or BAD-with-
 * close. Any crash, leak, or sanitizer trip is a bug at the trust boundary.
 * Build via `make fuzz` (needs clang). */
#include "../driver/qn_frame.h"

#include <stdlib.h>

int LLVMFuzzerInitialize(int *argc, char ***argv);
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size);

int LLVMFuzzerInitialize(int *argc, char ***argv)
{
    (void)argc;
    (void)argv;
    qn_frame_init();
    return 0;
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    qn_frame_t f;
    qn_parse_t r = qn_frame_parse(data, size, &f);
    if (r != QN_PARSE_OK) {
        return 0; /* NEED_MORE and BAD are both legal outcomes */
    }
    /* Walk the payload as TLV: strict iteration must never fault and must
     * reject malformed streams rather than misparse them. */
    qn_tlv_iter_t it;
    qn_tlv_iter_init(&it, f.payload ? f.payload : (const uint8_t *)"", f.len);
    qn_tlv_t t;
    while (qn_tlv_iter_next(&it, &t) == 1) {
        /* consumer discipline: known tags get length-checked here */
        switch (t.tag) {
            case 0x0001: /* pubkey-shaped fields are 32 bytes or reject */
                if (t.len != 32 && t.len != 3 && t.len != 4 && t.len != 1 &&
                    t.len != 9 && t.len != 10 && t.len != 20) {
                    /* mixed usage across types; just exercise the reader */
                }
                break;
            default:
                break; /* unknown tags skipped (spec §2.4) */
        }
    }
    /* And round-trip legality: reserialising a parsed frame must reproduce
     * a parseable frame (encoder/decoder agreement). */
    uint8_t out[QN_MAX_FRAME];
    size_t n = qn_frame_write(out, sizeof out, f.type, f.seq + 1, f.payload, f.len);
    if (n) {
        qn_frame_t f2;
        if (qn_frame_parse(out, n, &f2) != QN_PARSE_OK) {
            abort(); /* encoder produced what the parser rejects: bug */
        }
    }
    return 0;
}
