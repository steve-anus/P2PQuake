'use strict';
// Fuzz target 2 (qn-peer remote wire parse) without clang: randomized
// mutation of valid Plane B envelopes and Plane A frames, run through the
// real readers. Legal outcomes: known error types only (EnvelopeError,
// FrameError, TLVError, RangeError) — anything else (TypeError etc) or a
// hang is a bug. Usage: make fuzz-node [QN_RUNS=n]
const crypto = require('node:crypto');
const F = require('../peer/qn_frame.cjs');
const E = require('../peer/qn_envelope.cjs');
const R = require('../peer/qn_room.cjs');

const RUNS = Number(process.env.QN_RUNS || 20000);
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const priv = E.privateKeyFromSeed(sha('fuzzwire-key'));
const pub = E.publicRaw(E.publicKeyFromSeed(sha('fuzzwire-key')));
const code = R.randomJoinCode();
const matchId = R.matchIdOf(code);

function randomValid(kind) {
  const seq = 1 + Math.floor(Math.random() * 1000);
  if (kind === 'A') {
    const type = [F.TYPES.AUTH, F.TYPES.PING, F.TYPES.SV_DATA, F.TYPES.STUFFTEXT,
      F.TYPES.FATAL][Math.floor(Math.random() * 5)];
    const len = Math.floor(Math.random() * 64);
    return F.encodeFrame(type, seq, crypto.randomBytes(len));
  }
  const type = [E.TYPES.CHAT, E.TYPES.JOIN, E.TYPES.RELAY, E.TYPES.ROSTER,
    E.TYPES.PING][Math.floor(Math.random() * 5)];
  const payload = F.encodeTLV([[1, crypto.randomBytes(1 + Math.floor(Math.random() * 40))]]);
  return E.encodeEnvelope({ type, matchId, seq, payload }, priv);
}

function mutate(buf) {
  const b = Buffer.from(buf);
  const mode = Math.floor(Math.random() * 4);
  if (mode === 0 && b.length) b[Math.floor(Math.random() * b.length)] ^= 1 << Math.floor(Math.random() * 8);
  else if (mode === 1) return b.subarray(0, Math.floor(Math.random() * (b.length + 1))); // truncate
  else if (mode === 2) return Buffer.concat([b, crypto.randomBytes(Math.floor(Math.random() * 16))]); // append junk
  else if (mode === 3 && b.length > 8) crypto.randomBytes(8).copy(b, Math.floor(Math.random() * (b.length - 8))); // splice
  return b;
}

const LEGAL = [E.EnvelopeError, F.FrameError, F.TLVError, RangeError];
let survived = 0, rejected = 0;
const t0 = Date.now();
for (let i = 0; i < RUNS; i++) {
  const kind = i % 2 ? 'A' : 'B';
  const input = mutate(randomValid(kind));
  try {
    if (kind === 'A') {
      const r = new F.FrameReader();
      try { r.feed(input); survived++; }
      catch (e) { if (!(e instanceof F.FrameError)) throw e; rejected++; }
    } else {
      const rd = new E.EnvelopeReader();
      try {
        for (const raw of rd.feed(input)) {
          E.decodeEnvelope(raw, pub); // must verify or throw EnvelopeError
        }
        survived++;
      } catch (e) {
        if (!(e instanceof E.EnvelopeError)) throw e;
        rejected++;
      }
    }
  } catch (e) {
    if (!LEGAL.some((T) => e instanceof T)) {
      console.log('FUZZ FAIL: illegal outcome', e.constructor.name, e.message);
      console.log('input kind', kind, 'hex', input.toString('hex'));
      process.exit(1);
    }
    rejected++;
  }
}
console.log(`FUZZ-NODE OK: ${RUNS} mutations — ${survived} parsed, ${rejected} rejected cleanly, ${Date.now() - t0} ms`);
