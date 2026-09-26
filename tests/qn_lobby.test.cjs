'use strict';
// Public lobby advert codec conformance (spec §3.6, §6.1). Pure
// parse/encode: hostile names, oversized fields, bad signatures,
// expired TTL, epoch regressions, truncation at every offset, and
// cross-domain signature refusal all live here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const L = require('../src/peer/qn_lobby.cjs');
const E = require('../src/peer/qn_envelope.cjs');
const F = require('../src/peer/qn_frame.cjs');

const kp = crypto.generateKeyPairSync('ed25519');
const kp2 = crypto.generateKeyPairSync('ed25519');
const pub = E.publicRaw(kp.publicKey);
const pub2 = E.publicRaw(kp2.publicKey);

function fieldsOf(o = {}) {
  const epoch = Buffer.alloc(8);
  epoch.writeBigUInt64LE(o.epoch ?? 1n, 0);
  const ttl = Buffer.alloc(2);
  ttl.writeUInt16LE(o.ttl ?? L.ADVERT_TTL, 0);
  const ver = (p) => { const b = Buffer.alloc(4); b.writeUInt16LE(p[0], 0); b.writeUInt16LE(p[1], 2); return b; };
  const out = [];
  const put = (tag, v) => { if (!o.drop?.includes(tag)) out.push([tag, v]); };
  put(0x01, Buffer.from(o.map ?? 'lqdm1', 'latin1'));
  put(0x02, Buffer.from(o.title ?? 'Lobby One', 'latin1'));
  put(0x03, o.maxp ?? Buffer.from([8]));
  put(0x04, o.mode ?? Buffer.from([1]));
  put(0x05, o.code ?? Buffer.alloc(10, 0x41));
  put(0x06, o.pubkey ?? pub);
  put(0x07, o.verRaw ?? ver(o.version ?? [1, 4]));
  put(0x08, o.minVerRaw ?? ver(o.minVersion ?? [1, 0]));
  put(0x09, o.epochRaw ?? epoch);
  put(0x0a, o.ttlRaw ?? ttl);
  put(0x0b, o.players ?? Buffer.from([3]));
  return out;
}

/* build a signed advert straight from field arrays (bypasses encode
 * validation on purpose, to aim the verifier at hostile bytes) */
function signed(f, key = kp.privateKey, magic = 'QNLA') {
  const canonical = Buffer.isBuffer(f) ? f : F.encodeTLV(f);
  const digest = crypto.createHash('sha256')
    .update(Buffer.concat([Buffer.from(magic, 'latin1'), canonical])).digest();
  return Buffer.concat([canonical, E.signWith(key, digest)]);
}

const good = signed(fieldsOf());

test('round trip: encode then decode returns every field', () => {
  const a = { map: 'lq_e1m1', title: 'Test Lobby', maxPlayers: 4, players: 3, mode: 0,
    code: Buffer.alloc(10, 0x33), pubkey: pub, version: [2, 7],
    minVersion: [1, 0], epoch: 42 };
  const buf = L.encodeAdvert(a, kp.privateKey);
  const out = L.decodeAdvert(buf);
  assert.equal(out.map, a.map);
  assert.equal(out.title, a.title);
  assert.equal(out.maxPlayers, a.maxPlayers);
  assert.equal(out.players, a.players);
  assert.equal(out.mode, a.mode);
  assert.deepEqual(out.code, a.code);
  assert.deepEqual(out.pubkey, a.pubkey);
  assert.deepEqual(out.version, a.version);
  assert.deepEqual(out.minVersion, a.minVersion);
  assert.equal(out.epoch, 42n);
  assert.equal(out.ttl, L.ADVERT_TTL);
  assert.ok(buf.length <= L.ADVERT_MAX);
});

test('truncation at every offset is refused (never accepted, never crashes)', () => {
  for (let i = 0; i < good.length; i++)
    assert.throws(() => L.decodeAdvert(good.subarray(0, i)), L.LobbyError, 'offset ' + i);
});

test('single-bit corruption is always refused', () => {
  for (let pos = 0; pos < good.length; pos++) {
    const b = Buffer.from(good);
    b[pos] ^= 0x01;
    assert.throws(() => L.decodeAdvert(b), L.LobbyError, 'flip at ' + pos);
  }
});

test('signature discipline: wrong key, wrong bytes, wrong domain all refuse', () => {
  assert.throws(() => L.decodeAdvert(signed(fieldsOf(), kp2.privateKey)), L.LobbyError);
  const b = Buffer.from(good);
  b[b.length - 1] ^= 0x80;
  assert.throws(() => L.decodeAdvert(b), L.LobbyError);              // sig tampered
  const b2 = Buffer.from(good);
  b2[5] ^= 0x01;                                                 // content byte, old sig
  assert.throws(() => L.decodeAdvert(b2), L.LobbyError);
  assert.throws(() => L.decodeAdvert(signed(fieldsOf(), kp.privateKey, 'QNW0')), L.LobbyError);
});

