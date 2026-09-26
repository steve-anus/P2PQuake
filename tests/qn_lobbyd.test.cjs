'use strict';
// Public lobby daemon machinery (spec §3.6): host announcer cadence and
// epoch persistence, viewer fetch-verify-collect, snapshot framing,
// ingest metering, and every silent-drop path. DI fakes only; real DHT
// behavior is the loopback lane's job.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:stream');

const F = require('../src/peer/qn_frame.cjs');
const E = require('../src/peer/qn_envelope.cjs');
const L = require('../src/peer/qn_lobby.cjs');
const D = require('../src/peer/qn_lobbyd.cjs');
const Q = require('../src/peer/qn-peer.cjs');

function fakeClock() {
  const st = { t: 1000, id: 1, tasks: new Map() };
  return {
    now: () => st.t,
    setTimeout(fn, ms) { const h = st.id++; st.tasks.set(h, { at: st.t + ms, fn }); return h; },
    clearTimeout(h) { st.tasks.delete(h); },
    async advance(ms) {
      const target = st.t + ms;
      for (;;) {
        let next = null;
        for (const [h, x] of st.tasks)
          if (x.at <= target && (!next || x.at < next[1].at)) next = [h, x];
        if (!next) break;
        st.tasks.delete(next[0]);
        st.t = Math.max(st.t, next[1].at);
        next[1].fn();
        await new Promise((r) => setImmediate(r));
      }
      st.t = Math.max(st.t, target);
    },
  };
}

function mkKeys(seedByte) {
  const seed = Buffer.alloc(32, seedByte);
  return { priv: E.privateKeyFromSeed(seed), pub: Buffer.from(E.publicRaw(E.publicKeyFromSeed(seed))) };
}

function tlvPayload(fields) {
  return F.encodeTLV([
    [0x01, Buffer.from(fields.map, 'latin1')],
    [0x02, Buffer.from(fields.title, 'latin1')],
    [0x03, Buffer.from([fields.maxPlayers])],
    [0x04, Buffer.from([fields.mode])],
  ]);
}

const GOOD = { map: 'lqdm1', title: 'Test Lobby', maxPlayers: 8, mode: 1 };
const CODE10 = Buffer.alloc(10, 0x2b);

function mkHost(opts = {}) {
  const clock = opts.clock || fakeClock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qnlobbyd-'));
  const swarms = [];
  const logs = [];
  const h = D.makeHostLobby({
    keys: mkKeys(0x11),
    epochs: opts.epochs || Q.makeEpochStore(dir),
    clock,
    swarmFactory: () => { const s = new EventEmitter(); s.destroyed = false; s.destroy = () => { s.destroyed = true; }; swarms.push(s); return s; },
    version: [0, 2], minVersion: [0, 2],
    getCode: opts.getCode ?? (() => CODE10),
    log: (s) => logs.push(s),
  });
  return { h, clock, swarms, logs };
}

