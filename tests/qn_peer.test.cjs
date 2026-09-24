'use strict';
// qn-peer Plane A handshake tests (spec §4). The fake-engine server
// enforces the engine side: AUTH first frame at seq 1, constant-time
// token compare, mismatch/malformed closes, AUTH at most once. Children
// are the real qn-peer binary. Temp sockets live in a 0700 mkdtemp dir.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const F = require('../src/peer/qn_frame.cjs');
const R = require('../src/peer/qn_room.cjs');
const Q = require('../src/peer/qn-peer.cjs');

const PEER = path.join(__dirname, '..', 'src', 'peer', 'qn-peer.cjs');

function mkSocketPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qnpeer-test-'));
  fs.chmodSync(dir, 0o700); // UDS hygiene rule, mirrored on the engine side
  return { dir, sockPath: path.join(dir, 'a.sock') };
}

// Engine-side of §4: first frame must be AUTH seq 1 with exactly the
// expected token; anything else (or a second AUTH) closes. Resolves
// firstFrame once a frame arrives, tracks connection count.
function fakeEngine(t, expected) {
  const { dir, sockPath } = mkSocketPath();
  const state = { conns: 0, closedBad: false };
  let resolveFrame, rejectFrame;
  const firstFrame = new Promise((res, rej) => { resolveFrame = res; rejectFrame = rej; });
  const server = net.createServer((conn) => {
    state.conns++;
    const fr = new F.FrameReader();
    let done = false;
    conn.on('data', (c) => {
      let frames;
      try { frames = fr.feed(c); }
      catch { state.closedBad = true; conn.destroy(); return; } // malformed ⇒ close
      for (const f of frames) {
        const ok = !done && f.type === F.TYPES.AUTH && f.seq === 1 &&
          Buffer.isBuffer(f.payload) && f.payload.length === expected.length &&
          crypto.timingSafeEqual(f.payload, expected);
        if (ok) { done = true; resolveFrame(f); }
        else { state.closedBad = true; conn.destroy(); } // mismatch / AUTH-twice
      }
    });
    conn.on('error', () => {});
  });
  const ready = new Promise((res) => server.listen(sockPath, () => res()));
  let torn = false;
  const teardown = async () => {
    if (torn) return; torn = true;
    server.close(); server.closeAllConnections?.();
    fs.rmSync(dir, { recursive: true, force: true }); // our own temp dir only
  };
  t.after(teardown); // cleanup must run even when an assert throws
  return { sockPath, state, firstFrame, ready, teardown,
    reject: (e) => rejectFrame(e) };
}

const FAKE_ENGINE = path.join(__dirname, '..', 'bin', 'fake-engine');

function spawnPeer(t, sockPath, extra = []) {
  const child = spawn(FAKE_ENGINE, ['--uds', sockPath, ...extra], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, QN_FAKE_ENGINE_NODE: process.execPath,
      QN_FAKE_ENGINE_SCRIPT: PEER },
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exits;
  });
  const exits = new Promise((res) => {
    child.once('exit', (code, sig) => res({ code, sig }));
  });
  const err = [];
  child.stderr.on('data', (c) => err.push(c));
  return { child, exits, errText: () => Buffer.concat(err).toString('utf8') };
}

test('AUTH handshake: first frame is AUTH seq 1 carrying the stdin token', async (t) => {
  const token = crypto.randomBytes(32);
  const eng = fakeEngine(t, token);
  await eng.ready;
  const p = spawnPeer(t, eng.sockPath);
  p.child.stdin.write(token);
  const f = await eng.firstFrame;
  assert.equal(f.type, F.TYPES.AUTH);
  assert.equal(f.seq, 1);
  assert.deepEqual(f.payload, token);
  assert.equal(p.child.exitCode, null); // daemon alive after handshake
  p.child.kill(); await p.exits;
  await eng.teardown();
});

