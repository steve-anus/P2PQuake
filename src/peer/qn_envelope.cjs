'use strict';
// Plane B (peer <-> peer) signed envelope per src/protocol/qn_protocol.md §3.
// Identity doctrine: nothing in a payload is trusted until the §3.2 signature
// verifies; names/ids are display hints. All crypto from node:crypto
// (Ed25519, SHA-256) — the algorithm list is spec §5.3.

const crypto = require('node:crypto');

const MAGIC = 0x514e; // "QN"
const MAJOR = 0;
const MINOR = 2;
const MAX_PAYLOAD = 1200;
const SIG_LEN = 64;
const HEAD_LEN = 28; // magic(2) major(1) minor(1) type(2) matchId(16) seq(4) len(2)

const TYPES = Object.freeze({
  KEY_BIND: 0x0001,
  JOIN: 0x0010,
  JOIN_OK: 0x0011,
  JOIN_NO: 0x0012,
  ROSTER: 0x0020,
  RELAY: 0x0030,
  CHAT: 0x0040,
  BYE: 0x0050,
  PING: 0x00ff,
  PONG: 0x0100,
});

const CAUSES = Object.freeze({
  VERSION_TOO_OLD: 1,
  BAD_PROOF: 2,
  MATCH_FULL: 3,
  MATCH_CLOSED: 4,
  DUP_IDENTITY: 5,
  RATE_LIMITED: 6,
  ASSET_MISMATCH: 7,
});

class EnvelopeError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'EnvelopeError';
    this.close = true; // spec §3.1: any failure closes the connection
  }
}

// --- Ed25519 helpers over node:crypto (raw 32-byte keys via DER prefixes) ---

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function privateKeyFromSeed(seed) {
  if (seed.length !== 32) throw new RangeError('seed must be 32 bytes');
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

function publicKeyFromSeed(seed) {
  return crypto.createPublicKey(privateKeyFromSeed(seed));
}

function publicRaw(pubKey) {
  const der = pubKey.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32);
}

