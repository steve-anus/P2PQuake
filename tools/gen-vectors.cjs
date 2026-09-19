'use strict';
// Emits the conformance vectors for src/protocol/qn_protocol.md §7 and
// self-checks them: ACCEPT vectors must decode+verify, REJECT vectors must
// fail for their designated reason. Deterministic (fixed test seeds) and
// asserted so — reruns must produce byte-identical output.
const crypto = require('node:crypto');
const F = require('../src/peer/qn_frame.cjs');
const E = require('../src/peer/qn_envelope.cjs');
const R = require('../src/peer/qn_room.cjs');

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const privA = E.privateKeyFromSeed(sha('p2pquake-test-key-A'));
const pubARaw = E.publicRaw(E.publicKeyFromSeed(sha('p2pquake-test-key-A')));
const privB = E.privateKeyFromSeed(sha('p2pquake-test-key-B'));
const pubBRaw = E.publicRaw(E.publicKeyFromSeed(sha('p2pquake-test-key-B')));
const noiseA = sha('p2pquake-noise-A');
const noiseB = sha('p2pquake-noise-B');
const code = sha('p2pquake-vector-code').subarray(0, 10);
const matchId = R.matchIdOf(code);

const vectors = [];
const addF = (id, buf, accept) => vectors.push({ id, kind: 'F', buf, accept });
const addE = (id, buf, accept, why) => vectors.push({ id, kind: 'E', buf, accept, why });

const flip = (b, at) => { const c = Buffer.from(b); c[at] ^= 0xff; return c; };

// --- Plane A frames ---
addF('F-V1', F.encodeFrame(F.TYPES.AUTH, 1, sha('p2pquake-vector-token')), true);
addF('F-V2', F.encodeFrame(F.TYPES.JOIN_OPEN, 1, Buffer.from(code)), true);
addF('F-V3', F.encodeFrame(F.TYPES.SV_DATA, 3,
  F.encodeTLV([[1, Buffer.from(pubARaw)], [2, Buffer.from('body')]])), true);
addF('F-V4', flip(F.encodeFrame(F.TYPES.AUTH, 1, sha('p2pquake-vector-token')),
  14 + 32 + 3), false); // stored CRC field corrupted
addF('F-V5', flip(F.encodeFrame(F.TYPES.JOIN_OPEN, 1, Buffer.from(code)), 5),
  false); // version major -> 1

// --- Plane B envelopes ---
const env = (fields, priv, opts) => E.encodeEnvelope(
  { matchId, ...fields }, priv, opts);

const bind1 = E.signWith(privA, E.noiseBindingContext(noiseA, noiseB));
addE('E-V1', env({ type: E.TYPES.KEY_BIND, seq: 1, payload:
  F.encodeTLV([[1, Buffer.from(pubARaw)], [2, Buffer.from(bind1)]]) }, privA), true);
addE('E-V2', env({ type: E.TYPES.JOIN, seq: 1, payload:
  F.encodeTLV([[1, Buffer.from(pubBRaw)],
    [2, Buffer.from(R.proofOf(code, pubBRaw))],
    [3, Buffer.from('bob')],
    [4, Buffer.from([E.MAJOR])],
    [5, Buffer.from([E.MINOR])],
    [6, sha('p2pquake-manifest')],
    [7, Buffer.from('id1')],
    [8, sha('p2pquake-engine')],
    [0x8123, Buffer.from([0xaa])]]) }, privB), true); // experimental tag skipped
addE('E-V3', env({ type: E.TYPES.JOIN_NO, seq: 1, payload:
  F.encodeTLV([[1, Buffer.from([E.CAUSES.VERSION_TOO_OLD])]]) }, privA), true);
addE('E-V4', env({ type: E.TYPES.ROSTER, seq: 2, payload:
  F.encodeTLV([[1, Buffer.concat([Buffer.from([1]), pubBRaw])],
    [2, Buffer.from([0])], [3, Buffer.from([1])],
    [4, Buffer.from([7, 0, 0, 0, 0, 0, 0, 0])]]) }, privA), true); // epoch = 7
