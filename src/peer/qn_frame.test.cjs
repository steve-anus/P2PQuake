'use strict';
// Plane A codec conformance (spec §2/§8) — Node side. The C suite in
// src/tests/test_frame.c covers the same rules; golden vectors in the spec
// (§7) bind the two implementations together.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const F = require('./qn_frame.cjs');

test('crc32 standard check value (IEEE parameter set)', () => {
  assert.equal(F.crc32(Buffer.from('123456789')), 0xcbf43926);
});

const payloadTypes = [
  ['AUTH', F.TYPES.AUTH, Buffer.alloc(32, 0xa5)],
  ['PING', F.TYPES.PING, Buffer.from([1, 0, 0, 0])],
  ['HOST_DOWN empty', F.TYPES.HOST_DOWN, Buffer.alloc(0)],
  ['JOIN_CLOSE empty', F.TYPES.JOIN_CLOSE, Buffer.alloc(0)],
  ['JOIN_OPEN', F.TYPES.JOIN_OPEN, Buffer.alloc(10, 0x42)],
  ['STUFFTEXT', F.TYPES.STUFFTEXT, Buffer.from('say hello')],
  ['FATAL', F.TYPES.FATAL, Buffer.from([3])],
  ['SV_DATA at payload cap', F.TYPES.SV_DATA, Buffer.alloc(2048, 0x5a)],
];
for (const [name, type, payload] of payloadTypes) {
  test(`round-trip ${name}`, () => {
    const buf = F.encodeFrame(type, 1, payload);
    const d = F.decodeFrame(buf);
    assert.ok(d, 'decoded');
    assert.equal(d.frame.type, type);
    assert.equal(d.frame.seq, 1);
    assert.deepEqual(d.frame.payload, payload);
    assert.equal(d.frame.consumed, buf.length);
  });
}

test('malformed frames are terminal', () => {
  const good = F.encodeFrame(F.TYPES.PING, 1, Buffer.from([7, 0, 0, 0]));
  const corrupt = (mut) => {
    const b = Buffer.from(good);
    mut(b);
    assert.throws(() => F.decodeFrame(b), (e) => e instanceof F.FrameError);
  };
  corrupt((b) => { b[0] ^= 0xff; });                       // magic
  corrupt((b) => { b.writeUInt16LE(0, 4); });               // version 0
  corrupt((b) => { b.writeUInt16LE(0x0100, 4); });          // major mismatch
  corrupt((b) => { b.writeUInt16LE(2049, 12); });           // oversized len
  corrupt((b) => { b.writeUInt32LE(0, 8); });               // zero seq
  corrupt((b) => { b[14] ^= 0x01; });                       // payload vs CRC
  corrupt((b) => { b[b.length - 1] ^= 0x80; });             // stored CRC
});

test('partial streams ask for more bytes', () => {
  const good = F.encodeFrame(F.TYPES.PING, 1, Buffer.from([7, 0, 0, 0]));
  assert.equal(F.decodeFrame(good.subarray(0, 6)), null);
  assert.equal(F.decodeFrame(good.subarray(0, good.length - 1)), null);
});

test('two stacked frames decode sequentially with exact consumed', () => {
  const one = F.encodeFrame(F.TYPES.PING, 1, Buffer.from([7, 0, 0, 0]));
  const two = F.encodeFrame(F.TYPES.PONG, 2, Buffer.from([7, 0, 0, 0]));
  const stream = Buffer.concat([one, two]);
  const d1 = F.decodeFrame(stream);
  assert.equal(d1.frame.consumed, one.length);
  const d2 = F.decodeFrame(stream.subarray(d1.frame.consumed));
  assert.equal(d2.frame.type, F.TYPES.PONG);
});

test('encode rejects misuse (spec §2)', () => {
  assert.throws(() => F.encodeFrame(F.TYPES.PING, 0), RangeError);
  assert.throws(() => F.encodeFrame(F.TYPES.PING, 1, Buffer.alloc(2049)), RangeError);
  assert.throws(() => F.encodeFrame(0x10000, 1), RangeError);
});

test('FrameReader enforces seq rules and terminates on garbage', () => {
  const r = new F.FrameReader();
  assert.equal(r.feed(F.encodeFrame(F.TYPES.PING, 1)).length, 1);
  assert.equal(r.feed(F.encodeFrame(F.TYPES.PING, 5)).length, 1); // jump ok
  assert.throws(() => r.feed(F.encodeFrame(F.TYPES.PING, 5)), F.FrameError);
  assert.ok(r.dead, 'reader must be dead after seq regression');
  const r2 = new F.FrameReader();
  assert.throws(() => r2.feed(Buffer.from('garbagegarbagegarbage')), F.FrameError);
  assert.ok(r2.dead);
});

test('TLV round-trip incl. experimental skip tag', () => {
  const fields = [
    [0x0001, Buffer.from([1, 2, 3])],
    [0x8000, Buffer.from([9])],
  ];
  const buf = F.encodeTLV(fields);
  const out = F.decodeTLV(buf);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].value, Buffer.from([1, 2, 3]));
  assert.equal(out[1].tag, 0x8000);
});

test('TLV writer refuses out-of-order and duplicates', () => {
  assert.throws(() => F.encodeTLV([[2, Buffer.from([1])], [1, Buffer.from([2])]]), RangeError);
  assert.throws(() => F.encodeTLV([[1, Buffer.from([1])], [1, Buffer.from([2])]]), RangeError);
});

test('TLV decoder rejects truncation and descending tags', () => {
  const buf = F.encodeTLV([[1, Buffer.from([1, 2, 3])]]);
  assert.throws(() => F.decodeTLV(buf.subarray(0, buf.length - 1)), F.TLVError);
  const descending = Buffer.alloc(8);
  descending.writeUInt16LE(5, 0); descending.writeUInt16LE(0, 2);
  descending.writeUInt16LE(4, 4); descending.writeUInt16LE(0, 6);
  assert.throws(() => F.decodeTLV(descending), F.TLVError);
});