test('wrong token: engine-side closes, peer exits nonzero (fail-closed)', async (t) => {
  const expected = crypto.randomBytes(32);
  const eng = fakeEngine(t, expected);
  await eng.ready;
  const p = spawnPeer(t, eng.sockPath);
  p.child.stdin.write(crypto.randomBytes(32)); // valid shape, wrong value
  // engine must close the connection itself (AUTH never matched); if the
  // AUTH ever verified, firstFrame resolves and the test must fail.
  await Promise.race([
    eng.firstFrame.then(() => { throw new Error('bad token verified — engine-side is broken'); }),
    new Promise((res, rej) => {
      const iv = setInterval(() => { if (eng.state.closedBad) { clearInterval(iv); res(); } }, 20);
      setTimeout(() => { clearInterval(iv); rej(new Error('engine never closed the bad-token conn')); }, 5000);
    }),
  ]);
  const to = setTimeout(() => p.child.kill(), 5000);
  const { code } = await p.exits; clearTimeout(to);
  assert.notEqual(code, 0);
  await eng.teardown();
});

test('stdin EOF before token: peer exits fail-closed and never connects', async (t) => {
  const eng = fakeEngine(t, crypto.randomBytes(32));
  await eng.ready;
  const p = spawnPeer(t, eng.sockPath);
  p.child.stdin.end();
  const { code } = await p.exits;
  assert.notEqual(code, 0);
  assert.equal(eng.state.conns, 0);
  await eng.teardown();
});

test('extra stdin bytes after the 32-byte token are ignored', async (t) => {
  const token = crypto.randomBytes(32);
  const eng = fakeEngine(t, token);
  await eng.ready;
  const p = spawnPeer(t, eng.sockPath);
  p.child.stdin.write(Buffer.concat([token, Buffer.from('trailing-junk')]));
  const f = await eng.firstFrame;
  assert.deepEqual(f.payload, token);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(p.child.exitCode, null); // still alive — extra bytes are not fatal
  p.child.kill(); await p.exits;
  await eng.teardown();
});

test('token timeout: stalled stdin is fatal, not a hang', async (t) => {
  const eng = fakeEngine(t, crypto.randomBytes(32));
  await eng.ready;
  const p = spawnPeer(t, eng.sockPath, ['--token-timeout-ms', '200']);
  const t0 = Date.now();
  const { code } = await p.exits;
  assert.notEqual(code, 0);
  assert.ok(Date.now() - t0 < 3000, 'exited promptly');
  assert.equal(eng.state.conns, 0);
  await eng.teardown();
});

test('usage errors exit 2 (missing --uds, unknown flags)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qnpeer-test-'));
  try {
    const a = spawn(process.execPath, [PEER], { stdio: 'pipe' });
    const ra = await new Promise((res) => a.once('exit', res));
    assert.equal(ra, 2);
    const b = spawn(process.execPath, [PEER, '--bogus', 'x'], { stdio: 'pipe' });
    const rb = await new Promise((res) => b.once('exit', res));
    assert.equal(rb, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runtime guard: current major passes, a wrong major refuses', () => {
  Q.assertRuntime(); // must not throw on the tested runtime
  assert.throws(() => Q.assertRuntime(99), /tested node 99\.x/);
});

test('dialAndAuth refuses a wrong-length token before touching the wire', async () => {
  await assert.rejects(Q.dialAndAuth('/nonexistent.sock', Buffer.alloc(4)), /bad token length/);
});

// ---- identity, persistence, redaction, and the plane A pump ----
// Security-critical daemon helpers, exercised directly (spec §3.4a,
// §5.2, §2.3).

function tmp0700(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qnpeer-id-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); // ours only
  return dir;
}

test('ensureIdentity: creates owner-only key files and refuses loose modes', (t) => {
  const dir = tmp0700(t);
  const k1 = Q.ensureIdentity(dir);
  assert.equal(k1.pub.length, 32);
  assert.equal(fs.statSync(path.join(dir, 'identity.key')).mode & 0o777, 0o600);
  const k2 = Q.ensureIdentity(dir);
  assert.deepEqual(k2.pub, k1.pub, 'identity stable across runs');
  const dir2 = tmp0700(t);
  Q.ensureIdentity(dir2);
  fs.chmodSync(path.join(dir2, 'identity.key'), 0o644);
  assert.throws(() => Q.ensureIdentity(dir2), /group\/other-accessible/);
  const dir3 = tmp0700(t);
  Q.ensureIdentity(dir3);
  fs.chmodSync(dir3, 0o755);
  assert.throws(() => Q.ensureIdentity(dir3), /group\/other-accessible/);
});