function publicKeyFromRaw(raw) {
  if (raw.length !== 32) throw new RangeError('raw pubkey must be 32 bytes');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function signWith(privKey, msg) {
  return crypto.sign(null, msg, privKey);
}

function verifyWith(pubKeyOrRaw, msg, sig) {
  try {
    const key = Buffer.isBuffer(pubKeyOrRaw) ? publicKeyFromRaw(pubKeyOrRaw) : pubKeyOrRaw;
    return crypto.verify(null, msg, key, sig);
  } catch (e) {
    throw new EnvelopeError('verify error: ' + e.message);
  }
}

// §3.2: signature is Ed25519 over sha256("QNW0" || envelope bytes [0, 28+n))
function signatureContext(bytesForSig) {
  return crypto.createHash('sha256')
    .update(Buffer.from('QNW0'))
    .update(bytesForSig)
    .digest();
}

// §3.4 KEY_BIND channel binding: signature by the long-term key over
// sha256("QNWB" || min(a,b) || max(a,b)), the two noise keys of this
// connection in ascending order so both endpoints derive the same value.
function noiseBindingContext(ourNoise, theirNoise) {
  if (!Buffer.isBuffer(ourNoise) || ourNoise.length !== 32 ||
      !Buffer.isBuffer(theirNoise) || theirNoise.length !== 32) {
    throw new RangeError('noise keys must be 32-byte buffers');
  }
  const [lo, hi] = Buffer.compare(ourNoise, theirNoise) <= 0
    ? [ourNoise, theirNoise] : [theirNoise, ourNoise];
  return crypto.createHash('sha256')
    .update(Buffer.from('QNWB'))
    .update(lo).update(hi)
    .digest();
}

// --- encode / decode ---

// {type, matchId(16B), seq, payload(Buffer)} + privKey -> full stream chunk
// (u16 total_len prefix included). Throws RangeError on misuse.
function encodeEnvelope(fields, privKey, { major = MAJOR, minor = MINOR } = {}) {
  const { type, matchId, seq, payload } = fields;
  if (!Buffer.isBuffer(matchId) || matchId.length !== 16) throw new RangeError('matchId 16 bytes');
  if (!Number.isInteger(seq) || seq < 1) throw new RangeError('seq must be >= 1');
  if (seq > 0xffffffff) throw new EnvelopeError('seq overflow — close and reconnect (§3.3)');
  if (!Buffer.isBuffer(payload) || payload.length > MAX_PAYLOAD) throw new RangeError('payload limit');
  if (type < 0 || type > 0xffff) throw new RangeError('type out of range');
  const body = Buffer.alloc(HEAD_LEN + payload.length + SIG_LEN);
  let p = 0;
  body.writeUInt16LE(MAGIC, p); p += 2;
  body.writeUInt8(major & 0xff, p);
  body.writeUInt8(minor & 0xff, p + 1); p += 2;
  body.writeUInt16LE(type, p); p += 2;
  matchId.copy(body, p); p += 16;
  body.writeUInt32LE(seq, p); p += 4;
  body.writeUInt16LE(payload.length, p); p += 2;
  payload.copy(body, p); p += payload.length;
  const sig = signWith(privKey, signatureContext(body.subarray(0, HEAD_LEN + payload.length)));
  sig.copy(body, p);
  const out = Buffer.alloc(2 + body.length);
  out.writeUInt16LE(body.length, 0);
  body.copy(out, 2);
  return out;
}

// Decode one complete envelope buffer (framing done by EnvelopeReader).
// verifyKey: Buffer(32 raw) | KeyObject. For KEY_BIND pass the pubkey found
// inside the payload (room layer does that check itself).
// expectedMatchId: 16-byte Buffer; a mismatch is a close (§3.1).
function decodeEnvelope(buf, verifyKey, { expectedMatchId } = {}) {
  if (buf.length < 2 + HEAD_LEN + SIG_LEN) throw new EnvelopeError('short envelope');
  const total = buf.readUInt16LE(0);
  const min = 2 + HEAD_LEN + SIG_LEN;
  const max = 2 + HEAD_LEN + MAX_PAYLOAD + SIG_LEN;
  if (total < min - 2 || total > max - 2) throw new EnvelopeError('total_len out of range');
  if (buf.length !== total + 2) throw new EnvelopeError('buffer must hold exactly one envelope');
  let p = 2;
  if (buf.readUInt16LE(p) !== MAGIC) throw new EnvelopeError('bad magic'); p += 2;
  const major = buf.readUInt8(p);
  const minor = buf.readUInt8(p + 1); p += 2;
  if (major !== MAJOR) throw new EnvelopeError('major mismatch'); // spec §3.5c
  const type = buf.readUInt16LE(p); p += 2;
  const matchId = buf.subarray(p, p + 16); p += 16;
  const seq = buf.readUInt32LE(p); p += 4;
  if (seq === 0) throw new EnvelopeError('zero seq');
  const len = buf.readUInt16LE(p); p += 2;
  if (len > MAX_PAYLOAD) throw new EnvelopeError('oversized payload');
  if (total !== HEAD_LEN + len + SIG_LEN) throw new EnvelopeError('length desync');
  if (expectedMatchId !== undefined && !matchId.equals(expectedMatchId))
    throw new EnvelopeError('wrong match');
  const payload = buf.subarray(p, p + len); p += len;
  const sig = buf.subarray(p, p + SIG_LEN);
  if (!verifyWith(verifyKey, signatureContext(buf.subarray(2, 2 + HEAD_LEN + len)), sig)) {
    throw new EnvelopeError('signature failure');
  }
  return { major, minor, type, matchId, seq, payload };
}

// Stream accumulation for Plane B: u16-prefix framing; every error is
// terminal (reader.dead).
class EnvelopeReader {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.dead = false;
  }
  feed(chunk) {
    if (this.dead) return []; // dead readers must not accumulate further bytes
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    return this.drain();
  }
  drain() {
    const out = [];
    while (!this.dead) {
      if (this.buf.length < 2) break;
      const total = this.buf.readUInt16LE(0);
      const min = 2 + HEAD_LEN + SIG_LEN - 2;
      const max = 2 + HEAD_LEN + MAX_PAYLOAD + SIG_LEN - 2;
      if (total < min || total > max) {
        this.dead = true;
        throw new EnvelopeError('total_len out of range');
      }
      if (this.buf.length < total + 2) break;
      const one = this.buf.subarray(0, total + 2);
      this.buf = this.buf.subarray(total + 2);
      out.push(one);
    }
    return out;
  }
}

// §3.3 replay/gap rules for one (connection, sending-key) pair.
// First accepted seq must be 1; strict increase; >100 drops closes;
// forward gap > 64 closes.
class SeqWindow {
  constructor({ maxDrops = 100, maxGap = 64 } = {}) {
    this.highest = 0;
    this.drops = 0;
    this.maxDrops = maxDrops;
    this.maxGap = maxGap;
  }
  check(seq) {
    if (this.highest === 0 && seq !== 1) return 'close-first';
    if (seq <= this.highest) {
      this.drops++;
      return this.drops > this.maxDrops ? 'close-drops' : 'replay';
    }
    if (seq - this.highest - 1 > this.maxGap) return 'close-gap';
    this.highest = seq;
    return 'accept';
  }
}

// §6.1 per-connection message rate: token bucket 200/s, burst 50.
class RateBucket {
  constructor({ rate = 200, burst = 50, now = () => globalThis.performance.now() } = {}) {
    this.rate = rate; this.burst = burst; this.tokens = burst; this.last = now();
    this.now = now;
  }
  consume() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

module.exports = {
  MAGIC, MAJOR, MINOR, MAX_PAYLOAD, HEAD_LEN, TYPES, CAUSES,
  EnvelopeError, EnvelopeReader, SeqWindow, RateBucket,
  privateKeyFromSeed, publicKeyFromSeed, publicKeyFromRaw, publicRaw,
  signWith, verifyWith, signatureContext, noiseBindingContext,
  encodeEnvelope, decodeEnvelope,
};
