'use strict';
// Plane B envelope + identity/sequence/rate discipline (spec §3, §5, §6).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const E = require('./qn_envelope.cjs');
const R = require('./qn_room.cjs');
const F = require('./qn_frame.cjs');

const seedA = crypto.createHash('sha256').update('p2pquake-test-key-A').digest();
const seedB = crypto.createHash('sha256').update('p2pquake-test-key-B').digest();
const privA = E.privateKeyFromSeed(seedA);
const pubA = E.publicKeyFromSeed(seedA);
const pubARaw = E.publicRaw(pubA);
const privB = E.privateKeyFromSeed(seedB);
const pubB = E.publicKeyFromSeed(seedB);
const pubBRaw = E.publicRaw(pubB);
const code = crypto.createHash('sha256').update('p2pquake-vector-code').digest().subarray(0, 10);
const matchId = R.matchIdOf(code);

function env(type, seq, payload, priv, opts) {
  return E.encodeEnvelope({ type, matchId, seq, payload }, priv, opts);
}

test('ed25519 sign/verify round-trip and key mismatch', () => {
  const msg = Buffer.from('message');
  const sig = E.signWith(privA, msg);
  assert.ok(E.verifyWith(pubARaw, msg, sig));
  assert.ok(!E.verifyWith(pubBRaw, msg, sig));
  assert.equal(pubARaw.length, 32);
});

test('envelope round-trip verifies under the sender key', () => {
  const buf = env(E.TYPES.CHAT, 1, F.encodeTLV([[1, Buffer.from('hi')]]), privB);
  const d = E.decodeEnvelope(buf, pubBRaw);
  assert.equal(d.type, E.TYPES.CHAT);
  assert.equal(d.seq, 1);
  assert.deepEqual(d.matchId, matchId);
  const [f] = F.decodeTLV(d.payload);
  assert.equal(f.value.toString(), 'hi');
});

test('tampering is a signature failure (verify before read, §8.2)', () => {
  const buf = env(E.TYPES.CHAT, 1, Buffer.from([1, 0, 2, 0, 65, 66]), privB);
  const bad = Buffer.from(buf);
  bad[2 + E.HEAD_LEN + 2] ^= 0xff; // flip a payload byte
  assert.throws(() => E.decodeEnvelope(bad, pubBRaw), E.EnvelopeError);
});

test('foreign sender key fails verification', () => {
  const buf = env(E.TYPES.CHAT, 1, Buffer.alloc(0), privB);
  assert.throws(() => E.decodeEnvelope(buf, pubARaw), E.EnvelopeError);
});

test('old major is refused outright (guard §3.5c)', () => {
  const buf = env(E.TYPES.CHAT, 1, Buffer.alloc(0), privB, { major: 1 });
  assert.throws(() => E.decodeEnvelope(buf, pubBRaw), /major mismatch/);
});

test('unknown minor version is accepted at envelope layer (guard §3.5b)', () => {
  const buf = env(E.TYPES.CHAT, 1, Buffer.alloc(0), privB, { minor: 9 });
  const d = E.decodeEnvelope(buf, pubBRaw);
  assert.equal(d.minor, 9); // skip-unknown lives with the TLV consumers
});

test('total_len bounds are terminal for the reader', () => {
  const reader = new E.EnvelopeReader();
  assert.throws(() => reader.feed(Buffer.from([0xff, 0xff, ...new Array(90).fill(0)])),
    E.EnvelopeError);
  assert.ok(reader.dead);
});

test('SeqWindow: first must be 1, strict increase, replay/gap rules (§3.3)', () => {
  const w = new E.SeqWindow();
  assert.equal(w.check(5), 'close-first');      // mid-stream starts close, never judge
  assert.equal(w.check(1), 'accept');
  assert.equal(w.check(2), 'accept');
  assert.equal(w.check(2), 'replay');           // duplicate counted
  assert.equal(w.check(1), 'replay');           // regression counted
  assert.equal(w.check(66), 'accept');          // gap 63 is within the 64 rule
  const w2 = new E.SeqWindow();
  w2.check(1);
  assert.equal(w2.check(67), 'close-gap');      // gap 65 > 64
  const w3 = new E.SeqWindow({ maxDrops: 3 });
  w3.check(1);
  for (let i = 0; i < 3; i++) assert.match(w3.check(1), /replay|close/);
  assert.equal(w3.check(1), 'close-drops');     // 4th drop > maxDrops=3
});

test('RateBucket: burst then deny then refill (§6.1)', () => {
  let t = 0;
  const b = new E.RateBucket({ rate: 200, burst: 3, now: () => t });
  assert.ok(b.consume() && b.consume() && b.consume());
  assert.ok(!b.consume());
  t += 10; // 2 tokens in 10 ms at 200/s
  assert.ok(b.consume() && b.consume());
  assert.ok(!b.consume());
});

