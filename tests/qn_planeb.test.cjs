'use strict';
// Plane B session tests (spec §3, §6): stage timers driven by a skewed fake
// clock, room bookkeeping, and the trust rules — all against the real
// session machinery over fake connections (no sockets, no DHT: those lanes
// live in e2e-room.cjs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const E = require('../src/peer/qn_envelope.cjs');
const F = require('../src/peer/qn_frame.cjs');
const R = require('../src/peer/qn_room.cjs');
const P = require('../src/peer/qn_planeb.cjs');

const sha = (s) => crypto.createHash('sha256').update(s).digest();

function fakeClock() {
  const state = { t: 1000, id: 1, tasks: new Map() };
  const step = (target) => {
    let next = null;
    for (const [h, x] of state.tasks)
      if (x.at <= target && (!next || x.at < next[1].at)) next = [h, x];
    if (!next) return false;
    state.tasks.delete(next[0]);
    state.t = Math.max(state.t, next[1].at);
    next[1].fn();
    return true;
  };
  return {
    now: () => state.t,
    setTimeout(fn, ms) { const h = state.id++; state.tasks.set(h, { at: state.t + ms, fn }); return h; },
    clearTimeout(h) { state.tasks.delete(h); },
    async advance(ms) {
      const target = state.t + ms;
      while (step(target)) await new Promise((r) => setImmediate(r));
      state.t = target;
      await new Promise((r) => setImmediate(r));
    },
  };
}

class FakeConn extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.destroyed = false;
    this.remotePublicKey = sha('fake-noise-remote');
  }
  write(b) { if (!this.destroyed) this.written.push(Buffer.from(b)); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
}

const KEYS = {
  host: (() => { const seed = sha('pb-host'); return { priv: E.privateKeyFromSeed(seed), pub: Buffer.from(E.publicRaw(E.publicKeyFromSeed(seed))) }; })(),
  peer: (() => { const seed = sha('pb-peer'); return { priv: E.privateKeyFromSeed(seed), pub: Buffer.from(E.publicRaw(E.publicKeyFromSeed(seed))) }; })(),
  evil: (() => { const seed = sha('pb-evil'); return { priv: E.privateKeyFromSeed(seed), pub: Buffer.from(E.publicRaw(E.publicKeyFromSeed(seed))) }; })(),
};
const CODE = sha('pb-code').subarray(0, 10);
const MATCH = R.matchIdOf(CODE);
const IDN = { manifest: sha('pb-manifest'), gamedir: Buffer.from('id1'),
  buildId: Buffer.from('deadbeef.p0123456789abcdef'),
  platform: Buffer.from('linux-x64'), binarySha: sha('pb-engine') };
const noiseKey = sha('pb-swarm-noise');

function hostRoom(overrides = {}) {
  const clock = fakeClock();
  const logs = [];
  const saved = [];
  const cbs = {
    onPeerUp() {}, onPeerDown() {}, onClData() {}, onChat() {}, onEmpty() {}, onFatal() {},
    ...(overrides.cbs || {}),
  };
  delete overrides.cbs;
  const room = new P.HostRoom({
    swarm: { keyPair: { publicKey: noiseKey } },
    matchId: MATCH, code: CODE, keys: KEYS.host, identity: IDN,
    map: 'e1m1', maxPeers: 8, minVersion: { major: E.MAJOR, minor: E.MINOR },
    clock, log: (s) => logs.push(s), cbs, epochSave: (v) => saved.push(v),
    ...overrides,
  });
  return { clock, logs, saved, room };
}

function clientRoom(opts = {}) {
  const clock = fakeClock();
  const logs = [];
  const events = [];
  const cbs = {
    onJoined: (x) => events.push(['joined', x]),
    onRefused: (c) => events.push(['refused', c]),
    onRoster: (m, e) => events.push(['roster', m, e]),
    onSvData: (o, b) => events.push(['svdata', o, b]),
    onChat: (o, t) => events.push(['chat', o, t]),
    onBye: () => events.push(['bye']),
    onHostLaneLost: () => events.push(['host-lost']),
    onReplay: () => events.push(['replay']),
    onRogueClosed: () => events.push(['rogue-closed']),
    onFatal: (c) => events.push(['fatal', c]),
  };
  const room = new P.ClientRoom({
    swarm: { keyPair: { publicKey: noiseKey } },
    matchId: MATCH, code: CODE, keys: KEYS.peer, identity: IDN,
    name: Buffer.from('tester'), pinned: opts.pinned ?? null,
    clock, log: (s) => logs.push(s), cbs, epochSave: () => {},
  });
  return { clock, logs, events, room };
}