test('every required tag is required (drop each in turn)', () => {
  for (const tag of Object.values(L.TAGS))
    assert.throws(() => L.decodeAdvert(signed(fieldsOf({ drop: [tag] }))),
      L.LobbyError, 'dropped 0x' + tag.toString(16));
});

test('players field: width and over-max refused at decode and encode', () => {
  assert.throws(() => L.decodeAdvert(signed(fieldsOf({ players: Buffer.alloc(2) }))),
    /players width/);
  assert.throws(() => L.decodeAdvert(signed(fieldsOf({ maxp: Buffer.from([2]), players: Buffer.from([5]) }))),
    /players over max/);
  const baseOk = { map: 'm', title: 't', maxPlayers: 4, mode: 0,
    code: Buffer.alloc(10, 7), pubkey: pub, version: [1, 4], minVersion: [1, 0], epoch: 1 };
  assert.throws(() => L.encodeAdvert({ ...baseOk, players: 5 }, kp.privateKey), /over max/);
  assert.throws(() => L.encodeAdvert({ ...baseOk, players: 256 }, kp.privateKey), L.LobbyError);
  assert.throws(() => L.encodeAdvert({ ...baseOk }, kp.privateKey), L.LobbyError);       // missing field
});

test('unknown tags are skipped, same-major forward compat', () => {
  const f = fieldsOf().concat([[0x000c, Buffer.from('future')],
                               [0x8123, Buffer.from([1, 2, 3])]]);
  const out = L.decodeAdvert(signed(f));
  assert.equal(out.map, 'lqdm1');
  assert.equal(out.epoch, 1n);
});

test('hostile field values refuse', () => {
  const bad = [
    ['map empty', { map: '' }],
    ['map 17 chars', { map: 'a'.repeat(17) }],
    ['map newline', { map: 'lqdm1\n+map evil' }],
    ['map +cmd', { map: 'x\rmap lqdm1' }],
    ['map esc', { map: 'lqdm1\x1b' }],
    ['map high byte', { map: 'lqdm1\xff' }],
    ['title empty', { title: '' }],
    ['title 21 chars', { title: 't'.repeat(21) }],
    ['title control', { title: 'party\x00\x0a' }],
    ['maxp 0', { maxp: Buffer.from([0]) }],
    ['maxp 1', { maxp: Buffer.from([1]) }],
    ['maxp 9', { maxp: Buffer.from([9]) }],
    ['maxp two bytes', { maxp: Buffer.from([8, 0]) }, /advert: maxp$/],
    ['mode 2', { mode: Buffer.from([2]) }],
    ['mode empty', { mode: Buffer.alloc(0) }],
    ['code 9', { code: Buffer.alloc(9, 7) }],
    ['code 11', { code: Buffer.alloc(11, 7) }],
    ['pubkey 31', { pubkey: Buffer.alloc(31, 9) }],
    ['pubkey 33', { pubkey: Buffer.alloc(33, 9) }],
    ['epoch zero', { epoch: 0n }],
    ['ttl 121', { ttl: 121 }],
    ['ttl 0', { ttl: 0 }],
    ['ttl 1 byte', { ttlRaw: Buffer.from([120]) }, /advert: ttl$/],
    ['ttl 3 bytes', { ttlRaw: Buffer.alloc(3, 120) }, /advert: ttl$/],
    ['version 3 bytes', { verRaw: Buffer.alloc(3) }, /advert: version length$/],
    ['minVersion 5 bytes', { minVerRaw: Buffer.alloc(5) }, /advert: minVersion length$/],
    ['epoch 7 bytes', { epochRaw: Buffer.alloc(7, 1) }, /advert: epoch length$/],
    ['epoch 9 bytes', { epochRaw: Buffer.alloc(9, 1) }, /advert: epoch length$/],
  ];
  for (const [name, o, re] of bad)
    assert.throws(() => L.decodeAdvert(signed(fieldsOf(o))),
      (err) => err instanceof L.LobbyError && (!re || re.test(err.message)), name);
});

test('oversized advert refuses before any parse work', () => {
  const pad = fieldsOf().concat([[0x000c, Buffer.alloc(L.ADVERT_MAX, 0x41)]]);
  const big = F.encodeTLV(pad);
  assert.ok(big.length + 64 > L.ADVERT_MAX);
  assert.throws(() => L.decodeAdvert(Buffer.concat([big, Buffer.alloc(64)])),
    L.LobbyError);
  assert.throws(() => L.decodeAdvert(Buffer.alloc(0)), L.LobbyError);
  assert.throws(() => L.decodeAdvert('not a buffer'), L.LobbyError);
});