test('announceFields: accept and full rejection matrix', () => {
  assert.deepEqual(D.announceFields(tlvPayload(GOOD)), GOOD);
  const base = [[0x01, Buffer.from('lqdm1')], [0x02, Buffer.from('T')],
                [0x03, Buffer.from([4])], [0x04, Buffer.from([0])]];
  const strip = (i) => F.encodeTLV(base.filter((_, j) => j !== i));
  for (let i = 0; i < 4; i++)
    assert.throws(() => D.announceFields(strip(i)), L.LobbyError, 'drop ' + i);
  const rt = (tag, val) => { const h = Buffer.alloc(4); h.writeUInt16LE(tag, 0); h.writeUInt16LE(val.length, 2); return Buffer.concat([h, val]); };
  const dupRaw = Buffer.concat(base.map(([t, v]) => rt(t, v)).concat([rt(0x04, Buffer.from([0]))]));
  assert.throws(() => D.announceFields(dupRaw), L.LobbyError);                                  // dup tag
  const extraRaw = Buffer.concat(base.map(([t, v]) => rt(t, v)).concat([rt(0x05, Buffer.from('x'))]));
  assert.throws(() => D.announceFields(extraRaw), L.LobbyError);                               // extra tag
  assert.throws(() => D.announceFields(F.encodeTLV([base[0], base[1], [0x03, Buffer.alloc(0)], base[3]])), L.LobbyError);
  assert.throws(() => D.announceFields(F.encodeTLV([base[0], base[1], [0x03, Buffer.from([1])], base[3]])), L.LobbyError);   // maxp 1
  assert.throws(() => D.announceFields(F.encodeTLV([base[0], base[1], [0x03, Buffer.from([9])], base[3]])), L.LobbyError);   // maxp 9
  assert.throws(() => D.announceFields(F.encodeTLV([base[0], base[1], base[2], [0x04, Buffer.from([2])]])), L.LobbyError);   // mode 2
  assert.throws(() => D.announceFields(F.encodeTLV([[0x01, Buffer.from('lq\n1')], base[1], base[2], base[3]])), L.LobbyError); // control byte
  assert.throws(() => D.announceFields(F.encodeTLV([[0x01, Buffer.alloc(17, 0x61)], base[1], base[2], base[3]])), L.LobbyError); // map 17
  assert.throws(() => D.announceFields(F.encodeTLV([base[0], [0x02, Buffer.alloc(21, 0x74)], base[2], base[3]])), L.LobbyError); // title 21
  assert.throws(() => D.announceFields(Buffer.from([0x01, 0x00])), L.LobbyError);                 // truncated TLV
});

test('host: publish signs, binds live code, epoch 1, presence up', () => {
  const { h, swarms } = mkHost();
  h.onAnnounce(tlvPayload(GOOD));
  const adv = L.decodeAdvert(h.advert);
  assert.equal(adv.map, 'lqdm1');
  assert.deepEqual(adv.code, CODE10);
  assert.equal(adv.epoch, 1n);
  assert.equal(swarms.length, 1);
  assert.equal(swarms[0].destroyed, false);
});

test('host: sub-second re-announce debounces, latest content wins, epoch advances', async () => {
  const { h, clock } = mkHost();
  h.onAnnounce(tlvPayload(GOOD));
  h.onAnnounce(tlvPayload({ ...GOOD, map: 'lq_e1m1', mode: 0 }));
  assert.equal(L.decodeAdvert(h.advert).map, 'lqdm1');       // still the first publish
  await clock.advance(1100);
  const adv = L.decodeAdvert(h.advert);
  assert.equal(adv.map, 'lq_e1m1');
  assert.equal(adv.epoch, 2n);
});

test('host: cadence re-signs inside ttl; epochs persist across instances', async () => {
  const clock = fakeClock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qnlobbyd-'));
  const mk = () => D.makeHostLobby({
    keys: mkKeys(0x31), epochs: Q.makeEpochStore(dir), clock,
    swarmFactory: () => Object.assign(new EventEmitter(), { destroy() {} }),
    version: [0, 2], minVersion: [0, 2],
    getCode: () => CODE10, log: () => {},
  });
  const a = mk();
  a.onAnnounce(tlvPayload(GOOD));
  assert.equal(L.decodeAdvert(a.advert).epoch, 1n);
  await clock.advance(60000);
  assert.equal(L.decodeAdvert(a.advert).epoch, 2n);
  const b = mk();                                              // daemon restart
  b.onAnnounce(tlvPayload(GOOD));
  assert.equal(L.decodeAdvert(b.advert).epoch, 3n);            // never restarts at zero
  const files = fs.readdirSync(dir);
  assert.ok(files.some((f) => f.startsWith('epoch-')), 'epoch file present');
  assert.ok(files.every((f) => !f.endsWith('.tmp')), 'no tmp residue');
});

