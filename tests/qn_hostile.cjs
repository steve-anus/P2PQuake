#!/usr/bin/env node
'use strict';
/* tests/qn_hostile.cjs — daemon-side hostile advert battery over the REAL
 * transport (spec §3.6). The viewer is production makeViewerLobby (real
 * fetch-verify-collect, meter-before-verify) on a hyperdht testnet; the
 * publishers are raw hyperswarm servers on the lobby topic serving
 * crafted bytes: bad signature, expired TTL, epoch replay (regress and
 * tie), oversize, control bytes in the name, and junk. The honest
 * control adverts come from distinct keys and MUST surface, so no
 * absence claim is vacuous. The contract: hostile bytes never reach the
 * engine, never crash or wedge the viewer, never block the honest row. */
const assert = require('assert');
const crypto = require('crypto');
const DHT = require('hyperdht');
const Hyperswarm = require('hyperswarm');
const createTestnet = require('hyperdht/testnet');

const F = require('../src/peer/qn_frame.cjs');
const E = require('../src/peer/qn_envelope.cjs');
const L = require('../src/peer/qn_lobby.cjs');
const D = require('../src/peer/qn_lobbyd.cjs');

const WALL_BUDGET = 90000;
const code10 = (b) => Buffer.alloc(10, b);

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
  return { priv: E.privateKeyFromSeed(seed),
           pub: Buffer.from(E.publicRaw(E.publicKeyFromSeed(seed))) };
}

/* build a signed advert from field arrays, bypassing encode validation
 * on purpose to aim the verifier at hostile bytes */
function signedAdv(keys, f) {
  const epoch = Buffer.alloc(8); epoch.writeBigUInt64LE(f.epoch ?? 1n, 0);
  const ttl = Buffer.alloc(2); ttl.writeUInt16LE(f.ttlRaw ?? L.ADVERT_TTL, 0);
  const v = (p) => { const b = Buffer.alloc(4); b.writeUInt16LE(p[0], 0); b.writeUInt16LE(p[1], 2); return b; };
  const canonical = F.encodeTLV([
    [0x01, Buffer.from(f.map ?? 'lqdm1', 'latin1')],
    [0x02, Buffer.from(f.title ?? 'Hostile Suite', 'latin1')],
    [0x03, Buffer.from([f.maxPlayers ?? 8])],
    [0x04, Buffer.from([f.mode ?? 1])],
    [0x05, f.code ?? Buffer.alloc(10, 0x2b)],
    [0x06, f.pubkey ?? keys.pub],
    [0x07, f.verRaw ?? v(f.version ?? [0, 2])],
    [0x08, f.minVerRaw ?? v(f.minVersion ?? [0, 2])],
    [0x09, epoch],
    [0x0a, f.ttlField ?? ttl],
    [0x0b, Buffer.from([f.players ?? 2])],
  ]);
  const digest = crypto.createHash('sha256')
    .update(Buffer.concat([Buffer.from('QNLA', 'latin1'), canonical])).digest();
  return Buffer.concat([canonical, E.signWith(f.signWith ?? keys.priv, digest)]);
}

function framed(buf) {
  const h = Buffer.alloc(2);
  h.writeUInt16LE(buf.length, 0);
  return Buffer.concat([h, buf]);
}

const boot = []; /* swarms to destroy at exit */
function mkSwarm(bootstrap, topic, { server }) {
  const loop = bootstrap.every((b) => /^127\./.test(b.host));
  const dht = new DHT({ bootstrap, ephemeral: false, firewalled: false,
                        ...(loop ? { host: '127.0.0.1' } : {}) });
  const sw = new Hyperswarm({ dht });
  sw.on('error', () => {});
  boot.push(sw);
  const disc = sw.join(topic, { server, client: !server });
  sw.disc = disc;
  return sw;
}

const die = (m) => { console.error('HOSTILE FAIL: ' + m); process.exit(1); };