test('epoch store: persists monotonic values; absent or corrupt reads as none', (t) => {
  const dir = tmp0700(t);
  const es = Q.makeEpochStore(dir);
  assert.equal(es.load('aa', 'bb'), -1n);
  es.save('aa', 'bb', 41n);
  assert.equal(es.load('aa', 'bb'), 41n);
  assert.equal(es.load('ff', 'bb'), -1n, 'scoped per subject');
  fs.writeFileSync(path.join(dir, 'epoch-aa-cc.txt'), 'garbage');
  assert.equal(es.load('aa', 'cc'), -1n, 'corrupt never throws, never trusts');
});

test('redactor scrubs live join codes in raw-hex and display form', () => {
  const rd = Q.makeRedactor();
  const code = crypto.randomBytes(10);
  rd.register(code);
  const hexLine = 'saw ' + code.toString('hex') + ' end';
  const dispLine = 'saw ' + R.codeFromBytes(code) + ' end';
  assert.equal(rd.redact(hexLine), 'saw [redacted] end');
  assert.equal(rd.redact(dispLine), 'saw [redacted] end');
  rd.release(code);
  assert.equal(rd.redact(hexLine), hexLine, 'released codes stop masking unrelated text');
});

test('computeIdentity binds build_id and binary_sha to the parent image bytes (§3.4a)', () => {
  const gm = path.join(__dirname, '..', 'gamedata.sha256');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-idn-'));
  const img = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.from('QNBID:beef01.p0123456789abcdef'), Buffer.from([0]),
    Buffer.from('trailing')]);
  const imgFile = path.join(dir, 'engine');
  fs.writeFileSync(imgFile, img);
  try {
    const idn = Q.computeIdentity({ gamedataPath: gm, gamedir: 'id1', exePath: imgFile });
    assert.equal(idn.buildId.toString(), 'beef01.p0123456789abcdef');
    assert.deepEqual(idn.binarySha,
      crypto.createHash('sha256').update(img).digest(),
      'binary_sha binds to the bytes actually read through the fd');
    assert.deepEqual(idn.manifest,
      crypto.createHash('sha256').update(fs.readFileSync(gm)).digest());
    assert.equal(idn.gamedir.toString(), 'id1');
    assert.match(idn.platform.toString(), /^[a-z0-9]+-[a-z0-9_]+$/);
    // an image without the marker is a local fail-closed, never a silent join:
    assert.throws(() => Q.computeIdentity({ gamedataPath: gm, gamedir: 'id1',
      exePath: process.execPath }), /build marker/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); // our own temp dir only
  }
});

class FakeSock {
  constructor() { this.written = []; this.h = {}; }
  on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); }
  emit(ev, arg) { for (const fn of this.h[ev] || []) fn(arg); }
  write(b) { this.written.push(Buffer.from(b)); }
  destroy() { this.destroyed = true; }
}
const fixedClock = { now: () => 0, setTimeout: () => 1, clearTimeout: () => {} };

test('plane A pump: a throwing engine dispatch is a terminal cause, never a crash', () => {
  // The daemon's frame handler decodes TLV inline; a truncated payload must
  // arrive at the engine as a cause-bearing death, not an uncaught exception.
  const sock = new FakeSock();
  const fatals = [];
  new Q.PlaneA(sock, {
    clock: fixedClock,
    onFrame: (f) => new Map(F.decodeTLV(f.payload)), // exactly what handle() does
    onFatal: (w) => fatals.push(w),
  });
  sock.emit('data', F.encodeFrame(F.TYPES.HOST_UP, 1, Buffer.from([0x01, 0x00, 0x04, 0x65])));
  assert.deepEqual(fatals, ['plane-a-malformed']);
});