test('host: announce without a room code drops loudly and publishes nothing', () => {
  const { h, swarms, logs } = mkHost({ getCode: () => null });
  h.onAnnounce(tlvPayload(GOOD));
  assert.equal(h.advert, null);
  assert.equal(swarms.length, 0);
  assert.ok(logs.some((l) => l.includes('without room code')));
});

test('host: withdraw kills presence and the cadence', async () => {
  const { h, swarms } = mkHost();
  h.onAnnounce(tlvPayload(GOOD));
  h.onWithdraw();
  assert.equal(h.advert, null);
  assert.equal(swarms[0].destroyed, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.advert, null);                                // cadence cannot resurrect
});

test('host serve: advert framing on connect, silence after withdraw', () => {
  const { h } = mkHost();
  const chunks = [];
  const conn = Object.assign(new EventEmitter(), {
    write(b) { chunks.push(b); return true; },
    end() {},
    destroyed: false,
    destroy() { this.destroyed = true; },
  });
  h.serve(conn);                                               // nothing advertised yet
  assert.equal(conn.destroyed, true);
  assert.equal(chunks.length, 0);
  h.onAnnounce(tlvPayload(GOOD));
  const c2 = Object.assign(new EventEmitter(), {
    _chunks: chunks,
    write(b) { chunks.push(b); return true; },
    end() {},
    destroyed: false,
    destroy() { this.destroyed = true; },
  });
  h.serve(c2);
  const out = Buffer.concat(chunks);
  assert.equal(out.readUInt16LE(0), h.advert.length);
  assert.deepEqual(out.subarray(2), h.advert);
});

test('host: watermark survives persistence loss; code loss retires the listing', async () => {
  const clock = fakeClock();
  const saves = [];
  const swarms = [];
  let code = CODE10;
  const h = D.makeHostLobby({
    keys: mkKeys(0x41),
    epochs: { load: () => -1n, save: (s, m, v) => saves.push(v) },   // persistence wiped
    clock,
    swarmFactory: () => { const s = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } }); swarms.push(s); return s; },
    version: [0, 2], minVersion: [0, 2],
    getCode: () => code, log: () => {},
  });
  h.onAnnounce(tlvPayload(GOOD));
  assert.equal(L.decodeAdvert(h.advert).epoch, 1n);
  await clock.advance(60000);
  assert.equal(L.decodeAdvert(h.advert).epoch, 2n);            // watermark, not a reset to one
  code = null;
  await clock.advance(60000);                                  // cadence meets a dead room
  assert.equal(h.advert, null);
  assert.equal(swarms[swarms.length - 1].destroyed, true);     // nothing served on
  assert.equal(saves.length, 2);                               // no signing after retire
  await clock.advance(120000);
  assert.equal(h.advert, null);                                // cadence stays stopped
});

test('viewer: invalid adverts spend the meter (verify is the gated cost)', async () => {
  const { v, clock, frames } = mkViewer();
  v.start();
  const ad = advBuf();
  const h2 = Buffer.alloc(2); h2.writeUInt16LE(ad.length, 0);
  const bad = Buffer.from(ad); bad[bad.length - 1] ^= 1;
  for (let i = 0; i < 50; i++) feedFetch(v, Buffer.concat([h2, bad]));    // flood spends the bucket
  const live = advBuf(GOOD, 0x7a);                                          // honest host arrives
  const h3 = Buffer.alloc(2); h3.writeUInt16LE(live.length, 0);
  feedFetch(v, Buffer.concat([h3, live]));
  await clock.advance(20);
  assert.equal(v.live.length, 0);        // pre-metered tampering would have stored the good one
});

function mkViewer() {
  const clock = fakeClock();
  const frames = [];
  const swarms = [];
  const v = D.makeViewerLobby({
    clock,
    swarmFactory: () => { const s = new EventEmitter(); s.destroyed = false; s.destroy = () => { s.destroyed = true; }; swarms.push(s); return s; },
    send: (type, payload) => frames.push({ type, payload }),
    log: () => {},
  });
  return { v, clock, frames, swarms };
}