// A spec-shaped inbound envelope as one stream buffer (u16 prefix included).
const envBytes = (type, seq, fields, priv) =>
  E.encodeEnvelope({ type, matchId: MATCH, seq, payload: F.encodeTLV(fields) }, priv);

const bindFrom = (keys) => envBytes(E.TYPES.KEY_BIND, 1,
  [[1, Buffer.from(keys.pub)],
   [2, Buffer.from(E.signWith(keys.priv,
     E.noiseBindingContext(noiseKey, sha('fake-noise-remote'))))]], keys.priv);

const joinBytes = (opts = {}) => {
  const k = opts.keys || KEYS.peer;
  return envBytes(E.TYPES.JOIN, 2,
  [[1, Buffer.from(k.pub)],
   [2, Buffer.from(opts.proof ?? R.proofOf(CODE, k.pub))],
   [3, Buffer.from(opts.name ?? 'bob')],
   [4, Buffer.from([opts.major ?? E.MAJOR])], [5, Buffer.from([opts.minor ?? E.MINOR])],
   [6, Buffer.from(opts.manifest ?? IDN.manifest)],
   [7, Buffer.from(IDN.gamedir)],
   [10, Buffer.from(opts.buildId ?? IDN.buildId)],
   [11, Buffer.from(opts.platform ?? IDN.platform)],
   [12, Buffer.from(opts.binarySha ?? IDN.binarySha)]], k.priv);
};

const hostDecodes = (conn) =>
  conn.written.map((raw) => E.decodeEnvelope(raw, KEYS.host.pub, { expectedMatchId: MATCH }));

test('info-only identity fields: divergent binary_sha/platform still join (§3.4a)', async () => {
  const { clock, room } = hostRoom();
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  const otherSha = Buffer.from(IDN.binarySha); otherSha[31] ^= 0xff;
  conn.emit('data', joinBytes({ binarySha: otherSha, platform: Buffer.from('win32-x64') }));
  await clock.advance(60);
  const outs = hostDecodes(conn);
  assert.ok(outs.some((o) => o.type === E.TYPES.JOIN_OK), 'info-only fields never refuse');
  assert.ok(!outs.some((o) => o.type === E.TYPES.JOIN_NO));
  assert.equal(conn.destroyed, false);
});

test('build_id mismatch: refused with cause 7', async () => {
  const { clock, room } = hostRoom();
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  conn.emit('data', joinBytes({ buildId: Buffer.from('deadbee0.p0123456789abcdef') }));
  await clock.advance(60);
  const no = hostDecodes(conn).find((o) => o.type === E.TYPES.JOIN_NO);
  assert.equal(new Map(F.decodeTLV(no.payload).map((x) => [x.tag, x.value])).get(1)[0],
    E.CAUSES.ASSET_MISMATCH);
});

test('key-bind timeout: a silent transport connection dies at the stage timer', async () => {
  const { clock, room, logs } = hostRoom();
  const conn = new FakeConn();
  room.accept(conn);
  await clock.advance(4900);
  assert.equal(conn.destroyed, false, 'must survive before the 5 s mark');
  await clock.advance(200);
  assert.equal(conn.destroyed, true);
  assert.match(logs.join('\n'), /key-bind timeout/);
});

test('bind then JOIN at the host: slot, JOIN_OK identity fields, roster broadcast', async () => {
  const { clock, room, saved } = hostRoom();
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  conn.emit('data', joinBytes());
  await clock.advance(10);
  const outs = hostDecodes(conn);
  const joinOk = outs.find((o) => o.type === E.TYPES.JOIN_OK);
  const roster = outs.find((o) => o.type === E.TYPES.ROSTER);
  assert.ok(joinOk && roster, 'JOIN_OK and ROSTER delivered');
  const t = new Map(F.decodeTLV(joinOk.payload).map((x) => [x.tag, x.value]));
  assert.equal(t.get(3)[0], 0); // first free slot
  assert.ok(t.get(9).equals(KEYS.host.pub)); // host key claim
  assert.ok(t.get(6).equals(IDN.manifest) && t.get(10).equals(IDN.buildId));
  const rt = new Map(F.decodeTLV(roster.payload).map((x) => [x.tag, x.value]));
  assert.equal(rt.get(1)[0], 1); // one member
  assert.equal(rt.get(4).readBigUInt64LE(0), 1n); // persisted store saw the advance
  assert.deepEqual(saved, [1n]);
});

