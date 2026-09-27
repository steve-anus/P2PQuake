'use strict';
// Two-daemon public-lobby discovery lane: a host daemon announces a
// public room (LOBBY_ANNOUNCE -> signed advert on the presence topic)
// and a viewer daemon collects, verifies, and snapshots it over Plane A
// (LOBBY_WATCH -> LOBBY_LIST frames + terminator). Real hyperswarm on
// the hyperdht testnet; daemons parented through bin/fake-engine so the
// §3.4a build-id check passes. Run: node tests/qn_discovery.cjs
// (after `make fake-engine`). Exit 0 = DISCOVERY OK.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const createTestnet = require('hyperdht/testnet');
const F = require('../src/peer/qn_frame.cjs');
const E = require('../src/peer/qn_envelope.cjs');
const L = require('../src/peer/qn_lobby.cjs');

const ROOT = path.join(__dirname, '..');
const PEER = path.join(ROOT, 'src', 'peer', 'qn-peer.cjs');
const FAKE_ENGINE = path.join(ROOT, 'bin', 'fake-engine');
const BUDGET_MS = 60000;

const TRUTH = { map: 'lqdm1', title: 'Lane Lobby', maxPlayers: 6, mode: 1, players: 2 };
const HOST_SEED = crypto.randomBytes(32);

let assertions = 0;
const ok = (fn, why) => { try { fn(); assertions++; } catch (e) { die('ASSERT: ' + why + ' :: ' + e.message); } };
function die(why) {
  console.log('DISCOVERY FAIL ' + why);
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  process.exit(1);
}
const children = [];
let finished = false;

function mkDir() {
  const dir = mkdtempTracked('qndisc-');
  fs.chmodSync(dir, 0o700);
  return dir;
}

// minimal engine-side of Plane A: verifies AUTH, answers PING, scripts
// sends, queues received frames for the scenario
function fakeEngine(sockPath, token) {
  const st = { frames: [], authed: false, conns: 0 };
  let resolveAuth;
  st.authedP = new Promise((r) => { resolveAuth = r; });
  const server = net.createServer((conn) => {
    st.conns++;
    const fr = new F.FrameReader();
    let engineSeq = 1;
    const send = (type, payload) => conn.write(F.encodeFrame(type, engineSeq++, payload));
    st.send = send;
    conn.on('data', (c) => {
      let frames;
      try { frames = fr.feed(c); } catch { die('engine socket: malformed plane-A stream'); }
      for (const f of frames) {
        if (!st.authed) {
          if (!(f.type === F.TYPES.AUTH && f.seq === 1 &&
                f.payload.length === 32 &&
                crypto.timingSafeEqual(f.payload, token)))
            return die('engine socket: bad AUTH frame');
          st.authed = true;
          resolveAuth();
          continue;
        }
        if (f.type === F.TYPES.PING) { send(F.TYPES.PONG, f.payload); continue; }
        st.frames.push(f);
      }
    });
    conn.on('error', () => {});
  });
  server.listen(sockPath);
  return { st };
}

function spawnDaemon(sockPath, dir, token, bootEnv) {
  if (!fs.existsSync(FAKE_ENGINE)) die('missing bin/fake-engine (run make fake-engine)');
  const gamedata = path.join(ROOT, 'gamedata.sha256');
  const child = spawn(FAKE_ENGINE,
    ['--uds', sockPath, '--gamedata', gamedata, '--gamedir', 'id1', '--dir', dir, '--name', 'LaneHost'],
    { env: { ...process.env, QN_FAKE_ENGINE_NODE: process.execPath,
             QN_FAKE_ENGINE_SCRIPT: PEER, QN_DHT_BOOTSTRAP: bootEnv },
      stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const lines = [];
  child.stdout.on('data', (c) => lines.push(c.toString()));
  child.stderr.on('data', (c) => lines.push(c.toString()));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null && !finished)
      die('daemon exited code ' + code + ' :: ' + lines.join('').slice(-300));
  });
  child.stdin.write(token);
  const logText = () => lines.join('');
  return { child, logText };
}

async function waitFor(prep, what, ms = 20000, diag = null) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (prep()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (diag) console.log('DIAG[' + what + ']: ' + diag());
  die('timeout waiting for ' + what);
}