function advBuf(fields = GOOD, seedByte = 0x51, epoch = 1n) {
  const keys = mkKeys(seedByte);
  return L.encodeAdvert({ ...fields, code: Buffer.alloc(10, seedByte), pubkey: keys.pub,
    version: [0, 2], minVersion: [0, 2], epoch }, keys.priv);
}

function feedFetch(v, bytes) {
  const conn = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });
  v.fetch(conn);
  conn.emit('data', bytes);
  return conn;
}

test('viewer: start swaps an empty view; a valid fetch yields advert frame + terminator', async () => {
  const { v, clock, frames } = mkViewer();
  v.start();
  assert.deepEqual(frames, [{ type: F.TYPES.LOBBY_LIST, payload: Buffer.alloc(0) }]);
  const ad = advBuf();
  feedFetch(v, Buffer.concat([(() => { const h = Buffer.alloc(2); h.writeUInt16LE(ad.length, 0); return h; })(), ad]));
  await clock.advance(20);
  assert.equal(frames.length, 3);
  assert.deepEqual(frames[1].payload, ad);
  assert.equal(frames[1].type, F.TYPES.LOBBY_LIST);
  assert.equal(frames[2].payload.length, 0);
  assert.equal(v.live.length, 1);
});

test('viewer: every hostile fetch path drops silently', async () => {
  const { v, clock, frames } = mkViewer();
  v.start();
  const base = frames.length;
  const ad = advBuf();
  const hdr = (n) => { const h = Buffer.alloc(2); h.writeUInt16LE(n, 0); return h; };
  const bad = Buffer.from(ad); bad[bad.length - 1] ^= 1;
  feedFetch(v, Buffer.concat([hdr(bad.length), bad]));                 // tampered sig
  feedFetch(v, Buffer.concat([hdr(1300), Buffer.alloc(1300)]));        // oversized prefix
  feedFetch(v, Buffer.concat([hdr(ad.length), ad, Buffer.from('xx')]));         // trailing slop
  feedFetch(v, Buffer.concat([hdr(4), Buffer.alloc(4)]));              // bogus tiny len, short body
  const c = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });
  v.fetch(c);
  c.emit('data', hdr(200));                                            // never completes
  c.emit('close');
  assert.equal(c.destroyed, true);
  await clock.advance(20);
  assert.equal(frames.length, base);                                   // zero snapshots emitted
  assert.equal(v.live.length, 0);
});

test('viewer: ingest meter caps applies per second', async () => {
  const { v, clock, frames } = mkViewer();
  v.start();
  for (let i = 0; i < 60; i++) {
    const ad = advBuf(GOOD, (i % 250) + 1);                             // distinct keys (seedByte unique per advert)
    feedFetch(v, Buffer.concat([(() => { const h = Buffer.alloc(2); h.writeUInt16LE(ad.length, 0); return h; })(), ad]));
  }
  await clock.advance(20);
  assert.ok(v.live.length <= D.INGEST_PER_S, 'stored ' + v.live.length);
  assert.equal(v.live.length, D.INGEST_PER_S);
});

test('viewer: 30 s cadence rejoins and re-snapshots; stop is final', async () => {
  const { v, clock, frames, swarms } = mkViewer();
  v.start();
  const first = frames.length;
  await clock.advance(30000);
  assert.equal(swarms.length, 2);                                        // rejoin happened
  assert.ok(frames.length > first);                                      // fresh terminator
  v.stop();
  assert.equal(swarms[0].destroyed || swarms[1].destroyed, true);
  const before = frames.length;
  const conn = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });
  const ad = advBuf();
  const h = Buffer.alloc(2); h.writeUInt16LE(ad.length, 0);
  v.fetch(conn);
  assert.equal(conn.destroyed, true);                                    // refused after stop
  conn.emit('data', Buffer.concat([h, ad]));
  await clock.advance(50000);
  assert.equal(frames.length, before);                                   // nothing sent after stop
});