test('bad proof: refused with cause 2 and the noise key is firewalled after', async () => {
  const { clock, room } = hostRoom();
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  conn.emit('data', joinBytes({ proof: Buffer.alloc(16, 9) }));
  await clock.advance(60);
  const no = hostDecodes(conn).find((o) => o.type === E.TYPES.JOIN_NO);
  assert.ok(no);
  assert.equal(new Map(F.decodeTLV(no.payload).map((x) => [x.tag, x.value])).get(1)[0],
    E.CAUSES.BAD_PROOF);
  assert.equal(conn.destroyed, true);
  assert.equal(room.firewall(conn.remotePublicKey), true);
  assert.equal(room.firewall(sha('innocent')), false);
});

test('tampered asset identity: refused with cause 7', async () => {
  const { clock, room } = hostRoom();
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  const bad = Buffer.from(IDN.manifest); bad[0] ^= 0xff;
  conn.emit('data', joinBytes({ manifest: bad }));
  await clock.advance(60);
  const no = hostDecodes(conn).find((o) => o.type === E.TYPES.JOIN_NO);
  assert.equal(new Map(F.decodeTLV(no.payload).map((x) => [x.tag, x.value])).get(1)[0],
    E.CAUSES.ASSET_MISMATCH);
});

test('below-minimum version: refused with cause 1', async () => {
  const { clock, room } = hostRoom({ minVersion: { major: E.MAJOR, minor: E.MINOR } });
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  conn.emit('data', joinBytes({ minor: 0 }));
  await clock.advance(60);
  const no = hostDecodes(conn).find((o) => o.type === E.TYPES.JOIN_NO);
  assert.equal(new Map(F.decodeTLV(no.payload).map((x) => [x.tag, x.value])).get(1)[0],
    E.CAUSES.VERSION_TOO_OLD);
});

test('join timeout: bound but never joining is dropped at the 10 s mark (kept alive otherwise)', async () => {
  const { clock, room, logs } = hostRoom();
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  for (let s = 2; s <= 7; s++) {
    await clock.advance(1500); // regular traffic: the 6 s silence rule must not fire
    conn.emit('data', envBytes(E.TYPES.PING, s, [[1, Buffer.alloc(4, s)]], KEYS.peer.priv));
  }
  assert.equal(conn.destroyed, false);
  await clock.advance(1500); // crosses the 10 s join stage timer armed at bind
  assert.equal(conn.destroyed, true);
  assert.match(logs.join('\n'), /join timeout/);
});

test('a non-bind first envelope on an unbound connection is terminal', async () => {
  const { clock, room, logs } = hostRoom();
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', envBytes(E.TYPES.CHAT, 1, [[1, Buffer.from('gg')]], KEYS.peer.priv));
  await clock.advance(10);
  assert.equal(conn.destroyed, true);
  // pre-bind decode reads the claimed key slot first: a CHAT body is not a
  // 32-byte pubkey, and that is the guard that fires (§3.4: KEY_BIND first).
  assert.match(logs.join('\n'), /bind pubkey/);
});

test('unbound per-connection bucket: 10/s burst 5 exactly per the limits table', () => {
  const b = new E.RateBucket({ rate: 10, burst: 5, now: () => 0 });
  for (let i = 0; i < 5; i++) assert.equal(b.consume(), true);
  assert.equal(b.consume(), false);
});

test('§6.1 three-tier: honest RELAY game-data rates survive control and game budgets', async () => {
  const seen = [];
  const { clock, room } = hostRoom({ cbs: { onClData: (from, body) => seen.push(body) } });
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  conn.emit('data', joinBytes());
  await clock.advance(10);
  // 300 RELAY frames at one frozen instant: past the 200/s control burst,
  // within the game bucket (burst 300) and the outer decode bound (400).
  for (let s = 3; s < 303; s++)
    conn.emit('data', envBytes(E.TYPES.RELAY, s,
      [[1, Buffer.from(KEYS.peer.pub)], [2, Buffer.from('f' + s)]], KEYS.peer.priv));
  await clock.advance(10);
  assert.equal(conn.destroyed, false);
  assert.equal(seen.length, 300);
});

