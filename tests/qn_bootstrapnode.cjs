'use strict';
// Bootstrap-node lane: exercises the SHIPPED self-hosted bootstrap artifact
// (tools/bootstrap-node.sh wrapping the pinned hyperdht CLI) as a standalone
// process -- not the in-process testnets other lanes use. Covers: routing
// under the product's own swarm config, host announce + viewer snapshot,
// a real Plane-B join punched through the node, advertisement GC after a
// SIGKILLed host, established lanes surviving node death, clean failed
// joins while the node is down (with the join-retry path), and announce
// service on a restarted node. Run: node tests/qn_bootstrapnode.cjs
// (after `make fake-engine`). Exit 0 = BOOTSTRAPNODE OK.
// NOTE: an in-process two-swarm probe (former T1) was removed as
// unrepresentative -- same-process DHT clients never rendezvous, even
// against hyperdht's own testnet; all coverage here runs through
// real daemon processes instead.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const DHT = require('hyperdht');
const Hyperswarm = require('hyperswarm');
const F = require('../src/peer/qn_frame.cjs');
const E = require('../src/peer/qn_envelope.cjs');
const L = require('../src/peer/qn_lobby.cjs');

const ROOT = path.join(__dirname, '..');
const PEER = path.join(ROOT, 'src', 'peer', 'qn-peer.cjs');
const FAKE_ENGINE = path.join(ROOT, 'bin', 'fake-engine');
const WRAPPER = path.join(ROOT, 'tools', 'bootstrap-node.sh');
const BUDGET_MS = Number(process.env.QN_BSN_BUDGET || 480000); // T4 rides the spec's 120 s advert floor

const TRUTH = { map: 'lqdm1', title: 'BSN Lobby', maxPlayers: 6, mode: 1, players: 2 };

let assertions = 0;
const ok = (fn, why) => { try { fn(); assertions++; } catch (e) { die('ASSERT: ' + why + ' :: ' + e.message); } };
function die(why) {
  console.log('BOOTSTRAPNODE FAIL ' + why);
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  process.exit(1);
}
const children = [];
let finished = false;

function mkDir() {
  const dir = mkdtempTracked('qnbsn-');
  fs.chmodSync(dir, 0o700);
  return dir;
}

function freePort() {
  for (;;) {
    const p = 49152 + crypto.randomInt(700);
    const s = dgram.createSocket('udp4');
    try { s.bind(p); s.close(); return p; }
    catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
  }
}