test('KEY_BIND channel binding matches at both endpoints (§3.4)', () => {
  const noiseA = Buffer.alloc(32, 0xaa);
  const noiseB = Buffer.alloc(32, 0xbb);
  const sig = E.signWith(privA, E.noiseBindingContext(noiseA, noiseB));
  // The peer, seeing the pair from its side, derives the identical value.
  assert.ok(E.verifyWith(pubARaw, E.noiseBindingContext(noiseB, noiseA), sig));
  // A third connection's keys must not verify this binding.
  assert.ok(!E.verifyWith(pubARaw,
    E.noiseBindingContext(noiseB, Buffer.alloc(32, 0xcc)), sig));
  assert.throws(() => E.noiseBindingContext(noiseA, Buffer.alloc(31)), RangeError);
});

test('room derivation matches spec §5 deterministically', () => {
  const topic = R.topicOf(code);
  assert.equal(topic.toString('hex'),
    crypto.createHash('sha256').update(code).digest('hex'));
  assert.deepEqual(R.matchIdOf(code), topic.subarray(0, 16));
  const mk = R.membershipKey(code);
  assert.equal(mk.length, 32);
  const pub = pubBRaw;
  const proof = R.proofOf(code, pub);
  assert.ok(R.verifyProof(code, pub, proof));
  assert.ok(!R.verifyProof(code, pubARaw, proof));   // wrong identity
  assert.ok(!R.verifyProof(Buffer.alloc(10), pub, proof)); // wrong code
});

test('display codes are 16 Crockford chars, losslessly round-tripped', () => {
  for (let i = 0; i < 50; i++) {
    const c = R.randomJoinCode();
    const d = R.codeFromBytes(c);
    assert.match(d, /^[0-9A-HJ-NP-TV-Z]{4}(-[0-9A-HJ-NP-TV-Z]{4}){3}$/);
    assert.deepEqual(R.bytesFromCode(d), c);
    assert.deepEqual(R.bytesFromCode(d.toLowerCase()), c); // case-insensitive
  }
  assert.throws(() => R.bytesFromCode('IIII-LLLL-OOOO-UVWX'), RangeError);
});

/* --- room discipline (spec §3.1/§3.2) --- */
{
  const seed = crypto.createHash('sha256').update('room-discipline').digest();
  const priv = E.privateKeyFromSeed(seed);
  const pub = E.publicRaw(E.publicKeyFromSeed(seed));
  const mid = crypto.createHash('sha256').update('match').digest().subarray(0, 16);
  const raw = E.encodeEnvelope(
    { type: E.TYPES.CHAT, matchId: mid, seq: 1,
      payload: F.encodeTLV([[1, Buffer.from('hi')]]) }, priv);

  test('envelope carries its room: foreign match_id closes (§3.1)', () => {
    assert.equal(E.decodeEnvelope(raw, pub, { expectedMatchId: mid }).seq, 1);
    assert.throws(() => E.decodeEnvelope(raw, pub, { expectedMatchId: Buffer.alloc(16, 7) }),
      (e) => e instanceof E.EnvelopeError && /wrong match/.test(e.message));
  });

  test('declared length disagreeing with content closes (§3.1)', () => {
    const bad = Buffer.from(raw);
    bad.writeUInt16LE(500, 2 + 26); /* payload_len field of the body */
    assert.throws(() => E.decodeEnvelope(bad, pub), E.EnvelopeError);
  });

  test('claimed key of wrong shape surfaces as EnvelopeError only (§3.2)', () => {
    for (const junk of [Buffer.alloc(5), 'not-a-key', undefined, null]) {
      assert.throws(() => E.decodeEnvelope(raw, junk), E.EnvelopeError);
    }
  });
}

test('join-lane wire constants pinned to spec (§3.4a, §6.2)', () => {
  assert.equal(E.CAUSES.ASSET_MISMATCH, 7);
  assert.equal(Object.keys(E.CAUSES).length, 7);
});

test('encodeEnvelope refuses seq overflow as an EnvelopeError (close, not crash — §3.3)', () => {
  const priv = E.privateKeyFromSeed(seedA);
  const base = { type: E.TYPES.CHAT, matchId: Buffer.alloc(16, 1), payload: Buffer.from('hi') };
  assert.throws(() => E.encodeEnvelope({ ...base, seq: 0x100000000 }, priv), E.EnvelopeError);
});

test('a dead EnvelopeReader discards further feed instead of accumulating', () => {
  const rd = new E.EnvelopeReader();
  assert.throws(() => rd.feed(Buffer.from('zz')), E.EnvelopeError);
  assert.equal(rd.dead, true);
  const before = rd.buf.length;
  for (let i = 0; i < 5; i++) assert.deepEqual(rd.feed(Buffer.alloc(900)), []);
  assert.equal(rd.buf.length, before);
});

test('display-code parser rejects unicode case-folding tricks', () => {
  for (const evil of ['\u017F'.repeat(16), '\uFB05'.repeat(8), 'A'.repeat(15) + '\u0131'])
    assert.throws(() => R.bytesFromCode(evil), RangeError);
});

test('room derivations demand raw code bytes, not display strings', () => {
  const display = 'ABCDEFGH-JKMNPQRS-01234567-89ABCDEM';
  for (const f of [R.topicOf, R.matchIdOf, R.membershipKey])
    assert.throws(() => f(display), TypeError);
  assert.throws(() => R.proofOf(display, Buffer.alloc(32)), TypeError);
});