test('plane A pump: unknown types drop-count, close past the bound, and reset on clean input (§2.3)', () => {
  const sock = new FakeSock();
  const fatals = [];
  new Q.PlaneA(sock, { clock: fixedClock, onFrame: () => {}, onFatal: (w) => fatals.push(w) });
  for (let s = 1; s <= 11; s++) sock.emit('data', F.encodeFrame(0x7777, s, Buffer.alloc(0)));
  assert.deepEqual(fatals, ['plane-a-drop-storm']);
  const sock2 = new FakeSock();
  const fatals2 = [];
  new Q.PlaneA(sock2, { clock: fixedClock, onFrame: () => {}, onFatal: (w) => fatals2.push(w) });
  for (let s = 1; s <= 10; s++) sock2.emit('data', F.encodeFrame(0x7777, s, Buffer.alloc(0)));
  sock2.emit('data', F.encodeFrame(F.TYPES.PING, 11, Buffer.alloc(4, 7))); // resets the run
  assert.equal(sock2.written.length, 1, 'the clean frame was consumed with a PONG');
  for (let s = 12; s <= 21; s++) sock2.emit('data', F.encodeFrame(0x7777, s, Buffer.alloc(0)));
  assert.deepEqual(fatals2, [], 'two runs of ten, neither terminal');
});

test('plane A pump: PONG echoes the nonce and the sequence continues at 2 (§2.2)', () => {
  const sock = new FakeSock();
  const a = new Q.PlaneA(sock, { clock: fixedClock, onFrame: () => {}, onFatal: () => {} });
  sock.emit('data', F.encodeFrame(F.TYPES.PING, 1, Buffer.from([1, 2, 3, 4])));
  assert.equal(sock.written.length, 1);
  const f = F.decodeFrame(sock.written[0]).frame;
  assert.equal(f.type, F.TYPES.PONG);
  assert.equal(f.seq, 2, 'AUTH was seq 1; this direction never restarts');
  assert.equal(Buffer.compare(Buffer.from(f.payload), Buffer.from([1, 2, 3, 4])), 0);
  a.send(F.TYPES.PING, Buffer.alloc(4));
  assert.equal(sock.written.length, 2);
  assert.equal(F.decodeFrame(sock.written[1]).frame.seq, 3);
});

test('terminal decision owns the exit: malformed input then close cannot resolve clean', async () => {
  const sock = new FakeSock();
  const clock = { now: () => 0, setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) };
  const realExit = process.exit;
  process.exit = () => {}; // the terminal path ends in exit(1); stub so the runner lives
  try {
    let settled = 'pending';
    Q.run({
      sock, keys: { priv: null, pub: Buffer.alloc(32) },
      identity: { manifest: Buffer.alloc(32), gamedir: Buffer.from('id1'),
        buildId: Buffer.alloc(8, 0x61), platform: Buffer.from('linux-x64'),
        binarySha: Buffer.alloc(32) },
      name: Buffer.from('t'), pinned: null, clock, redactor: Q.makeRedactor(),
      epochs: { load: () => -1n, save: () => {} },
    }).then((c) => { settled = 'resolved:' + c; });
    sock.emit('data', F.encodeFrame(F.TYPES.HOST_UP, 1, Buffer.from([0x01, 0x00, 0x04, 0x65])));
    sock.emit('close'); // engine dies right after the garbage — the race
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(settled, 'pending', 'close after a terminal cause must not resolve a clean exit');
    const types = sock.written.map((b) => F.decodeFrame(b).frame.type);
    assert.ok(types.includes(F.TYPES.FATAL), 'the cause-bearing FATAL frame went out first');
  } finally {
    process.exit = realExit;
  }
});

test('no marker in the parent image: daemon exits fail-closed and never joins (§3.4a)', async () => {
  const child = spawn(process.execPath, [PEER, '--uds', '/nonexistent/qn.sock'],
    { stdio: ['pipe', 'pipe', 'pipe'] }); // parent is this node runtime: no marker
  const err = [];
  child.stderr.on('data', (c) => err.push(c));
  const { code } = await new Promise((res) =>
    child.once('exit', (c, s) => res({ code: c, sig: s })));
  assert.equal(code, 1);
  assert.match(Buffer.concat(err).toString('utf8'), /not joining/);
});