test('§6.1 three-tier: a control-plane flood dies on the control bucket, before dispatch', async () => {
  const chats = [];
  const { clock, room, logs } = hostRoom({ cbs: { onChat: (from, text) => chats.push(text) } });
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  conn.emit('data', joinBytes());
  await clock.advance(10);
  for (let s = 3; s < 63; s++) {
    if (conn.destroyed) break;
    conn.emit('data', envBytes(E.TYPES.CHAT, s,
      [[1, Buffer.from('x')]], KEYS.peer.priv));
  }
  await clock.advance(10);
  assert.equal(conn.destroyed, true);
  assert.match(logs.join('\n'), /connection closed \(control rate limit exceeded\)/);
  // Budget: JOIN took 1 of burst 50, the 10 ms advance refilled 200/s*0.01s
  // = 2 (capped at burst), so exactly 50 dispatches before the wall.
  assert.equal(chats.length, 50);
});

test('§6.1 three-tier: a RELAY flood past the game bucket dies on dispatch work', async () => {
  const seen = [];
  const { clock, room, logs } = hostRoom({ cbs: { onClData: (from, body) => seen.push(body) } });
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  conn.emit('data', joinBytes());
  await clock.advance(10);
  for (let s = 3; s < 353; s++) {
    if (conn.destroyed) break;
    conn.emit('data', envBytes(E.TYPES.RELAY, s,
      [[1, Buffer.from(KEYS.peer.pub)], [2, Buffer.from('f')]], KEYS.peer.priv));
  }
  await clock.advance(10);
  assert.equal(conn.destroyed, true); // game burst 300 < outer burst 400: tier attribution
  assert.match(logs.join('\n'), /connection closed \(game rate limit exceeded\)/);
  assert.equal(seen.length, 300); // the flood stopped at the wall, none dispatched after
});

test('§6.1 three-tier: replayed envelopes count against the outer bucket only', async () => {
  const seen = [];
  const { clock, room, logs } = hostRoom({ cbs: { onClData: (from, body) => seen.push(body) } });
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  conn.emit('data', joinBytes());
  await clock.advance(10);
  const one = envBytes(E.TYPES.RELAY, 3,
    [[1, Buffer.from(KEYS.peer.pub)], [2, Buffer.from('f')]], KEYS.peer.priv);
  conn.emit('data', one);
  for (let i = 0; i < 450; i++) {
    if (conn.destroyed) break;
    conn.emit('data', one); // every replay: outer token, no game/control token
  }
  await clock.advance(10);
  assert.equal(conn.destroyed, true);
  // Replay skips the game/control buckets -- had it fed either, the close
  // reason would read 'game/control rate limit exceeded' (bursts 300/50);
  // the seq-window lifetime cap (100 drops) is what stops this flood.
  assert.match(logs.join('\n'), /connection closed \(window close-drops\)/);
  assert.equal(seen.length, 1); // replays never dispatch
});

test('§6.1 three-tier: a mixed burst that trips no tier still dies on the outer bound', async () => {
  const seen = [];
  const chats = [];
  const { clock, room, logs } = hostRoom({
    cbs: { onClData: (from, body) => seen.push(body), onChat: (from, t) => chats.push(t) },
  });
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  conn.emit('data', joinBytes());
  await clock.advance(10);
  // Exactly fill the game burst (300 RELAY) and the control budget (50 CHAT
  // after JOIN's refill-capped token loss); then replays: they skip both
  // tiers, so only the all-envelope decode bound (burst 400) can stop it.
  const relays = [];
  for (let s = 3; s < 303; s++) {
    const e = envBytes(E.TYPES.RELAY, s,
      [[1, Buffer.from(KEYS.peer.pub)], [2, Buffer.from('f' + s)]], KEYS.peer.priv);
    relays.push(e);
    conn.emit('data', e);
  }
  for (let s = 303; s < 353; s++)
    conn.emit('data', envBytes(E.TYPES.CHAT, s, [[1, Buffer.from('x')]], KEYS.peer.priv));
  for (let i = 0; i < 200 && !conn.destroyed; i++) conn.emit('data', relays[i]);
  await clock.advance(10);
  assert.equal(conn.destroyed, true);
  assert.match(logs.join('\n'), /connection closed \(envelope rate limit exceeded\)/);
  assert.equal(seen.length, 300);
  assert.equal(chats.length, 50);
});

