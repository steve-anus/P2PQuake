'use strict';
// qn-peer Plane A handshake tests (spec §4). The fake-engine server
// encodes the engine's side of §4 — AUTH must be the first frame, the
// token compares in constant time, mismatch or malformed closes the
// connection, and AUTH passes at most once. Child processes are the real
// qn-peer binary: this tests the daemon shape, not a re-implementation.
// Temp sockets live under a 0700 mkdtemp dir this test owns and cleans.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const F = require('./qn_frame.cjs');
const Q = require('./qn-peer.cjs');

const PEER = path.join(__dirname, 'qn-peer.cjs');

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

function spawnPeer(t, sockPath, extra = []) {
  const child = spawn(process.execPath, [PEER, '--uds', sockPath, ...extra],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
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
