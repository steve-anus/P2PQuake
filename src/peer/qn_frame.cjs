'use strict';
// Plane A (engine <-> qn-peer) frame codec per src/protocol/qn_protocol.md §2.
// Terminal-error doctrine: a malformed stream kills the connection; there is
// no rescan-for-magic. decodeFrame throws FrameError with code 'bad' (close)
// or returns null when more bytes are needed.

const MAGIC = 0x514e4631;
const VERSION = 0x0001; // major 0, minor 1
const HEADER_LEN = 14;
const CRC_LEN = 4;
const MAX_PAYLOAD = 2048;

const TYPES = Object.freeze({
  AUTH: 0x0001,
  PING: 0x0002,
  PONG: 0x0003,
  HOST_UP: 0x0010,
  HOST_DOWN: 0x0011,
  JOIN_OPEN: 0x0020,
  JOIN_CLOSE: 0x0021,
  PEER_UP: 0x0030,
  PEER_DOWN: 0x0031,
  SV_DATA: 0x0040,
  CL_DATA: 0x0041,
  STUFFTEXT: 0x0050,
  CLIENT_CMD: 0x0060,
  RELIABLE: 0x0061,
  FATAL: 0x00ff,
});

class FrameError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'FrameError';
    this.close = true; // every FrameError is terminal for the stream
  }
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Encode one frame. Validates per spec §2; throws RangeError on misuse.
function encodeFrame(type, seq, payload = Buffer.alloc(0)) {
  if (!Number.isInteger(type) || type < 0 || type > 0xffff) {
    throw new RangeError('type out of range');
  }
  if (!Number.isInteger(seq) || seq < 1) throw new RangeError('seq must be >= 1');
  if (payload.length > MAX_PAYLOAD) throw new RangeError('payload too large');
  const out = Buffer.alloc(HEADER_LEN + payload.length + CRC_LEN);
  out.writeUInt32LE(MAGIC, 0);
  out.writeUInt16LE(VERSION, 4);
  out.writeUInt16LE(type, 6);
  out.writeUInt32LE(seq, 8);
  out.writeUInt16LE(payload.length, 12);
  payload.copy(out, HEADER_LEN);
  out.writeUInt32LE(crc32(out.subarray(0, HEADER_LEN + payload.length)),
                    HEADER_LEN + payload.length);
  return out;
}

// Decode one frame from the front of buf. Returns { frame } or null
// (need more bytes). Throws FrameError on any malformed input.
function decodeFrame(buf) {
  if (buf.length < HEADER_LEN) return null;
  if (buf.readUInt32LE(0) !== MAGIC) throw new FrameError('bad magic');
  const version = buf.readUInt16LE(4);
  const type = buf.readUInt16LE(6);
  const seq = buf.readUInt32LE(8);
  const len = buf.readUInt16LE(12);
  if (version === 0 || (version >> 8) !== 0) throw new FrameError('version mismatch');
  if (len > MAX_PAYLOAD) throw new FrameError('oversized payload');
  if (seq === 0) throw new FrameError('zero seq');
  const total = HEADER_LEN + len + CRC_LEN;
  if (buf.length < total) return null;
  const want = buf.readUInt32LE(HEADER_LEN + len);
  if (want !== crc32(buf.subarray(0, HEADER_LEN + len))) {
    throw new FrameError('crc mismatch');
  }
  return {
    frame: {
      version, type, seq, len,
      payload: buf.subarray(HEADER_LEN, HEADER_LEN + len),
      consumed: total,
    },
  };
}

// Accumulating reader: feed bytes, get frames; a malformed stream is
// terminal (reader.dead). Enforces §2.2 seq rule per direction.
class FrameReader {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.lastSeq = 0;
    this.dropRun = 0; // consecutive unknown-type drops (spec §2.3)
    this.dead = false;
  }
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    return this.drain();
  }
  drain() {
    const out = [];
    while (!this.dead) {
      let d;
      try {
        d = decodeFrame(this.buf);
      } catch (e) {
        this.dead = true;
        throw e;
      }
      if (d === null) break;
      this.buf = this.buf.subarray(d.frame.consumed);
      if (d.frame.seq <= this.lastSeq) {
        this.dead = true;
        throw new FrameError('seq regression'); // spec §2.2: close
      }
      this.lastSeq = d.frame.seq;
      // Unknown types are drop-and-count for callers holding a known set;
      // count here, hand the frame to the caller to decide.
      out.push(d.frame);
    }
    return out;
  }
}

// --- TLV (spec §2.4) ---

function encodeTLV(fields) {
  // fields: array of [tag, Buffer]; ascending unique tags enforced by writer
  let prev = 0;
  for (const [tag] of fields) {
    if (!(tag > prev)) throw new RangeError('tags must ascend, no duplicates');
    prev = tag;
  }
  const parts = fields.map(([tag, val]) => {
    const h = Buffer.alloc(4);
    h.writeUInt16LE(tag, 0);
    h.writeUInt16LE(val.length, 2);
    return [h, val];
  });
  return Buffer.concat(parts.flat());
}

// Strict decode: returns array of {tag, value}; throws TLVError (caller
// treats as rejection — close/kill message) on descending, duplicate,
// or truncated entries. Unknown experimental tags are returned; the
// consumer skips what it does not know (spec §2.4/§3.5b).
class TLVError extends Error {}

function decodeTLV(buf) {
  const out = [];
  let pos = 0;
  let prev = 0;
  while (pos < buf.length) {
    if (buf.length - pos < 4) throw new TLVError('truncated header');
    const tag = buf.readUInt16LE(pos);
    const len = buf.readUInt16LE(pos + 2);
    if (tag <= prev) throw new TLVError('descending or duplicate tag');
    if (buf.length - pos - 4 < len) throw new TLVError('truncated value');
    out.push({ tag, value: buf.subarray(pos + 4, pos + 4 + len) });
    pos += 4 + len;
    prev = tag;
  }
  return out;
}

module.exports = {
  MAGIC, VERSION, HEADER_LEN, CRC_LEN, MAX_PAYLOAD, TYPES,
  FrameError, crc32, encodeFrame, decodeFrame, FrameReader,
  encodeTLV, decodeTLV, TLVError,
};