test('host delivers verified RELAY bodies with the bound-key origin; a forged origin closes', async () => {
  const seen = [];
  const { clock, room, logs } = hostRoom({ cbs: { onClData: (from, body) => seen.push([from, body]) } });
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  conn.emit('data', joinBytes());
  await clock.advance(10);
  conn.emit('data', envBytes(E.TYPES.RELAY, 3,
    [[1, Buffer.from(KEYS.peer.pub)], [2, Buffer.from('usercmd')]], KEYS.peer.priv));
  await clock.advance(10);
  assert.equal(seen.length, 1);
  assert.ok(seen[0][0].equals(KEYS.peer.pub));
  assert.equal(seen[0][1].toString(), 'usercmd');
  const forged = envBytes(E.TYPES.RELAY, 4,
    [[1, Buffer.from(KEYS.evil.pub)], [2, Buffer.from('x')]], KEYS.peer.priv);
  conn.emit('data', forged);
  await clock.advance(10);
  assert.equal(conn.destroyed, true); // §3.4a: origin must equal the bound key
  assert.match(logs.join('\n'), /relay origin != bound key/);
  assert.equal(seen.length, 1);
});

test('roster slot frees on connection close and is reused by the next join', async () => {
  const { clock, room } = hostRoom();
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  conn.emit('data', joinBytes());
  await clock.advance(10);
  assert.equal(room.roster.length, 1);
  conn.destroy();
  await clock.advance(10);
  assert.equal(room.roster.length, 0);
  const conn2 = new FakeConn();
  room.accept(conn2);
  conn2.emit('data', bindFrom(KEYS.peer));
  conn2.emit('data', joinBytes());
  await clock.advance(10);
  const ok = hostDecodes(conn2).find((o) => o.type === E.TYPES.JOIN_OK);
  assert.equal(new Map(F.decodeTLV(ok.payload).map((x) => [x.tag, x.value])).get(3)[0], 0);
  assert.equal(room.firewall(conn2.remotePublicKey), false); // plain close is not an offence
});

test('client: host binary_sha/platform divergence never ends the join (§3.4a)', async () => {
  const { clock, room, events } = clientRoom({ pinned: Buffer.from(KEYS.host.pub) });
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.host));
  await clock.advance(10);
  const otherSha = Buffer.from(IDN.binarySha); otherSha[0] ^= 0xff;
  conn.emit('data', envBytes(E.TYPES.JOIN_OK, 2,
    [[1, sha('roster')], [2, Buffer.from('e1m1')], [3, Buffer.from([0])],
     [6, Buffer.from(IDN.manifest)], [7, Buffer.from(IDN.gamedir)],
     [9, Buffer.from(KEYS.host.pub)], [10, Buffer.from(IDN.buildId)],
     [11, Buffer.from('plan9-x64')], [12, Buffer.from(otherSha)]], KEYS.host.priv));
  await clock.advance(10);
  assert.ok(events.some((e) => e[0] === 'joined'));
  assert.equal(conn.destroyed, false);
});

test('client: host build_id mismatch closes (§3.4a)', async () => {
  const { clock, room, events } = clientRoom({ pinned: Buffer.from(KEYS.host.pub) });
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.host));
  await clock.advance(10);
  conn.emit('data', envBytes(E.TYPES.JOIN_OK, 2,
    [[1, sha('roster')], [2, Buffer.from('e1m1')], [3, Buffer.from([0])],
     [6, Buffer.from(IDN.manifest)], [7, Buffer.from(IDN.gamedir)],
     [9, Buffer.from(KEYS.host.pub)], [10, Buffer.from('deadbee0.p0123456789abcdef')],
     [11, Buffer.from('linux-x64')], [12, Buffer.from(IDN.binarySha)]], KEYS.host.priv));
  await clock.advance(10);
  assert.equal(conn.destroyed, true);
  assert.ok(!events.some((e) => e[0] === 'joined'));
});

