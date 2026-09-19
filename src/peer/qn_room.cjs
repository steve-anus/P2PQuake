'use strict';
// Room derivation and join codes per src/protocol/qn_protocol.md §5.
// 10-byte CSPRNG code -> display (Crockford base32, 16 chars, 4-4-4-4),
// topic (DHT key), match_id, membership key + join proof.

const crypto = require('node:crypto');

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I L O U

function randomJoinCode() {
  return crypto.randomBytes(10);
}

// 10 bytes = 80 bits = exactly 16 base32 characters.
function codeFromBytes(bytes) {
  if (bytes.length !== 10) throw new RangeError('join code must be 10 bytes');
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  let out = '';
  for (let i = 0; i < 16; i++) {
    let v = 0;
    for (let j = 0; j < 5; j++) v = (v << 1) | bits[i * 5 + j];
    out += CROCKFORD[v];
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12)}`;
}

function bytesFromCode(code) {
  if (typeof code !== 'string' || !/^[0-9A-Za-z-]+$/.test(code))
    throw new RangeError('display code must be ASCII letters/digits/dashes');
  const s = code.toUpperCase().replace(/-/g, '');
  if (s.length !== 16) throw new RangeError('display code must be 16 chars');
  const bits = [];
  for (const ch of s) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) throw new RangeError('invalid character in code');
    for (let j = 4; j >= 0; j--) bits.push((v >> j) & 1); // base32 = 5 bits/char
  }
  const out = Buffer.alloc(10);
  for (let i = 0; i < 80; i++) out[i >> 3] |= bits[i] << (7 - (i & 7));
  return out;
}

const RAW_CODE_RULE = 'join code must be raw bytes; display strings go through bytesFromCode';
function topicOf(joinCode) {
  if (!Buffer.isBuffer(joinCode)) throw new TypeError(RAW_CODE_RULE);
  return crypto.createHash('sha256').update(joinCode).digest();
}

function matchIdOf(joinCode) {
  return topicOf(joinCode).subarray(0, 16);
}

function membershipKey(joinCode) {
  if (!Buffer.isBuffer(joinCode)) throw new TypeError(RAW_CODE_RULE);
  // hkdfSync(digest, ikm, salt, info, length) — returns ArrayBuffer
  return Buffer.from(
    crypto.hkdfSync('sha256', joinCode, Buffer.from('p2pquake-room'),
      Buffer.from('membership'), 32)
  );
}

// proof = first 16 bytes of HMAC-SHA256(membership_key, our longterm pubkey)
function proofOf(joinCode, ourPublicKeyRaw) {
  return crypto.createHmac('sha256', membershipKey(joinCode))
    .update(ourPublicKeyRaw).digest().subarray(0, 16);
}

function verifyProof(joinCode, ourPublicKeyRaw, proof) {
  const want = proofOf(joinCode, ourPublicKeyRaw);
  return proof.length === want.length && crypto.timingSafeEqual(want, proof);
}

module.exports = {
  CROCKFORD, randomJoinCode, codeFromBytes, bytesFromCode,
  topicOf, matchIdOf, membershipKey, proofOf, verifyProof,
};
