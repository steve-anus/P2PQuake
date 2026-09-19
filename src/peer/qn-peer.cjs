'use strict';
// qn-peer: the p2pquake networking daemon (spec §4, Plane A client).
//
// The engine spawns this process, writes a 32-byte one-shot token raw to
// our stdin, and listens on its UDS. We read the token, dial the socket,
// and send AUTH{token} as our first frame. The token never appears in
// argv, the environment, logs, or any file, and no log line here
// echoes remote or secret bytes — messages are fixed strings only.
//
// This file covers the §4 handshake and runtime guards. The
// Plane A ↔ Plane B bridge, DHT lanes, per-stage timers, and the
// un-echoed join-code prompt land in follow-up changes. Nothing here
// accepts input from the network yet; nothing here touches the filesystem
// except connecting the socket.
//
// Exit codes: 0 clean (engine hung up after establishing), 1 failure
// (auth never completed / transport died pre-useful), 2 usage error.
const net = require('node:net');
const F = require('./qn_frame.cjs');

// The runtime this code is tested on. A drifted major is unsupported —
// refuse loudly rather than run on untested TLS/crypto semantics.
const NODE_MAJOR_TESTED = 24;
function assertRuntime(major = NODE_MAJOR_TESTED) {
  const m = Number(process.versions.node.split('.')[0]);
  if (m !== major) {
    throw new Error('qn-peer requires the tested node ' + major + '.x runtime, found ' + process.versions.node);
  }
}

// Exactly 32 bytes from stdin (the engine's token), fail-closed: early
// EOF or a stalled stdin past the timeout is fatal, never a retry — a
// half-read secret is a failure, not a warning. Extra bytes after the
// token are drained and ignored (the engine keeps the pipe open for
// teardown, writing nothing more).
function readToken(stdin, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const TOKEN_LEN = 32;
    const chunks = [];
    let have = 0;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('token did not arrive within timeout'));
    }, timeoutMs);
    const onData = (c) => {
      chunks.push(c);
      have += c.length;
      if (have < TOKEN_LEN) return;
      cleanup();
      const token = Buffer.concat(chunks, have).subarray(0, TOKEN_LEN);
      resolve(Buffer.from(token)); // copy: our buffers stay unreferenced
      stdin.resume();              // drain whatever the engine leaves open
    };
    const onEnd = () => { cleanup(); reject(new Error('stdin closed before the token completed')); };
    const cleanup = () => {
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', onEnd);
    };
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.resume();
  });
}

// Dial the engine's UDS and send AUTH as the first frame (seq 1 per the
// §2.1 per-direction sequence). Resolves with the live socket.
function dialAndAuth(udsPath, token) {
  if (!Buffer.isBuffer(token) || token.length !== 32) {
    return Promise.reject(new Error('internal: bad token length'));
  }
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: udsPath });
    sock.once('connect', () => {
      sock.write(F.encodeFrame(F.TYPES.AUTH, 1, token));
      resolve(sock);
    });
    sock.once('error', (e) => { sock.destroy(); reject(new Error('plane A connect failed: ' + e.code)); });
  });
}

function usageExit() {
  process.stderr.write('usage: qn-peer --uds <path> [--token-timeout-ms <n>]\n');
  return 2;
}

async function main(argv) {
  assertRuntime();
  let udsPath;
  let tokenTimeoutMs = 5000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--uds' && i + 1 < argv.length) udsPath = argv[++i];
    else if (a === '--token-timeout-ms' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 50 || n > 60000) return usageExit(); // flags are not secrets; validate anyway
      tokenTimeoutMs = n;
    } else return usageExit();
  }
  if (!udsPath) return usageExit();

  const token = await readToken(process.stdin, tokenTimeoutMs);
  const sock = await dialAndAuth(udsPath, token);
  process.stderr.write('qn-peer: plane A up, AUTH sent\n'); // fixed string — no bytes echoed
  return new Promise((resolve) => {
    let received = 0;
    sock.on('data', (c) => { received += c.length; });
    sock.on('close', () => {
      process.stderr.write('qn-peer: plane A closed, exiting\n');
      resolve(received > 0 ? 0 : 1); // died before the engine said anything useful
    });
    sock.on('error', () => sock.destroy());
  });
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch(() => {
    process.stderr.write('qn-peer: fatal, exiting fail-closed\n');
    process.exit(1);
  });
}

module.exports = { assertRuntime, readToken, dialAndAuth, usageExit, NODE_MAJOR_TESTED };