test('client lane: host-signed message from a non-pinned peer closes it and no proof ever leaves', async () => {
  const { clock, room, events } = clientRoom({ pinned: Buffer.from(KEYS.host.pub) });
  const connEvil = new FakeConn();
  room.accept(connEvil);
  connEvil.emit('data', bindFrom(KEYS.evil));
  connEvil.emit('data', envBytes(E.TYPES.JOIN_OK, 2,
    [[1, sha('x')], [2, Buffer.from('e1m1')], [3, Buffer.from([0])],
     [6, Buffer.from(IDN.manifest)], [7, Buffer.from(IDN.gamedir)],
     [9, Buffer.from(KEYS.evil.pub)], [10, Buffer.from(IDN.buildId)],
     [11, Buffer.from(IDN.platform)], [12, Buffer.from(IDN.binarySha)]], KEYS.evil.priv));
  await clock.advance(10);
  assert.equal(connEvil.destroyed, true);
  assert.ok(events.some((e) => e[0] === 'rogue-closed'));
  const outs = connEvil.written.map((raw) =>
    E.decodeEnvelope(raw, KEYS.peer.pub, { expectedMatchId: MATCH }));
  assert.deepEqual(outs.map((o) => o.type), [E.TYPES.KEY_BIND]);
});

test('client lane: roster epoch regression closes; advance delivers members', async () => {
  const { clock, room, events } = clientRoom({ pinned: Buffer.from(KEYS.host.pub) });
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.host));
  await clock.advance(10);
  const roster = (seq, epoch) => envBytes(E.TYPES.ROSTER, seq,
    [[1, Buffer.concat([Buffer.from([1]), KEYS.peer.pub])],
     [2, Buffer.from([E.MAJOR])], [3, Buffer.from([E.MINOR])],
     [4, (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(epoch)); return b; })()],
     [5, Buffer.from(KEYS.host.pub)]], KEYS.host.priv);
  conn.emit('data', roster(2, 1)); // our own bind took seq 1 from this key
  await clock.advance(5);
  assert.ok(events.some((e) => e[0] === 'roster'));
  conn.emit('data', roster(3, 1)); // same epoch, fresh seq: regression, not replay
  await clock.advance(5);
  assert.equal(conn.destroyed, true);
});

test('client lane: byte-identical duplicate envelope is counted, never executed', async () => {
  const { clock, room, events } = clientRoom({ pinned: Buffer.from(KEYS.host.pub) });
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.host));
  await clock.advance(10);
  const relay = envBytes(E.TYPES.RELAY, 2,
    [[1, Buffer.from(KEYS.host.pub)], [2, Buffer.from('frame')]], KEYS.host.priv);
  conn.emit('data', relay);
  conn.emit('data', Buffer.from(relay));
  await clock.advance(5);
  assert.equal(events.filter((e) => e[0] === 'svdata').length, 1);
  assert.equal(events.filter((e) => e[0] === 'replay').length, 1);
});

test('client lane: join refused surfaces the cause and closes', async () => {
  const { clock, room, events } = clientRoom({ pinned: Buffer.from(KEYS.host.pub) });
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.host));
  await clock.advance(10);
  conn.emit('data', envBytes(E.TYPES.JOIN_NO, 2,
    [[1, Buffer.from([E.CAUSES.MATCH_FULL])]], KEYS.host.priv));
  await clock.advance(10);
  assert.ok(events.some((e) => e[0] === 'refused' && e[1] === E.CAUSES.MATCH_FULL));
  assert.equal(conn.destroyed, true);
});

test('host relays engine output to joined members only, origin = host key', async () => {
  const { clock, room } = hostRoom();
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  conn.emit('data', joinBytes());
  await clock.advance(10);
  conn.written.length = 0;
  room.relayToClients(Buffer.from('servmsg'), Buffer.from(KEYS.peer.pub));
  // Targeted fan-out: a stranger's target or none at all delivers nothing
  // (the datagram layer ACKs any DATA, so misdelivery poisons windows).
  room.relayToClients(Buffer.from('noTarget'), Buffer.from(KEYS.host.pub));
  room.relayToClients(Buffer.from('untargeted'));
  const outs = hostDecodes(conn).filter((o) => o.type === E.TYPES.RELAY);
  assert.equal(outs.length, 1);
  const t = new Map(F.decodeTLV(outs[0].payload).map((x) => [x.tag, x.value]));
  assert.ok(t.get(1).equals(KEYS.host.pub));
  assert.equal(t.get(2).toString(), 'servmsg');
});