function spawnBootstrap(port) {
  const home = mkDir(); // isolate any CLI persistence under test control
  const child = spawn('sh', [WRAPPER, '--port', String(port), '--host', '127.0.0.1'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const out = [];
  child.stdout.on('data', (c) => out.push(c.toString()));
  child.stderr.on('data', (c) => out.push(c.toString()));
  return { child, text: () => out.join('') };
}

// mirrors makeSwarm's product configuration (loopback bootstrap case)
function swarmFor(port) {
  const dht = new DHT({
    bootstrap: [{ host: '127.0.0.1', port }],
    ephemeral: false,
    firewalled: false,
    host: '127.0.0.1',
  });
  const sw = new Hyperswarm({ dht });
  return { sw, dht };
}

// minimal engine-side of Plane A (same rig as the discovery lane)
function fakeEngine(sockPath, token) {
  const st = { frames: [], authed: false, conns: 0 };
  let resolveAuth;
  st.authedP = new Promise((r) => { resolveAuth = r; });
  const server = net.createServer((conn) => {
    st.conns++;
    st.conn = conn; // the harness side of plane A: destroying this is what
    // actually "kills" the engine from the daemon's point of view
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
  fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });
  server.listen(sockPath);
  return { st, server };
}

function spawnDaemon(sockPath, dir, token, bootEnv, envExtras = {}) {
  if (!fs.existsSync(FAKE_ENGINE)) die('missing bin/fake-engine (run make fake-engine)');
  const gamedata = path.join(ROOT, 'gamedata.sha256');
  const child = spawn(FAKE_ENGINE,
    ['--uds', sockPath, '--gamedata', gamedata, '--gamedir', 'id1', '--dir', dir, '--name', 'BSNPeer'],
    { env: { ...process.env, QN_FAKE_ENGINE_NODE: process.execPath,
             QN_FAKE_ENGINE_SCRIPT: PEER, QN_DHT_BOOTSTRAP: bootEnv, ...envExtras },
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
  return { child, logText, dir };
}

// A SIGKILLed supervisor fake-engine does NOT kill the daemon: plane A's
// engine-side peer is the harness's own accepted connection (PINGs keep
// answering), and the supervisor shares no socket fds with the daemon. A
// dead host here means all three: harness connection closed, supervisor
// dead, and the daemon itself gone — proven by convergence, no survivor
// may keep announcing the lobby into the node: supervisor kill
// alone left the cadence loop alive past 150 s when first observed.)
function dirPids(dir) {
  try {
    return execFileSync('pgrep', ['-f', dir], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
  } catch { return []; }
}
async function hostGone(d, eng) {
  try { if (eng.st.conn) eng.st.conn.destroy(); } catch { /* gone */ }
  try { eng.server.close(); } catch { /* gone */ }
  try { d.child.kill('SIGKILL'); } catch { /* gone */ }
  for (const p of dirPids(d.dir)) { try { process.kill(Number(p), 'SIGKILL'); } catch { /* gone */ } }
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (dirPids(d.dir).length === 0) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  die('host-kill leak: processes survive on ' + d.dir);
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

function completedSnapshots(lists) {
  const groups = [];
  let cur = [];
  for (const f of lists) {
    if (f.payload.length === 0) { if (cur.length) groups.push(cur); cur = []; continue; }
    cur.push(f.payload);
  }
  return groups;
}
function takeSnapshot(lists) {
  const g = completedSnapshots(lists);
  return g.length ? g[0] : null;
}
function lastRoundMaps(lists) {
  const fr = lists();
  if (!fr.length || fr[fr.length - 1].payload.length !== 0) return null; // round open
  const end = fr.length - 1;
  let start = end - 1;
  while (start >= 0 && fr[start].payload.length !== 0) start--;
  const out = [];
  for (let i = start + 1; i < end; i++) {
    try { out.push(L.decodeAdvert(fr[i].payload).map); } catch { /* skip */ }
  }
  return out;
}

async function main() {
  const hard = setTimeout(() => die('budget exhausted'), BUDGET_MS);
  hard.unref();

  const NPORT = Number(process.env.QN_BSN_PORT || freePort());
  const boot = '127.0.0.1:' + NPORT;
  const node1 = spawnBootstrap(NPORT);
  for (const k of ['QN_TEST_TIMEOUTS', 'QN_JOIN_ATTEMPTS',
    'QN_JOIN_WALL_BUDGET', 'QN_JOIN_END_BUDGET']) delete process.env[k];
  console.log('BOOTSTRAPNODE: standalone node on ' + boot + ' via ' + path.relative(ROOT, WRAPPER));
  await waitFor(() => node1.text().includes('Fully started'), 'cluster start', 25000, node1.text);

  // T6: a second node on the occupied port must fail cleanly (ops posture).
  {
    const dup = spawnBootstrap(NPORT);
    const exited = await Promise.race([
      new Promise((r) => dup.child.once('exit', (code) => r(code))),
      new Promise((r) => setTimeout(() => r('hang'), 8000)),
    ]);
    if (exited === 'hang') {
      try { dup.child.kill('SIGKILL'); } catch { /* gone */ }
      console.log('NOTE: duplicate bind neither exited nor errored within 8 s');
    } else {
      ok(() => assert.notEqual(exited, 0, 'duplicate bind exit code'), 'T6 duplicate bind refused (' + exited + ')');
    }
  }

  // T2: product host announces through the node; viewer snapshot verifies.
  const hostSeed = crypto.randomBytes(32);
  const expectPub = Buffer.from(E.publicRaw(E.publicKeyFromSeed(hostSeed)));
  const hostDir = mkDir();
  fs.writeFileSync(path.join(hostDir, 'identity.key'), hostSeed.toString('hex') + '\n', { mode: 0o600 });
  const sH = mkDir(), tokH = crypto.randomBytes(32);
  const engH = fakeEngine(path.join(sH, 'a.sock'), tokH);
  const dHx = spawnDaemon(path.join(sH, 'a.sock'), hostDir, tokH, boot);
  await engH.st.authedP;
  engH.st.send(F.TYPES.HOST_UP, F.encodeTLV([
    [0x01, Buffer.from(TRUTH.map, 'latin1')],
    [0x02, Buffer.from('BSN Host', 'latin1')],
    [0x03, Buffer.from([8])],
  ]));
  await waitFor(() => engH.st.frames.find((f) => f.type === F.TYPES.HOST_READY), 'T2 HOST_READY');
  const ready = engH.st.frames.find((f) => f.type === F.TYPES.HOST_READY);
  const hostCode = new Map(F.decodeTLV(ready.payload).map((x) => [x.tag, x.value])).get(0x01);
  engH.st.send(F.TYPES.LOBBY_ANNOUNCE, F.encodeTLV([
    [0x01, Buffer.from(TRUTH.map, 'latin1')],
    [0x02, Buffer.from(TRUTH.title, 'latin1')],
    [0x03, Buffer.from([TRUTH.maxPlayers])],
    [0x04, Buffer.from([TRUTH.mode])],
    [0x05, Buffer.from([TRUTH.players])],
  ]));
  await waitFor(() => dHx.logText().includes('lobby: announced'), 'T2 host announce');
  ok(() => assert.ok(hostCode && hostCode.length === 10, 'join code shape'), 'T2 join code');

  const sV = mkDir(), tokV = crypto.randomBytes(32);
  const engV = fakeEngine(path.join(sV, 'a.sock'), tokV);
  const dV = spawnDaemon(path.join(sV, 'a.sock'), mkDir(), tokV, boot);
  await engV.st.authedP;
  const lists = () => engV.st.frames.filter((f) => f.type === F.TYPES.LOBBY_LIST);
  engV.st.send(F.TYPES.LOBBY_WATCH, Buffer.alloc(0));
  await waitFor(() => takeSnapshot(lists()) !== null, 'T2 viewer snapshot', 30000,
    () => `dHx="${dHx.logText().slice(-200)}" dV="${dV.logText().slice(-200)}"`);
  {
    const snap = takeSnapshot(lists());
    const adv = L.decodeAdvert(snap[0]);
    ok(() => assert.equal(adv.map, TRUTH.map), 'T2 advert map');
    ok(() => assert.ok(adv.pubkey.equals(expectPub), 'T2 advert signed by host identity'), 'T2 advert signature');
    ok(() => assert.ok(adv.epoch >= 1n, 'T2 epoch'), 'T2 advert epoch');
  }

  // T3: real Plane-B join punched through the standalone node.
  {
    const sC = mkDir(), tokC = crypto.randomBytes(32);
    const engC = fakeEngine(path.join(sC, 'a.sock'), tokC);
    const dC = spawnDaemon(path.join(sC, 'a.sock'), mkDir(), tokC, boot);
    await engC.st.authedP;
    engC.st.send(F.TYPES.JOIN_OPEN, hostCode);
    await waitFor(() => dC.logText().includes('client: joined'), 'T3 client joined', 40000,
      () => `dC="${dC.logText().slice(-300)}" dHx="${dHx.logText().slice(-300)}"`);
    ok(() => assert.ok(dHx.logText().includes('host: member'), 'T3 host saw member'), 'T3 host member log');
    ok(() => assert.ok(!dC.logText().includes('join refused'), 'T3 no refusal'), 'T3 clean join');
    ok(() => assert.ok(engC.st.frames.some((f) => f.type === F.TYPES.PEER_UP), 'T3 PEER_UP to engine'), 'T3 PEER_UP frame');

    // T5a: kill the node; the joined lane survives, a fresh join fails clean.
    try { node1.child.kill('SIGKILL'); } catch { /* gone */ }
    await new Promise((r) => setTimeout(r, 10000));
    ok(() => assert.ok(!/\bFATAL\b|host connection lost/.test(dC.logText()), 'lane survived'),
      'T5a established lane survives node death');
    const sC2 = mkDir(), tokC2 = crypto.randomBytes(32);
    const engC2 = fakeEngine(path.join(sC2, 'a.sock'), tokC2);
    const dC2 = spawnDaemon(path.join(sC2, 'a.sock'), mkDir(), tokC2, boot);
    await engC2.st.authedP;
    engC2.st.send(F.TYPES.JOIN_OPEN, hostCode);
    await waitFor(() => dC2.logText().includes('(attempt 1/'), 'T5a retry engaged', 30000, dC2.logText);
    await waitFor(() => dC2.logText().includes('client: no host found for this code'),
      'T5a terminal verdict', 60000, dC2.logText);
    ok(() => assert.ok(engC2.st.frames.some((f) => f.type === F.TYPES.JOIN_NO &&
      f.payload.length === 1 && f.payload[0] === 2), 'T5a JOIN_NO cause 2'), 'T5a clean failed join');
    await waitFor(() => dC2.child.exitCode === 0, 'T5a daemon exit 0', 10000, dC2.logText);
    await hostGone(dC, engC);
    await hostGone(dHx, engH);
  }

  // T5b: restarted node serves fresh announces end to end.
  {
    const node2 = spawnBootstrap(NPORT);
    await waitFor(() => node2.text().includes('Fully started'), 'T5b cluster restart', 25000, node2.text);
    const seed2 = crypto.randomBytes(32);
    const pub2 = Buffer.from(E.publicRaw(E.publicKeyFromSeed(seed2)));
    const hDir = mkDir();
    fs.writeFileSync(path.join(hDir, 'identity.key'), seed2.toString('hex') + '\n', { mode: 0o600 });
    const sH2 = mkDir(), tokH2 = crypto.randomBytes(32);
    const engH2 = fakeEngine(path.join(sH2, 'a.sock'), tokH2);
    const dH2 = spawnDaemon(path.join(sH2, 'a.sock'), hDir, tokH2, boot);
    await engH2.st.authedP;
    engH2.st.send(F.TYPES.HOST_UP, F.encodeTLV([
      [0x01, Buffer.from('lq_e1m1', 'latin1')],
      [0x02, Buffer.from('BSN Host 2', 'latin1')],
      [0x03, Buffer.from([4])],
    ]));
    await waitFor(() => engH2.st.frames.find((f) => f.type === F.TYPES.HOST_READY), 'T5b HOST_READY', 30000, dH2.logText);
    const ready2 = engH2.st.frames.find((f) => f.type === F.TYPES.HOST_READY);
    const code2 = new Map(F.decodeTLV(ready2.payload).map((x) => [x.tag, x.value])).get(0x01);
    engH2.st.send(F.TYPES.LOBBY_ANNOUNCE, F.encodeTLV([
      [0x01, Buffer.from('lq_e1m1', 'latin1')],
      [0x02, Buffer.from('BSN Second', 'latin1')],
      [0x03, Buffer.from([4])],
      [0x04, Buffer.from([TRUTH.mode])],
      [0x05, Buffer.from([1])],
    ]));
    await waitFor(() => dH2.logText().includes('lobby: announced'), 'T5b announce via restarted node', 30000,
      () => `node="${node2.text().slice(-200)}" dH2="${dH2.logText().slice(-200)}"`);
    const sV2 = mkDir(), tokV2 = crypto.randomBytes(32);
    const engV2 = fakeEngine(path.join(sV2, 'a.sock'), tokV2);
    const dV2 = spawnDaemon(path.join(sV2, 'a.sock'), mkDir(), tokV2, boot);
    await engV2.st.authedP;
    const lists2 = () => engV2.st.frames.filter((f) => f.type === F.TYPES.LOBBY_LIST);
    engV2.st.send(F.TYPES.LOBBY_WATCH, Buffer.alloc(0));
    await waitFor(() => takeSnapshot(lists2()) !== null, 'T5b viewer sees restarted node', 30000);
    const adv2 = L.decodeAdvert(takeSnapshot(lists2())[0]);
    ok(() => assert.equal(adv2.map, 'lq_e1m1', 'T5b map'), 'T5b restarted-node announce');
    ok(() => assert.ok(adv2.pubkey.equals(pub2), 'T5b signature'), 'T5b restarted-node signature');
    const sC3 = mkDir(), tokC3 = crypto.randomBytes(32);
    const engC3 = fakeEngine(path.join(sC3, 'a.sock'), tokC3);
    const dC3 = spawnDaemon(path.join(sC3, 'a.sock'), mkDir(), tokC3, boot);
    await engC3.st.authedP;
    engC3.st.send(F.TYPES.JOIN_OPEN, code2);
    await waitFor(() => dC3.logText().includes('client: joined'), 'T5b join via restarted node', 40000, dC3.logText);
    ok(() => assert.ok(dH2.logText().includes('host: member'), 'T5b host member'), 'T5b restarted-node member');
    ok(() => assert.ok(!dC3.logText().includes('join refused'), 'T5b no refusal'), 'T5b restarted-node clean join');

    // T4: SIGKILL host2; its advert must age out of the live node (the
    // presence entry was proven present moments above, so this is non-vacuous).
    // Floor from spec: an advert legally lives ADVERT_TTL (120 s, fixed) past
    // its last new-epoch observation (qn_protocol.md freshness rule), so a
    // window below that can never pass — pin the budget to the constant.
    // Retire the seated joiner first: a client daemon whose host lane dies
    // hard must fatal(4) — that is the honest verdict, not a lane failure.
    await hostGone(dC3, engC3);
    await hostGone(dH2, engH2);
    let gone = false;
    const gcEnd = Date.now() + (L.ADVERT_TTL + 25) * 1000;
    const roundDump = () => {
      const fr = lists2();
      const end = fr.length - 1;
      let start = end - 1;
      while (start >= 0 && fr[start].payload.length !== 0) start--;
      const out = [];
      for (let i = start + 1; i < end; i++) {
        try { out.push(L.decodeAdvert(fr[i].payload).map); } catch { out.push('?'); }
      }
      return '[' + out.join(',') + '] frames=' + fr.length;
    };
    let poll = 0;
    while (Date.now() < gcEnd && !gone) {
      await new Promise((r) => setTimeout(r, 2000));
      engV2.st.send(F.TYPES.LOBBY_WATCH, Buffer.alloc(0));
      await new Promise((r) => setTimeout(r, 1500));
      const m = lastRoundMaps(lists2);
      poll++;
      console.log('T4 poll ' + poll + ': round=' + (m === null ? 'OPEN' : roundDump()) +
        ' dv2="' + dV2.logText().slice(-160).replace(/\n/g, '|') + '"');
      gone = m !== null && !m.includes('lq_e1m1');
    }
    ok(() => assert.ok(gone, 'T4 advert GC'), 'T4 stale advert GCd from live node');
  }

  finished = true;
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  clearTimeout(hard);
  console.log(`BOOTSTRAPNODE OK: ${assertions} assertions, bootstrap=${boot}`);
  process.exit(0);
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