test('encode refuses hostile input instead of emitting it', () => {
  const base = { code: Buffer.alloc(10, 7), pubkey: pub, version: [1, 4],
    minVersion: [1, 0], epoch: 1, players: 3 };
  assert.throws(() => L.encodeAdvert({ ...base, map: 'a'.repeat(17), title: 't', maxPlayers: 8, mode: 0 }, kp.privateKey), L.LobbyError);
  assert.throws(() => L.encodeAdvert({ ...base, map: 'm', title: 't', maxPlayers: 1, mode: 0 }, kp.privateKey), L.LobbyError);
  assert.throws(() => L.encodeAdvert({ ...base, map: 'm', title: 't', maxPlayers: 8, mode: 2 }, kp.privateKey), L.LobbyError);
  assert.throws(() => L.encodeAdvert({ ...base, map: 'm', title: 't\nx', maxPlayers: 8, mode: 0 }, kp.privateKey), L.LobbyError);
  assert.throws(() => L.encodeAdvert({ ...base, map: 'm', title: 't', maxPlayers: 8, mode: 0, epoch: 0 }, kp.privateKey), L.LobbyError);
});

test('AdvertStore: epoch monotonicity, tie and regression refuse', () => {
  const st = new L.AdvertStore();
  const mk = (epoch) => {
    const buf = signed(fieldsOf({ epoch }));
    return [buf, L.decodeAdvert(buf)];
  };
  const [b1, a1] = mk(5n);
  assert.equal(st.apply(a1, b1, 0), 'stored');
  const [bSame, aSame] = mk(5n);
  assert.equal(st.apply(aSame, bSame, 1), 'stale');          // tie
  const [bLow, aLow] = mk(4n);
  assert.equal(st.apply(aLow, bLow, 2), 'stale');            // regression
  const [bUp, aUp] = mk(6n);
  assert.equal(st.apply(aUp, bUp, 3), 'stored');
  assert.equal(st.size, 1);
  assert.equal(st.live(3)[0].advert.epoch, 6n);
});

test('AdvertStore: ttl budget from first-seen drops expired adverts', () => {
  const st = new L.AdvertStore();
  const buf = signed(fieldsOf());
  st.apply(L.decodeAdvert(buf), buf, 1000);
  assert.equal(st.live(1000 + L.ADVERT_TTL * 1000).length, 1);   // boundary: alive
  assert.equal(st.live(1001 + L.ADVERT_TTL * 1000).length, 0);   // past budget
  assert.equal(st.size, 0);
});

test('AdvertStore: cap 64, overflow evicts the lowest epoch', () => {
  const st = new L.AdvertStore();
  for (let i = 1; i <= L.ADVERT_CAP + 1; i++) {
    const k = crypto.generateKeyPairSync('ed25519');
    const buf = signed(fieldsOf({ epoch: BigInt(i), pubkey: E.publicRaw(k.publicKey) }), k.privateKey);
    st.apply(L.decodeAdvert(buf), buf, 0);
  }
  assert.equal(st.size, L.ADVERT_CAP);
  assert.equal(st.live(0)[0].advert.epoch, BigInt(L.ADVERT_CAP + 1)); // newest first
  assert.equal(st.live(0).at(-1).advert.epoch, 2n);                   // epoch 1 evicted
});

test('frame registry exposes the lobby types within the free band', () => {
  assert.equal(F.TYPES.LOBBY_WATCH, 0x0070);
  assert.equal(F.TYPES.LOBBY_UNWATCH, 0x0071);
  assert.equal(F.TYPES.LOBBY_LIST, 0x0072);
  assert.equal(F.TYPES.LOBBY_ANNOUNCE, 0x0073);
  assert.equal(F.TYPES.LOBBY_WITHDRAW, 0x0074);
  const known = new Set(Object.values(F.TYPES));
  for (const t of known) assert.ok(t <= 0x00ff);
});

test('boundary buffers: 63/64/65-byte adverts all refuse', () => {
  assert.throws(() => L.decodeAdvert(Buffer.alloc(63)), L.LobbyError);
  assert.throws(() => L.decodeAdvert(Buffer.alloc(64)), L.LobbyError);
  assert.throws(() => L.decodeAdvert(Buffer.alloc(65)), L.LobbyError);
});

test('duplicate required tag in raw canonical bytes is refused', () => {
  const e = Buffer.alloc(8);
  e.writeBigUInt64LE(1n, 0);
  const dup = Buffer.concat([F.encodeTLV(fieldsOf()), F.encodeTLV([[0x09, e]])]);
  assert.throws(() => L.decodeAdvert(signed(dup)), L.LobbyError);
});