/* ---- blind-relay env contract (transport fallback) ---- */
const { spawnSync } = require('node:child_process');
const ROOT_DIR = path.join(__dirname, '..');
const peerRun = (env, code) => spawnSync(process.execPath, ['-e', code],
  { env: { ...process.env, ...env }, cwd: ROOT_DIR, encoding: 'utf8' });

test('QN_RELAY_THROUGH: valid keys yield the function form (hyperdht gates non-functions on dht.randomized)', () => {
  const r = peerRun({ QN_RELAY_THROUGH: 'aa'.repeat(32) + ',' + 'bb'.repeat(32) },
    `const q=require(${JSON.stringify(PEER)});
     const f=q.relayThroughFromEnv();
     if(typeof f!=='function')process.exit(7);
     const k=f(); if(!Array.isArray(k)||k.length!==2||!k.every(x=>x.length===32))process.exit(8);`);
  assert.equal(r.status, 0, r.stderr);
});

test('QN_RELAY_THROUGH malformed key exits 1, loudly', () => {
  const r = peerRun({ QN_RELAY_THROUGH: 'xyz' },
    `require(${JSON.stringify(PEER)}).relayThroughFromEnv();`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /QN_RELAY_THROUGH malformed/);
});

test('QN_RELAY_ONLY without a relay, or malformed, refuses to start', () => {
  const a = peerRun({ QN_RELAY_ONLY: '1' },
    `require(${JSON.stringify(PEER)}).relayThroughFromEnv();`);
  assert.equal(a.status, 1);
  assert.match(a.stderr, /QN_RELAY_ONLY requires QN_RELAY_THROUGH/);
  const b = peerRun({ QN_RELAY_ONLY: 'yes', QN_RELAY_THROUGH: 'aa'.repeat(32) },
    `require(${JSON.stringify(PEER)}).relayThroughFromEnv();`);
  assert.equal(b.status, 1);
  assert.match(b.stderr, /QN_RELAY_ONLY malformed/);
});

test('QN_RELAY_ONLY leaves NAT classification honest (no RANDOM pin)', () => {
  const r = peerRun({ QN_RELAY_THROUGH: 'aa'.repeat(32), QN_RELAY_ONLY: '1' },
    `const q=require(${JSON.stringify(PEER)});
     const f=q.relayThroughFromEnv();
     if(typeof f!=='function')process.exit(7);
     const Nat=require('hyperdht/lib/nat');
     if(Object.getOwnPropertyDescriptor(Nat.prototype,'firewall')!==undefined)process.exit(9);
     const { FIREWALL } = require('hyperdht/lib/constants');
     const n=new Nat({firewalled:false},{},null);
     if(n.firewall!==FIREWALL.OPEN)process.exit(10);`);
  assert.equal(r.status, 0, r.stderr);
});

test('no relay env: lane stays exactly as before (undefined, no pin)', () => {
  const r = peerRun({},
    `const q=require(${JSON.stringify(PEER)});
     if(q.relayThroughFromEnv()!==undefined)process.exit(7);
     const Nat=require('hyperdht/lib/nat');
     const { FIREWALL } = require('hyperdht/lib/constants');
     if(new Nat({firewalled:false},{},null).firewall!==FIREWALL.OPEN)process.exit(9);`);
  assert.equal(r.status, 0, r.stderr);
});

test('QN_RELAY_ONLY installs the direct-plane forcing, idempotently', () => {
  const r = peerRun({ QN_RELAY_THROUGH: 'aa'.repeat(32), QN_RELAY_ONLY: '1' },
    `const q=require(${JSON.stringify(PEER)});
     q.relayThroughFromEnv(); q.relayThroughFromEnv();
     const s=q.relayForcingState();
     if(!(s.applied&&s.remoteAddress&&s.punch&&s.addHandshake&&s.connect))process.exit(7);`);
  assert.equal(r.status, 0, r.stderr);
});

test('no relay env: the forcing stack stays untouched', () => {
  const r = peerRun({},
    `const q=require(${JSON.stringify(PEER)});
     if(q.relayThroughFromEnv()!==undefined)process.exit(7);
     const s=q.relayForcingState();
     if(s.applied||s.remoteAddress||s.punch||s.addHandshake||s.connect)process.exit(8);`);
  assert.equal(r.status, 0, r.stderr);
});