async function main() {
  const t0 = Date.now();
  const guard = setTimeout(() => die('wall budget'), WALL_BUDGET);
  const tnet = await createTestnet(3);
  const bootstrap = tnet.bootstrap.map((b) => ({ host: b.host, port: b.port }));
  console.log('HOSTILE: bootstrap=' + bootstrap.map((b) => `${b.host}:${b.port}`).join(','));

  const clock = fakeClock();
  const sink = [];            /* {type, payload} Plane A frames the daemon would send */
  const logs = [];
  const viewer = D.makeViewerLobby({
    clock,
    swarmFactory: (topic, opts) => mkSwarm(bootstrap, topic, opts),
    send: (type, payload) => sink.push({ type, payload }),
    log: (s) => logs.push(s),
  });

  /* publishers: one swarm per class; payload mutable per phase */
  const K = { ctrl: mkKeys(0x11), ctrl2: mkKeys(0x12), badsig: mkKeys(0x13),
              ctrlbyte: mkKeys(0x14), replay: mkKeys(0x15) };
  const servers = {};
  const pub = async (name, getBytes) => {
    const sw = mkSwarm(bootstrap, D.LOBBY_TOPIC, { server: true });
    sw.on('connection', (conn) => {
      conn.once('error', () => { try { conn.destroy(); } catch { /* gone */ } });
      const b = getBytes();
      if (b === null) return;               // stay silent (never answers)
      try { conn.write(b); conn.end(); } catch { /* gone */ }
    });
    await sw.disc.flushed();
    servers[name] = sw;
  };
  let replayPayload = signedAdv(K.replay, { title: 'REPLAY ROOM', epoch: 5n });

  await pub('honest', () => framed(signedAdv(K.ctrl, { title: 'HONEST CTRL' })));
  await pub('honest2', () => framed(signedAdv(K.ctrl2, { title: 'HONEST TWO' })));
  await pub('badsig', () => {
    const good = signedAdv(K.badsig, { title: 'BADSIG ROW' });
    const bad = Buffer.from(good);
    bad[bad.length - 1] ^= 0x01;
    return framed(bad);
  });
  await pub('ctrlbyte', () =>
    framed(signedAdv(K.ctrlbyte, { title: 'CTRL\x01BYTE ROW' })));
  await pub('replay', () => framed(replayPayload));
  await pub('oversize', () => {
    const h = Buffer.alloc(2); h.writeUInt16LE(1300, 0);
    return Buffer.concat([h, Buffer.alloc(4096, 0x41)]);
  });
  await pub('junk', () => framed(crypto.randomBytes(300)));

  viewer.start();

  const titles = () => {
    const out = [];
    for (const f of sink) {
      if (f.type !== F.TYPES.LOBBY_LIST || f.payload.length === 0) continue;
      /* every non-empty frame must be verifiable bytes: the daemon only
       * forwards what decodeAdvert accepted */
      const adv = (() => { try { return L.decodeAdvert(f.payload); } catch { return null; } })();
      assert.ok(adv, 'daemon forwarded a frame that fails verification');
      out.push(adv.title);
    }
    return out;
  };
  const settled = async (rounds = 8) => {
    for (let i = 0; i < rounds; i++) {
      await new Promise((r) => setTimeout(r, 150));
      await clock.advance(60);
    }
  };

  await settled();
  const seen = titles();
  const uniq = [...new Set(seen)].sort().join(',');
  console.log('HOSTILE: rows surfaced = [' + uniq + ']');
  assert.ok(seen.includes('HONEST CTRL'), 'honest control row never surfaced');
  assert.ok(seen.includes('HONEST TWO'), 'second honest row never surfaced');
  assert.ok(seen.includes('REPLAY ROOM'), 'first (epoch-5) replay publish never surfaced');
  for (const poison of ['BADSIG ROW', 'CTRL\x01BYTE ROW'])
    assert.ok(!seen.some((t) => t.includes('BADSIG') || t.includes('CTRL\x01BYTE') || t.includes('CTRL.BYTE')),
      'hostile row reached the engine: ' + poison);

  /* epoch regress: same pubkey, lower epoch — must not land */
  replayPayload = signedAdv(K.replay, { title: 'REPLAY ROOM', epoch: 3n });
  viewer.start();                       // re-WATCH forces re-discovery
  await settled();
  const rows = [];
  for (const f of sink)
    if (f.type === F.TYPES.LOBBY_LIST && f.payload.length)
      rows.push(L.decodeAdvert(f.payload));
  const rep = rows.filter((a) => a.title === 'REPLAY ROOM');
  assert.ok(rep.length > 0);
  for (const a of rep)
    assert.ok(a.epoch >= 5n, 'epoch REGRESSION reached the engine: ' + a.epoch);
  /* tie: same epoch must not re-surface as fresh (no 'stored') */
  replayPayload = signedAdv(K.replay, { title: 'REPLAY ROOM', epoch: 5n, players: 1 });
  viewer.start();
  await settled();
  const rows2 = sink.filter((f) => f.type === F.TYPES.LOBBY_LIST && f.payload.length)
    .map((f) => L.decodeAdvert(f.payload)).filter((a) => a.title === 'REPLAY ROOM');
  for (const a of rows2) assert.ok(a.epoch >= 5n && !(a.epoch === 5n && a.players === 1),
    'epoch TIE re-surfaced altered content');
  /* advance above the floor: proves the replay arm is live, not the
   * viewer deaf — the newest-wins path must carry it */
  replayPayload = signedAdv(K.replay, { title: 'REPLAY ROOM', epoch: 7n });
  viewer.start();
  await settled();
  const rows3 = sink.filter((f) => f.type === F.TYPES.LOBBY_LIST && f.payload.length)
    .map((f) => L.decodeAdvert(f.payload)).filter((a) => a.title === 'REPLAY ROOM');
  assert.ok(rows3.some((a) => a.epoch === 7n), 'epoch advance never surfaced (viewer deaf?)');

  /* TTL expiry: past the budget every row must drop from snapshots */
  await clock.advance(200000);
  sink.length = 0;
  viewer.snapshot();
  assert.strictEqual(titles().length, 0, 'expired adverts survived the ttl budget');
  /* viewer alive after everything: a fresh honest row still lands */
  await pub('late', () => framed(signedAdv(mkKeys(0x16), { title: 'LATE HONEST', epoch: 9n })));
  viewer.start();
  await settled(12);
  assert.ok(titles().includes('LATE HONEST'), 'viewer wedged after the battery');
  assert.ok(!logs.some((l) => /FATAL/i.test(l)), 'daemon logged a FATAL in the battery');

  for (const sw of boot) { try { await sw.destroy(); } catch { /* gone */ } }
  try { await tnet.destroy(); } catch { /* gone */ }
  clearTimeout(guard);
  console.log('HOSTILE OK: bad-sig, ttl-expiry, epoch replay (regress+tie), oversize,'
    + ' control bytes, junk — all silently dropped; honest rows + advances surfaced'
    + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
  process.exit(0);
}

main().catch((e) => die('crash: ' + (e && e.stack || e)));