async function main() {
  const hard = setTimeout(() => die('budget exhausted'), BUDGET_MS);
  hard.unref();

  const tnet = await createTestnet(3);
  const boot = tnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(',');
  console.log('DISCOVERY: bootstrap=' + boot);

  const hostDir = mkDir();
  fs.writeFileSync(path.join(hostDir, 'identity.key'), HOST_SEED.toString('hex') + '\n', { mode: 0o600 });
  const expectPub = Buffer.from(E.publicRaw(E.publicKeyFromSeed(HOST_SEED)));
  const viewDir = mkDir();

  const tokH = crypto.randomBytes(32), tokV = crypto.randomBytes(32);
  const sH = mkDir(), sV = mkDir();
  const engH = fakeEngineSafe(path.join(sH, 'a.sock'), tokH);
  const engV = fakeEngineSafe(path.join(sV, 'a.sock'), tokV);
  const dH = spawnDaemon(path.join(sH, 'a.sock'), hostDir, tokH, boot);
  const dV = spawnDaemon(path.join(sV, 'a.sock'), viewDir, tokV, boot);

  await Promise.all([engH.st.authedP, engV.st.authedP]);

  // host: open the room, capture the join code, go public
  engH.st.send(F.TYPES.HOST_UP, F.encodeTLV([
    [0x01, Buffer.from(TRUTH.map, 'latin1')],
    [0x02, Buffer.from('LanE Host', 'latin1')],
    [0x03, Buffer.from([8])],
  ]));
  await waitFor(() => engH.st.frames.find((f) => f.type === F.TYPES.HOST_READY), 'HOST_READY');
  const ready = engH.st.frames.find((f) => f.type === F.TYPES.HOST_READY);
  const code = new Map(F.decodeTLV(ready.payload).map((x) => [x.tag, x.value])).get(0x01);
  ok(() => assert.equal(code.length, 10), 'join code shape');

  engH.st.send(F.TYPES.LOBBY_ANNOUNCE, F.encodeTLV([
    [0x01, Buffer.from(TRUTH.map, 'latin1')],
    [0x02, Buffer.from(TRUTH.title, 'latin1')],
    [0x03, Buffer.from([TRUTH.maxPlayers])],
    [0x04, Buffer.from([TRUTH.mode])],
    [0x05, Buffer.from([TRUTH.players])],
  ]));
  await waitFor(() => dH.logText().includes('lobby: announced'), 'host announce');

  // viewer: watch the public topic, await a verified snapshot
  const lists = () => engV.st.frames.filter((f) => f.type === F.TYPES.LOBBY_LIST);
  engV.st.send(F.TYPES.LOBBY_WATCH, Buffer.alloc(0));
  await waitFor(() => takeSnapshot(lists()) !== null,
    'viewer LOBBY_LIST snapshot', 30000,
    () => `engV=[${engV.st.frames.map((f) => f.type + ':' + f.payload.length)}] ` +
      `engH=[${engH.st.frames.map((f) => f.type + ':' + f.payload.length)}] ` +
      `dH="${dH.logText().slice(-220)}" dV="${dV.logText().slice(-220)}"`);

  const snap = takeSnapshot(lists());
  ok(() => assert.ok(snap !== null, 'snapshot bracketed by terminator'), 'snapshot framing');
  const adv = L.decodeAdvert(snap[0]);
  ok(() => assert.equal(adv.map, TRUTH.map), 'advert map');
  ok(() => assert.equal(adv.title, TRUTH.title), 'advert title');
  ok(() => assert.equal(adv.maxPlayers, TRUTH.maxPlayers), 'advert maxp');
  ok(() => assert.equal(adv.mode, TRUTH.mode), 'advert mode');
  ok(() => assert.equal(adv.players, TRUTH.players), 'advert players');
  ok(() => assert.deepEqual(adv.code, code), 'advert carries the join code');
  ok(() => assert.deepEqual(adv.pubkey, expectPub), 'advert signed by host identity');
  ok(() => assert.equal(adv.epoch, 1n), 'advert epoch starts at one');
  const firstEpoch = adv.epoch;            // observed well inside the 60 s cadence window

  // re-announce: latest content wins, epoch advances, viewer resurfaces it
  engH.st.send(F.TYPES.LOBBY_ANNOUNCE, F.encodeTLV([
    [0x01, Buffer.from('lq_e1m1', 'latin1')],
    [0x02, Buffer.from('Renamed Lobby', 'latin1')],
    [0x03, Buffer.from([4])],
    [0x04, Buffer.from([0])],
    [0x05, Buffer.from([1])],
  ]));
  const renamedSeen = () => {              // inside a terminator-completed group only
    for (const g of completedSnapshots(lists()))
      for (const b of g) { try { if (L.decodeAdvert(b).map === 'lq_e1m1') return b; } catch { /* skip */ } }
    return null;
  };
  await waitFor(() => renamedSeen() !== null, 're-announce surfacing', 30000);
  const renamed = L.decodeAdvert(renamedSeen());
  ok(() => assert.ok(renamed.epoch === firstEpoch + 1n || renamed.epoch === firstEpoch + 2n,
    'epoch ' + renamed.epoch), 're-announce epoch advanced');

  // teardown withdraws
  engH.st.send(F.TYPES.HOST_DOWN, Buffer.alloc(0));
  await waitFor(() => dH.logText().includes('lobby: withdrawn'), 'withdraw on host-down');

  finished = true;
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  if (typeof tnet.destroy === 'function') { try { await tnet.destroy(); } catch { /* gone */ } }
  clearTimeout(hard);
  console.log(`DISCOVERY OK: ${assertions} assertions, 2 daemons, bootstrap=${boot}`);
  process.exit(0);                                        // lingering server handles
}

// snapshots are runs ended by an empty-payload terminator; return the
// first one that actually carries adverts (the start-swap is empty)
function completedSnapshots(list) {
  const groups = [];
  let cur = [];
  for (const f of list) {
    if (f.payload.length === 0) { if (cur.length) groups.push(cur); cur = []; }
    else cur.push(f.payload);
  }
  return groups;
}
function takeSnapshot(list) {
  const g = completedSnapshots(list);
  return g.length ? g[0] : null;
}

function fakeEngineSafe(sockPath, token) {
  fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });
  return fakeEngine(sockPath, token);
}

const TMP_MADE = [];
function mkdtempTracked(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_MADE.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of TMP_MADE) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

main().catch((e) => die('crash: ' + (e && e.stack || e)));
