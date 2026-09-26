'use strict';
// Signed public lobby advert, src/protocol/qn_protocol.md section 3.6.
// Pure codec: encode is host-daemon work, decodeAdvert is collecting-
// daemon work; the engine never verifies an advert. Crypto primitives are
// the envelope module's, so one key format serves every signed artifact.

const { createHash } = require('node:crypto');
const { encodeTLV, decodeTLV } = require('./qn_frame.cjs');
const { signWith, verifyWith } = require('./qn_envelope.cjs');

const ADVERT_MAGIC = 'QNLA';    // distinct domain: QNW0/QNWB sigs cannot replay here
const ADVERT_MAX = 1200;        // whole advert, spec 6.1
const ADVERT_TTL = 120;         // fixed by spec, seconds
const ADVERT_CAP = 64;          // collected adverts per viewer
const REANNOUNCE_MIN_MS = 1000; // host re-announce cadence cap

const TAGS = Object.freeze({
  MAP: 0x01, TITLE: 0x02, MAXP: 0x03, MODE: 0x04, CODE: 0x05,
  PUBKEY: 0x06, VER: 0x07, MINVER: 0x08, EPOCH: 0x09, TTL: 0x0a,
});

class LobbyError extends Error {}

const PRINTABLE = /^[\x20-\x7e]+$/;   // same shape as the daemon --name contract

function u8(v, name) {
  if (!Number.isInteger(v) || v < 0 || v > 255) throw new LobbyError(name + ' range');
  return Buffer.from([v]);
}

function verBuf(pair, name) {
  if (!Array.isArray(pair) || pair.length !== 2) throw new LobbyError(name + ' shape');
  for (const x of pair)
    if (!Number.isInteger(x) || x < 0 || x > 65535) throw new LobbyError(name + ' range');
  const b = Buffer.alloc(4);
  b.writeUInt16LE(pair[0], 0);
  b.writeUInt16LE(pair[1], 2);
  return b;
}

function readVer(v, name) {
  if (v.length !== 4) throw new LobbyError(name + ' length');
  return [v.readUInt16LE(0), v.readUInt16LE(2)];
}

function ttlBuf() {
  const t = Buffer.alloc(2);
  t.writeUInt16LE(ADVERT_TTL, 0);
  return t;
}

function sigDigest(canonical) {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(ADVERT_MAGIC, 'latin1'), canonical]))
    .digest();
}

function decodeAdvert(buf) {
  if (!Buffer.isBuffer(buf)) throw new LobbyError('advert: not a buffer');
  if (buf.length === 0 || buf.length > ADVERT_MAX) throw new LobbyError('advert: size');
  if (buf.length < 64) throw new LobbyError('advert: no signature');
  const canonical = buf.subarray(0, buf.length - 64);
  const sig = buf.subarray(buf.length - 64);
  let fields;
  try {
    fields = decodeTLV(canonical);
  } catch (e) {
    throw new LobbyError('advert tlv: ' + e.message);
  }
  const m = new Map();
  for (const f of fields) {
    if (m.has(f.tag)) throw new LobbyError('advert: duplicate tag');
    m.set(f.tag, f.value);                 // unknown tags skipped (spec 3.5b)
  }
  for (const want of Object.values(TAGS))
    if (!m.has(want)) throw new LobbyError('advert: missing tag 0x' + want.toString(16));

  const map = m.get(TAGS.MAP).toString('latin1');
  if (!map || map.length > 16 || !PRINTABLE.test(map)) throw new LobbyError('advert: map');
  const title = m.get(TAGS.TITLE).toString('latin1');
  if (!title || title.length > 20 || !PRINTABLE.test(title)) throw new LobbyError('advert: title');
  const maxp = m.get(TAGS.MAXP);
  if (maxp.length !== 1 || maxp[0] < 2 || maxp[0] > 8) throw new LobbyError('advert: maxp');
  const mode = m.get(TAGS.MODE);
  if (mode.length !== 1 || mode[0] > 1) throw new LobbyError('advert: mode');
  const code = m.get(TAGS.CODE);
  if (code.length !== 10) throw new LobbyError('advert: code');
  const pub = m.get(TAGS.PUBKEY);
  if (pub.length !== 32) throw new LobbyError('advert: pubkey');
  const version = readVer(m.get(TAGS.VER), 'advert: version');
  const minVersion = readVer(m.get(TAGS.MINVER), 'advert: minVersion');
  const eB = m.get(TAGS.EPOCH);
  if (eB.length !== 8) throw new LobbyError('advert: epoch length');
  const epoch = eB.readBigUInt64LE(0);
  if (epoch < 1n) throw new LobbyError('advert: epoch zero');
  const ttlB = m.get(TAGS.TTL);
  if (ttlB.length !== 2 || ttlB.readUInt16LE(0) !== ADVERT_TTL) throw new LobbyError('advert: ttl');

  let ok = false;
  try {
    ok = verifyWith(pub, sigDigest(canonical), sig);
  } catch (e) {
    throw new LobbyError('advert verify: ' + e.message);
  }
  if (!ok) throw new LobbyError('advert: signature');
  const codeC = Buffer.from(code);
  const pubC = Buffer.from(pub);
  if (codeC.freeze) codeC.freeze();
  if (pubC.freeze) pubC.freeze();
  return Object.freeze({
    map, title, maxPlayers: maxp[0], mode: mode[0],
    code: codeC, pubkey: pubC,
    version: Object.freeze(version), minVersion: Object.freeze(minVersion),
    epoch, ttl: ADVERT_TTL,
  });
}

