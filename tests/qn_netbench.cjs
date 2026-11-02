'use strict';
// Network benchmark: two real qn-peer daemons (parented by bin/fake-engine)
// meet on a private hyperdht testnet; this process plays both engines and
// streams timestamped game datagrams both ways at the game's packet rate.
// Prints join time and one-way delivery latency percentiles as one JSON
// line. Link conditions come from the caller (tools/netbench.sh runs it
// inside a private network namespace with netem on loopback).
//
// Env: QN_BENCH_SECONDS (measured window, default 20), QN_BENCH_RATE
// (datagrams per second each way, default 72), QN_BENCH_SV_BYTES (host to
// client body, default 400), QN_BENCH_CL_BYTES (client to host, default
// 40), QN_BENCH_LABEL (copied into the output), QN_BENCH_RELAY=1 (both
// daemons forced through a blind relay node).
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const createTestnet = require('hyperdht/testnet');

const F = require('../src/peer/qn_frame.cjs');
const E = require('../src/peer/qn_envelope.cjs');
const { makeRelayNode } = require('../src/peer/qn-relay.cjs');

const ROOT = path.join(__dirname, '..');
const PEER = path.join(ROOT, 'src', 'peer', 'qn-peer.cjs');
const FAKE_ENGINE = path.join(ROOT, 'bin', 'fake-engine');
const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);
const SECONDS = num('QN_BENCH_SECONDS', 20);
const RATE = num('QN_BENCH_RATE', 72);
const SV_BYTES = num('QN_BENCH_SV_BYTES', 400);
const CL_BYTES = num('QN_BENCH_CL_BYTES', 40);
const WARMUP_MS = 2000;

const children = [];
const dirs = [];
function die(why) {
  console.log('NETBENCH FAIL ' + why);
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  process.exit(1);
}
process.on('exit', () => {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
});
function mkDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qnbench-'));
  fs.chmodSync(d, 0o700);
  dirs.push(d);
  return d;
}

class Engine {
  constructor(name) {
    this.name = name;
    this.dir = mkDir();
    this.sockPath = path.join(this.dir, 'e.sock');
    this.token = crypto.randomBytes(32);
    this.seq = 0;
    this.waiters = new Map();
    this.onData = null;
  }
  start() {
    return new Promise((resolve) => {
      this.server = net.createServer((conn) => {
        this.conn = conn;
        const reader = new F.FrameReader();
        let authed = false;
        conn.on('data', (c) => {
          let frames;
          try { frames = reader.feed(c); } catch { die(this.name + ': malformed plane A'); }
          for (const f of frames) {
            if (!authed) {
              if (f.type !== F.TYPES.AUTH || !f.payload.equals(this.token)) die(this.name + ': bad auth');
              authed = true;
              this.beat = setInterval(() => this.send(F.TYPES.PING, Buffer.alloc(4)), 1500);
              this.authed();
              continue;
            }
            if (f.type === F.TYPES.PING) { this.send(F.TYPES.PONG, f.payload); continue; }
            if ((f.type === F.TYPES.SV_DATA || f.type === F.TYPES.CL_DATA) && this.onData) {
              const t = new Map(F.decodeTLV(f.payload).map((x) => [x.tag, x.value]));
              this.onData(t.get(2));
              continue;
            }
            if (f.type === F.TYPES.FATAL) die(this.name + ': daemon FATAL cause ' + f.payload[0]);
            const w = this.waiters.get(f.type);
            if (w) { this.waiters.delete(f.type); w(f); }
          }
        });
        conn.on('error', () => {});
      });
      this.authedP = new Promise((r) => { this.authed = r; });
      this.server.listen(this.sockPath, resolve);
    });
  }
  send(type, payload = Buffer.alloc(0)) {
    this.seq++;
    this.conn.write(F.encodeFrame(type, this.seq, payload));
  }
  expect(type, ms = 60000) {
    return new Promise((res) => {
      const to = setTimeout(() => die(this.name + ': timeout on frame 0x' + type.toString(16)), ms);
      this.waiters.set(type, (f) => { clearTimeout(to); res(f); });
    });
  }
  stop() { clearInterval(this.beat); if (this.conn) this.conn.destroy(); this.server.close(); }
}