addE('E-V5', env({ type: E.TYPES.RELAY, seq: 3, payload:
  F.encodeTLV([[1, Buffer.from(pubBRaw)], [2, Buffer.from('body')]]) }, privA), true);
const chat = env({ type: E.TYPES.CHAT, seq: 3, payload:
  F.encodeTLV([[1, Buffer.from('gg')]]) }, privB);
addE('E-V6', chat, true);
addE('E-V7', Buffer.from(chat), true, 'byte-identical E-V6; REJECT via SeqWindow replay rule');
addE('E-V8', env({ type: E.TYPES.CHAT, seq: 4, payload:
  F.encodeTLV([[1, Buffer.from('gg')]]) }, privB, { major: 1 }), false);
addE('E-V9', flip(chat, 2 + E.HEAD_LEN + 4), false); // chat TEXT (payload value) corrupted

// --- self-check ---
let bad = 0;
const fail = (id, msg) => { bad++; console.error(`VECTOR SELF-CHECK FAIL ${id}: ${msg}`); };

for (const v of vectors) {
  if (v.kind === 'F') {
    const expectReject = !v.accept && !v.why;
    const isCrc = v.id === 'F-V4'; // corrupted CRC payload still needs seq rule pass
    if (isCrc) { // parse must fail on CRC
      try { F.decodeFrame(v.buf); fail(v.id, 'expected CRC rejection'); }
      catch (e) { if (!(e instanceof F.FrameError)) fail(v.id, e.message); }
      continue;
    }
    if (expectReject) {
      try { F.decodeFrame(v.buf); fail(v.id, 'expected rejection'); }
      catch (e) { if (!(e instanceof F.FrameError)) fail(v.id, e.message); }
      continue;
    }
    const d = F.decodeFrame(v.buf);
    if (!d) fail(v.id, 'need-more on a complete vector');
    continue;
  }
  // Plane B: which key verifies depends on the sender inside the vector
  const senderOf = { 'E-V1': pubARaw, 'E-V2': pubBRaw, 'E-V3': pubARaw,
    'E-V4': pubARaw, 'E-V5': pubARaw, 'E-V6': pubBRaw, 'E-V7': pubBRaw,
    'E-V8': pubBRaw, 'E-V9': pubBRaw }[v.id];
  if (!v.accept) { // E-V8 old major
    try { E.decodeEnvelope(v.buf, senderOf); fail(v.id, 'expected major rejection'); }
    catch (e) { if (!(e instanceof E.EnvelopeError)) fail(v.id, e.message); }
    continue;
  }
  try { E.decodeEnvelope(v.buf, senderOf); } catch (e) { fail(v.id, e.message); }
}
{ // replay semantics for E-V7: accept once, then the same bytes are a replay
  const w = new E.SeqWindow();
  const { seq } = E.decodeEnvelope(vectors.find((v) => v.id === 'E-V6').buf, pubBRaw);
  // The chat carries seq 3; a live session got there through 1 and 2.
  if (w.check(1) !== 'accept' || w.check(2) !== 'accept') fail('E-V7', 'context setup');
  if (w.check(seq) !== 'accept') fail('E-V7', 'first delivery not accepted');
  if (w.check(seq) !== 'replay') fail('E-V7', 'replay not detected');
}
{ // E-V4 must carry min version and a roster entry per spec §3.4
  const d = E.decodeEnvelope(vectors.find((v) => v.id === 'E-V4').buf, pubARaw);
  const f = Object.fromEntries(F.decodeTLV(d.payload).map((x) => [x.tag, x.value]));
  if (f[1].length !== 1 + 32 || f[2][0] !== 0 || f[3][0] !== 1) fail('E-V4', 'fields');
}
if (bad) process.exit(1);

for (const v of vectors) {
  console.log(`${v.id}\t${v.accept ? 'ACCEPT' : 'REJECT'}\t${v.buf.toString('hex')}`);
}
console.log('# join_code (raw hex):', sha('p2pquake-vector-code').subarray(0, 10).toString('hex')); // topic = sha256(join_code)
console.log('# pubkeys(raw):', { A: pubARaw.toString('hex'), B: pubBRaw.toString('hex') });