function encodeAdvert(a, privKey) {
  if (typeof a.map !== 'string' || !PRINTABLE.test(a.map)) throw new LobbyError('map');
  if (typeof a.title !== 'string' || !PRINTABLE.test(a.title)) throw new LobbyError('title');
  const mapBuf = Buffer.from(a.map, 'latin1');
  const titleBuf = Buffer.from(a.title, 'latin1');
  if (!Buffer.isBuffer(a.pubkey)) throw new LobbyError('pubkey: not a buffer');
  const code = Buffer.isBuffer(a.code) ? Buffer.from(a.code) : Buffer.from(String(a.code), 'latin1');
  const pub = Buffer.from(a.pubkey);
  let epochB;
  try {
    epochB = Buffer.alloc(8);
    epochB.writeBigUInt64LE(BigInt(a.epoch), 0);
  } catch (e) {
    throw new LobbyError('epoch: ' + e.message);
  }
  const canonical = encodeTLV([
    [TAGS.MAP, mapBuf],
    [TAGS.TITLE, titleBuf],
    [TAGS.MAXP, u8(a.maxPlayers, 'maxPlayers')],
    [TAGS.MODE, u8(a.mode, 'mode')],
    [TAGS.CODE, code],
    [TAGS.PUBKEY, pub],
    [TAGS.VER, verBuf(a.version, 'version')],
    [TAGS.MINVER, verBuf(a.minVersion, 'minVersion')],
    [TAGS.EPOCH, epochB],
    [TAGS.TTL, ttlBuf()],
  ]);
  const sig = signWith(privKey, sigDigest(canonical));
  const advert = Buffer.concat([canonical, sig]);
  decodeAdvert(advert);   // self-check: never emit a frame our own verifier refuses
  return advert;
}

// Per-host-key (epoch, advert) store with replay refusal and expiry.
// A floor map remembers the highest accepted epoch per host beyond entry
// expiry/eviction, so a captured advert replayed after the store forgot
// it cannot resurrect as a ghost lobby with a fresh ttl budget.
class AdvertStore {
  constructor() {
    this.byHost = new Map();
    this.floor = new Map();     // host key hex -> highest epoch ever accepted
    this.floorCap = 1024;       // FIFO; hostile distinct-key churn stays bounded
  }

  apply(advert, buf, now) {
    if (typeof advert.epoch !== 'bigint' || !Buffer.isBuffer(advert.pubkey))
      throw new LobbyError('apply: unverified advert object');
    const key = advert.pubkey.toString('hex');
    const fl = this.floor.get(key);
    if (fl !== undefined && advert.epoch <= fl) return 'stale';   // tie, regression, or post-forget replay
    const copy = Buffer.from(buf);
    if (copy.freeze) copy.freeze();
    this.byHost.set(key, Object.freeze({
      advert, buf: copy, epoch: advert.epoch, firstSeen: now,
    }));
    this.floor.set(key, advert.epoch);
    if (this.floor.size > this.floorCap)
      this.floor.delete(this.floor.keys().next().value);
    if (this.byHost.size > ADVERT_CAP) {                    // evict lowest epoch
      let low = null;
      for (const [k, v] of this.byHost)
        if (low === null || v.epoch < low.epoch) low = k;
      this.byHost.delete(low);
    }
    return 'stored';
  }

  live(now) {
    const out = [];
    for (const [k, v] of this.byHost) {
      if (now - v.firstSeen > v.advert.ttl * 1000) this.byHost.delete(k);
      else out.push(v);
    }
    out.sort((a, b) => (a.epoch === b.epoch ? 0 : a.epoch > b.epoch ? -1 : 1));
    return out;
  }

  get size() { return this.byHost.size; }
}

module.exports = {
  ADVERT_MAGIC, ADVERT_MAX, ADVERT_TTL, ADVERT_CAP, REANNOUNCE_MIN_MS,
  TAGS, LobbyError, encodeAdvert, decodeAdvert, AdvertStore,
};