function spawnDaemon(engine, dir, boot, extraEnv) {
  const child = spawn(FAKE_ENGINE, ['--uds', engine.sockPath, '--dir', dir,
    '--gamedata', path.join(ROOT, 'gamedata.sha256'), '--gamedir', 'id1'], {
    env: { ...process.env, QN_FAKE_ENGINE_NODE: process.execPath,
      QN_FAKE_ENGINE_SCRIPT: PEER, QN_DHT_BOOTSTRAP: boot, ...extraEnv },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  children.push(child);
  const err = [];
  child.stderr.on('data', (c) => err.push(c.toString()));
  child.on('exit', (code) => { if (!finished) die(engine.name + ' daemon exited ' + code + ': ' + err.join('').slice(-400)); });
  child.stdin.write(engine.token);
  return child;
}

function timedBody(size, seq) {
  const b = Buffer.alloc(Math.max(16, size));
  b.writeBigUInt64LE(BigInt(seq), 0);
  b.writeBigUInt64LE(process.hrtime.bigint(), 8);
  return b;
}

function summary(samples, sent, recvSeqs) {
  const s = Float64Array.from(samples).sort();
  const at = (q) => (s.length ? Number(s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(2)) : null);
  let reordered = 0, last = -1;
  for (const q of recvSeqs) { if (q < last) reordered++; last = Math.max(last, q); }
  return { sent, received: recvSeqs.length, reordered, p50: at(0.5), p95: at(0.95), p99: at(0.99),
    max: s.length ? Number(s[s.length - 1].toFixed(2)) : null,
    over100: samples.filter((x) => x > 100).length, over250: samples.filter((x) => x > 250).length };
}

let finished = false;
async function main() {
  if (!fs.existsSync(FAKE_ENGINE)) die('missing bin/fake-engine (make fake-engine)');
  const hard = setTimeout(() => die('budget exhausted'), (SECONDS + 120) * 1000);
  hard.unref();
  const tnet = await createTestnet(3, { host: '127.0.0.1' });
  const boot = tnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(',');
  let relay = null;
  const extraEnv = {};
  if (process.env.QN_BENCH_RELAY === '1') {
    relay = await makeRelayNode({ bootstrap: tnet.bootstrap, port: 0 });
    extraEnv.QN_RELAY_THROUGH = relay.publicKey.toString('hex');
    extraEnv.QN_RELAY_ONLY = '1';
  }

  const hostSeed = crypto.randomBytes(32);
  const hostDir = mkDir();
  fs.writeFileSync(path.join(hostDir, 'identity.key'), hostSeed.toString('hex') + '\n', { mode: 0o600 });
  const hostPub = Buffer.from(E.publicRaw(E.publicKeyFromSeed(hostSeed)));
  const clientSeed = crypto.randomBytes(32);
  const clientDir = mkDir();
  fs.writeFileSync(path.join(clientDir, 'identity.key'), clientSeed.toString('hex') + '\n', { mode: 0o600 });
  const clientPub = Buffer.from(E.publicRaw(E.publicKeyFromSeed(clientSeed)));

  const host = new Engine('host');
  await host.start();
  spawnDaemon(host, hostDir, boot, extraEnv);
  await host.authedP;
  host.send(F.TYPES.HOST_UP, F.encodeTLV([[1, Buffer.from('lqdm1')], [2, Buffer.from('bench')], [3, Buffer.from([2])]]));
  const ready = await host.expect(F.TYPES.HOST_READY);
  const code = new Map(F.decodeTLV(ready.payload).map((x) => [x.tag, x.value])).get(1);

  const client = new Engine('client');
  await client.start();
  spawnDaemon(client, clientDir, boot, extraEnv);
  await client.authedP;
  const joinT0 = process.hrtime.bigint();
  client.send(F.TYPES.JOIN_PIN, F.encodeTLV([[1, hostPub]]));
  client.send(F.TYPES.JOIN_OPEN, code);
  await client.expect(F.TYPES.PEER_UP, 60000);
  const joinMs = Number(process.hrtime.bigint() - joinT0) / 1e6;

  const dirs2 = { sv: { samples: [], seqs: [], sent: 0 }, cl: { samples: [], seqs: [], sent: 0 } };
  let measuring = false;
  const recv = (d) => (body) => {
    if (!measuring || !body || body.length < 16) return;
    d.seqs.push(Number(body.readBigUInt64LE(0)));
    d.samples.push(Number(process.hrtime.bigint() - body.readBigUInt64LE(8)) / 1e6);
  };
  client.onData = recv(dirs2.sv);
  host.onData = recv(dirs2.cl);
  const period = 1000 / RATE;
  let seq = 0;
  const tick = setInterval(() => {
    seq++;
    if (measuring) { dirs2.sv.sent++; dirs2.cl.sent++; }
    host.send(F.TYPES.SV_DATA, F.encodeTLV([[1, clientPub], [2, timedBody(SV_BYTES, seq)]]));
    client.send(F.TYPES.CLIENT_CMD, F.encodeTLV([[1, timedBody(CL_BYTES, seq)]]));
  }, period);
  await new Promise((r) => setTimeout(r, WARMUP_MS));
  measuring = true;
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  measuring = false;
  clearInterval(tick);
  await new Promise((r) => setTimeout(r, 1500));

  finished = true;
  console.log('NETBENCH ' + JSON.stringify({
    label: process.env.QN_BENCH_LABEL || '', relay: !!relay, seconds: SECONDS, rate: RATE,
    relayStats: relay ? { pairings: relay.stats.pairings, streams: relay.stats.streams } : null,
    joinMs: Number(joinMs.toFixed(1)),
    hostToClient: summary(dirs2.sv.samples, dirs2.sv.sent, dirs2.sv.seqs),
    clientToHost: summary(dirs2.cl.samples, dirs2.cl.sent, dirs2.cl.seqs),
  }));
  host.stop(); client.stop();
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
  if (relay) await relay.close();
  await tnet.destroy();
  process.exit(0);
}

main().catch((e) => die(e.stack || String(e)));