test('host unbound cap: exactly four silent admissions, the fifth is closed', async () => {
  const { clock, room } = hostRoom();
  const conns = [];
  for (let i = 0; i < 5; i++) { const c = new FakeConn(); conns.push(c); room.accept(c); }
  await clock.advance(10);
  assert.equal(conns.slice(0, 4).every((c) => !c.destroyed), true, '§6.1 allows four');
  assert.equal(conns[4].destroyed, true, 'the fifth excess is closed at accept');
});

test('tags below the experimental range are counted, never silently accepted (§2.4)', async () => {
  const chats = [];
  const { clock, room } = hostRoom({ cbs: { onChat: (from, text) => chats.push(text) } });
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  conn.emit('data', joinBytes());
  await clock.advance(10);
  const bad = (s) => envBytes(E.TYPES.CHAT, s,
    [[1, Buffer.from('hi')], [2, Buffer.from('junk')]], KEYS.peer.priv);
  const good = (s) => envBytes(E.TYPES.CHAT, s, [[1, Buffer.from('hi')]], KEYS.peer.priv);
  conn.emit('data', bad(3)); conn.emit('data', bad(4)); conn.emit('data', good(5));
  await clock.advance(10);
  assert.equal(conn.destroyed, false, 'a clean envelope resets the count');
  assert.equal(chats.length, 1, 'junk-tagged envelopes are dropped, not executed');
  for (let s = 6; s <= 16; s++) conn.emit('data', bad(s)); // 11 in a row
  await clock.advance(10);
  assert.equal(conn.destroyed, true, 'the run closes at the §3.4b bound');
});

test('experimental-range tags keep riding along uncounted (§3.5b)', async () => {
  const chats = [];
  const { clock, room } = hostRoom({ cbs: { onChat: (from, text) => chats.push(text) } });
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  conn.emit('data', joinBytes());
  await clock.advance(10);
  for (let s = 3; s <= 15; s++) {
    conn.emit('data', envBytes(E.TYPES.CHAT, s,
      [[1, Buffer.from('hi')], [0x8123, Buffer.from([s & 0xff])]], KEYS.peer.priv));
  }
  await clock.advance(10);
  assert.equal(conn.destroyed, false, '≥0x8000 is the skip range, not the counting range');
  assert.equal(chats.length, 13);
});

test('client side is capped: the twelfth admission lives, the thirteenth is closed', async () => {
  const { clock, room } = clientRoom({ pinned: Buffer.from(KEYS.host.pub) });
  const conns = [];
  for (let i = 0; i < 13; i++) { const c = new FakeConn(); conns.push(c); room.accept(c); }
  await clock.advance(10);
  assert.equal(conns.slice(0, 12).every((c) => !c.destroyed), true);
  assert.equal(conns[12].destroyed, true);
});

test('a kept-alive non-lane peer is retired at the idle bound, not left forever', async () => {
  const evilSeed = sha('pb-idle-evil');
  const evil = { priv: E.privateKeyFromSeed(evilSeed),
    pub: Buffer.from(E.publicRaw(E.publicKeyFromSeed(evilSeed))) };
  const { clock, room, logs } = clientRoom({ pinned: Buffer.from(KEYS.host.pub) });
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(evil)); // bound, not pinned host: idle lane
  for (let s = 2; s <= 10; s++) { // answered pings defeat the silence rule only
    await clock.advance(1500);
    conn.emit('data', envBytes(E.TYPES.PING, s, [[1, Buffer.alloc(4, s)]], evil.priv));
  }
  assert.equal(conn.destroyed, false); // ~13.5 s: still within the idle bound
  await clock.advance(2000);
  assert.equal(conn.destroyed, true);
  assert.match(logs.join('\n'), /non-lane idle/);
});