test('post-forget replay cannot resurrect an advert (replay floor)', () => {
  const st = new L.AdvertStore();
  const buf = signed(fieldsOf({ epoch: 7n }));
  const adv = L.decodeAdvert(buf);
  assert.equal(st.apply(adv, buf, 0), 'stored');
  st.live(121000);
  assert.equal(st.size, 0);
  assert.equal(st.apply(adv, buf, 999999), 'stale');
});

test('apply refuses hand-made objects that never passed the verifier', () => {
  const st = new L.AdvertStore();
  assert.throws(() => st.apply({ pubkey: pub, epoch: 5 }, Buffer.alloc(100), 0), L.LobbyError);
  assert.throws(() => st.apply({ pubkey: 'aa'.repeat(32), epoch: 5n }, Buffer.alloc(100), 0), L.LobbyError);
});

test('verified adverts and live entries are frozen against mutation', () => {
  const adv = L.decodeAdvert(good);
  assert.throws(() => { adv.title = 'HIJACKED'; }, TypeError);
  const st = new L.AdvertStore();
  st.apply(adv, good, 0);
  const e = st.live(0)[0];
  assert.throws(() => { e.firstSeen = 0; }, TypeError);
  assert.throws(() => { e.advert.map = 'evil'; }, TypeError);
});

test('encode refuses a non-buffer pubkey with LobbyError', () => {
  const base = { map: 'm', title: 't', maxPlayers: 8, mode: 0, players: 3,
    code: Buffer.alloc(10, 7), version: [1, 4], minVersion: [1, 0], epoch: 1 };
  assert.throws(() => L.encodeAdvert({ ...base, pubkey: pub.toString('hex') }, kp.privateKey), L.LobbyError);
  assert.throws(() => L.encodeAdvert({ ...base, pubkey: 5 }, kp.privateKey), L.LobbyError);
});

test('store hands out copies: post-verify byte mutation cannot reach the forward path', () => {
  const st = new L.AdvertStore();
  const buf = signed(fieldsOf());
  st.apply(L.decodeAdvert(buf), buf, 0);
  const e = st.live(0)[0];
  const b = e.buf;
  b[0] ^= 0xff;
  assert.notDeepEqual(e.buf, b);
  assert.deepEqual(e.buf, buf);
});

test('apply guards buf provenance: string arg and mismatched bytes refuse', () => {
  const st = new L.AdvertStore();
  const buf = signed(fieldsOf());
  const adv = L.decodeAdvert(buf);
  assert.throws(() => st.apply(adv, buf.toString('latin1'), 0), /bad buf/);
  assert.throws(() => st.apply(adv, Buffer.alloc(63), 0), /bad buf/);
  const other = signed(fieldsOf({ epoch: 9n, pubkey: pub2 }), kp2.privateKey);
  assert.throws(() => st.apply(adv, other, 0), /buf\/advert mismatch/);
});

test('floor keeps recency: an active host survives churn of dead keys', () => {
  const st = new L.AdvertStore();
  const vk = crypto.generateKeyPairSync('ed25519');
  const vpub = E.publicRaw(vk.publicKey);
  const mkVictim = (epoch) => signed(fieldsOf({ epoch, pubkey: vpub }), vk.privateKey);
  const churn = (n) => {
    for (let i = 0; i < n; i++) {
      const k = crypto.generateKeyPairSync('ed25519');
      const b = signed(fieldsOf({ epoch: 1n, pubkey: E.publicRaw(k.publicKey) }), k.privateKey);
      st.apply(L.decodeAdvert(b), b, i);
    }
  };
  const b7 = mkVictim(7n);
  st.apply(L.decodeAdvert(b7), b7, 0);
  churn(600);
  const b8 = mkVictim(8n);
  st.apply(L.decodeAdvert(b8), b8, 700);
  churn(600);
  assert.equal(st.apply(L.decodeAdvert(b8), b8, 99999), 'stale');
});

test('ordered-adjacent duplicate tag refuses (TLV duplicate arm)', () => {
  const tlv = (tag, val) => {
    const h = Buffer.alloc(4);
    h.writeUInt16LE(tag, 0);
    h.writeUInt16LE(val.length, 2);
    return Buffer.concat([h, val]);
  };
  const e1 = Buffer.alloc(8);
  e1.writeBigUInt64LE(1n, 0);
  const parts = fieldsOf().map(([tag, v]) => tlv(tag, v));
  parts.splice(9, 0, tlv(0x09, e1));
  assert.throws(() => L.decodeAdvert(signed(Buffer.concat(parts))), L.LobbyError);
});