test('a host silent past the roster-refresh bound is a dead host (§6.5)', async () => {
  const { clock, room, events } = clientRoom({ pinned: Buffer.from(KEYS.host.pub) });
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.host));
  await clock.advance(10);
  conn.emit('data', envBytes(E.TYPES.JOIN_OK, 2,
    [[1, sha('roster')], [2, Buffer.from('e1m1')], [3, Buffer.from([0])],
     [6, Buffer.from(IDN.manifest)], [7, Buffer.from(IDN.gamedir)],
     [9, Buffer.from(KEYS.host.pub)], [10, Buffer.from(IDN.buildId)],
     [11, Buffer.from(IDN.platform)], [12, Buffer.from(IDN.binarySha)]], KEYS.host.priv));
  await clock.advance(10);
  assert.ok(events.some((e) => e[0] === 'joined'));
  for (let s = 3; s <= 26; s++) { // traffic flows ~37.5 s, but no ROSTER ever arrives
    await clock.advance(1500);
    conn.emit('data', envBytes(E.TYPES.PING, s, [[1, Buffer.alloc(4, s)]], KEYS.host.priv));
  }
  assert.ok(events.some((e) => e[0] === 'fatal' && e[1] === 4),
    'stale roster must surface as transport-down, the same death a silent host gets');
});

test('the host refreshes rosters under the client staleness bound (§6.5 pair)', async () => {
  const { clock, room, saved } = hostRoom();
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  conn.emit('data', joinBytes());
  for (let s = 3; s <= 20; s++) { // the member answers the clock onward to ~31 s
    await clock.advance(1500);
    conn.emit('data', envBytes(E.TYPES.PING, s, [[1, Buffer.alloc(4, s)]], KEYS.peer.priv));
  }
  assert.equal(conn.destroyed, false);
  assert.equal(saved.length >= 2, true, 'a second broadcast went out unprompted');
  assert.equal(saved[1], saved[0] + 1n, 'the refresh advances the epoch, never repeats it');
});

/* ---- mode player ceilings ---- */

test('roomSeats maps HOST_UP max players to remote seats', () => {
  assert.equal(P.roomSeats(8), 7);
  assert.equal(P.roomSeats(16), 15);
  assert.equal(P.roomSeats(4), 3);
  assert.equal(P.roomSeats(1), 0);
  assert.equal(P.roomSeats(0), 0);
  assert.equal(P.roomSeats(255), 15);
});

test('full room: the seat past the cap is refused with cause 3', async () => {
  const { clock, room } = hostRoom({ maxPeers: 3 });
  const mk = (n) => {
    const seed = sha('pb-full-' + n);
    return { priv: E.privateKeyFromSeed(seed),
      pub: Buffer.from(E.publicRaw(E.publicKeyFromSeed(seed))) };
  };
  for (let i = 0; i < 3; i++) {
    const c = new FakeConn();
    room.accept(c);
    const k = mk(i);
    c.emit('data', bindFrom(k));
    c.emit('data', joinBytes({ keys: k }));
  }
  await clock.advance(10);
  const full = new FakeConn();
  room.accept(full);
  const k4 = mk(99);
  full.emit('data', bindFrom(k4));
  full.emit('data', joinBytes({ keys: k4 }));
  await clock.advance(10);
  const no = hostDecodes(full).find((o) => o.type === E.TYPES.JOIN_NO);
  assert.ok(no, 'fourth joiner receives JOIN_NO');
  assert.equal(new Map(F.decodeTLV(no.payload).map((x) => [x.tag, x.value])).get(1)[0],
    E.CAUSES.MATCH_FULL);
});

test('roster encoder pin: 16 members fit the envelope and the size contract', async () => {
  const { clock, room } = hostRoom({ maxPeers: 16 });
  const conn = new FakeConn();
  room.accept(conn);
  conn.emit('data', bindFrom(KEYS.peer));
  conn.emit('data', joinBytes());
  await clock.advance(10);
  for (let i = 1; i < 16; i++) room.allocSlot(sha('pb-mem-' + i));
  room.broadcastRoster();
  await clock.advance(1);
  const outs = hostDecodes(conn).filter((o) => o.type === E.TYPES.ROSTER);
  const last = outs[outs.length - 1];
  assert.ok(last, 'roster broadcast delivered');
  assert.ok(last.payload.length <= E.MAX_PAYLOAD,
    'roster payload ' + last.payload.length + ' B over ' + E.MAX_PAYLOAD);
  P.checkTagSizes(last);
  const t = new Map(F.decodeTLV(last.payload).map((x) => [x.tag, x.value]));
  assert.equal(t.get(1)[0], 16);
  assert.equal((t.get(1).length - 1) / 32, 16);
});
