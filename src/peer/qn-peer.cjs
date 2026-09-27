#!/usr/bin/env node
'use strict';
// qn-peer: the p2pquake networking daemon (spec §4, Plane A client).
// Lanes (spec §4.1): HOST_UP -> qn_planeb.HostRoom; JOIN_PIN? then
// JOIN_OPEN -> qn_planeb.ClientRoom. Engine bytes cross Plane B as RELAY.
// Security posture: the one-shot 32-byte token arrives raw on stdin and
// never enters argv, env, logs, or files; log lines are fixed strings plus
// locally derived integers, all through the redactor; join codes print
// only in the HOST_READY payload (their one display surface).
// Exit codes: 0 clean, 1 failure, 2 usage error.
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Hyperswarm = require('hyperswarm');
const DHT = require('hyperdht');

const F = require('./qn_frame.cjs');
const E = require('./qn_envelope.cjs');
const R = require('./qn_room.cjs');
const P = require('./qn_planeb.cjs');
const D = require('./qn_lobbyd.cjs');

// The runtime this code is tested on. A drifted major is unsupported —
// refuse loudly rather than run on untested TLS/crypto semantics.
const NODE_MAJOR_TESTED = 24;

// QN_DHT_BOOTSTRAP: comma-separated host:port list replacing the public
// DHT entry points for BOTH plane-B roles; unset means public bootstrap.
// Malformed input refuses the lane loudly -- a silent fallback would make
// LAN-only runs test the public DHT without saying so. The bootstrap sees
// join-topic lookups only; topic secrecy is the same as the public case.
function dhtBootstrap() {
  const raw = (process.env.QN_DHT_BOOTSTRAP || '').trim();
  if (!raw) return undefined;
  const list = [];
  for (const part of raw.split(',')) {
    const m = /^([A-Za-z0-9._.\-:[\]]+):(\d{1,5})$/.exec(part.trim());
    const port = m ? Number(m[2]) : 0;
    if (!m || port < 1 || port > 65535) {
      process.stderr.write('qn-peer: QN_DHT_BOOTSTRAP malformed\n');
      process.exit(1);
    }
    let host = m[1];
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // dns.lookup rejects brackets
    list.push({ host, port });
  }
  return list;
}

// The DHT hyperswarm builds is ephemeral, and an ephemeral node fails
// hyperdht's firewall probe -- a firewalled node never stores an announce,
// so its rooms are invisible to lookups. A HOST lane therefore owns a
// non-ephemeral DHT explicitly. On an operator-named (flat) bootstrap the
// probe is overruled, as in hyperdht's own testnet; on public bootstraps
// detection stands and WAN reality is measured, not assumed.
// Named blind relays (transport fallback): QN_RELAY_THROUGH is a
// comma-separated list of relay DHT public keys (64-hex). The keys travel
// only inside each side's NOISE-ENCRYPTED handshake payload; a relay sees
// ciphertext and flow metadata, never contents, and cannot read or forge
// plane B (end-to-end Noise + envelope signatures). QN_RELAY_ONLY=1
// structurally disables the direct data plane (applyRelayForcing): a join
// either rides a named relay or fails closed. NAT-classification lies
// alone do NOT force it on a flat testnet: both sides truthfully observe
// a stable remote address and report OPEN from it (lib/server.js:281,378
// and lib/connect.js:434,441), so the forcing must kill the direct paths
// where they actually fire.
// relayThrough must be a FUNCTION: hyperswarm gates the non-function
// forms on dht.randomized (index.js:684-688) and a flat LAN is never
// "randomized" — only the function is consulted every time.
function relayThroughFromEnv() {
  const only = (process.env.QN_RELAY_ONLY || '').trim();
  if (only !== '' && only !== '1') {
    process.stderr.write('qn-peer: QN_RELAY_ONLY malformed (want 1)\n');
    process.exit(1);
  }
  const raw = (process.env.QN_RELAY_THROUGH || '').trim();
  if (!raw) {
    if (only === '1') { // relay-only without a relay dies silently: refuse
      process.stderr.write('qn-peer: QN_RELAY_ONLY requires QN_RELAY_THROUGH\n');
      process.exit(1);
    }
    return undefined;
  }
  const keys = [];
  for (const part of raw.split(',')) {
    const m = /^([0-9a-fA-F]{64})$/.exec(part.trim());
    if (!m) {
      process.stderr.write('qn-peer: QN_RELAY_THROUGH malformed (want 64-hex keys, comma-separated)\n');
      process.exit(1);
    }
    keys.push(Buffer.from(m[1], 'hex'));
  }
  if (only === '1') applyRelayForcing(keys);
  return () => keys; // hyperdht selectRelay random-picks arrays
}

// QN_RELAY_ONLY forcing: the direct data plane is disabled only where it
// can actually fire, and only for match peers — dials to the named
// relays stay fully direct (they carry the match, they must be dialable):
//  - remoteAddress() -> null makes the client's handshake report UNKNOWN
//    with no advertised self-address (lib/connect.js:434-445) and stops
//    the server serving OPEN from observation (lib/server.js:281,378),
//    which starves every direct shortcut that bypasses the relay branch;
//  - the server's OPEN/direct fast path returns BEFORE its relay branch
//    (lib/server.js:412 vs :419), so handshakes are treated as
//    relay-arrived (direct=false) — exactly what a relay-forwarded
//    handshake looks like in production;
//  - _punch is pinned to upstream's own "nothing to punch" shape (the
//    false early return in lib/holepuncher.js), mirroring the freeze
//    hyperdht's relaying tests use (test/relaying.js pausePunching);
//  - peer dials carry localConnection:false so the LAN ping shortcut
//    (lib/connect.js:84,251) cannot dial the peer either.
applyRelayForcing.sameKeys = (keys) => {
  const prev = applyRelayForcing.keys || [];
  return prev.length === keys.length && prev.every((k, i) => k.equals(keys[i]));
};

function applyRelayForcing(keys) {
  if (applyRelayForcing.applied) {
    // The daemon's env is static: different keys on a second call are
    // caller misuse -- refuse rather than keep a wrapper bound to the
    // first caller's relays.
    if (!applyRelayForcing.sameKeys(keys)) {
      throw new Error('qn-peer: relay forcing already applied with different keys');
    }
    return;
  }
  applyRelayForcing.applied = true;
  applyRelayForcing.keys = keys;
  const Holepuncher = require('hyperdht/lib/holepuncher');
  const Server = require('hyperdht/lib/server');
  // No NAT-classification pin: a fabricated RANDOM aborts the punch
  // (HOLEPUNCH_DOUBLE_RANDOMIZED_NATS) before relay pairing completes;
  // the levers below suffice, so classification stays honest.
  DHT.prototype.remoteAddress = function remoteAddress() { return null; };
  Holepuncher.prototype._punch = function _punch() { return Promise.resolve(false); };
  const origAdd = Server.prototype._addHandshake;
  Server.prototype._addHandshake = function _addHandshake(k, noise, clientAddress, req, direct) {
    return origAdd.call(this, k, noise, clientAddress, req, false);
  };
  const isRelayKey = (pk) => { // hot dial path: never throw out of the wrapper,
    if (!pk || typeof pk.equals !== 'function') return false; // and fail toward forcing
    try { return keys.some((k) => k.equals(pk)); } catch { return false; }
  };
  const origConnect = DHT.prototype.connect;
  DHT.prototype.connect = function connect(publicKey, opts) {
    if (isRelayKey(publicKey)) return origConnect.call(this, publicKey, opts);
    return origConnect.call(this, publicKey, { ...opts, localConnection: false });
  };
  DHT.prototype.remoteAddress._qnForced = true;
  Holepuncher.prototype._punch._qnForced = true;
  Server.prototype._addHandshake._qnForced = true;
  DHT.prototype.connect._qnForced = true;
}

function relayForcingState() {
  const Holepuncher = require('hyperdht/lib/holepuncher');
  const Server = require('hyperdht/lib/server');
  return {
    applied: applyRelayForcing.applied === true,
    remoteAddress: DHT.prototype.remoteAddress._qnForced === true,
    punch: Holepuncher.prototype._punch._qnForced === true,
    addHandshake: Server.prototype._addHandshake._qnForced === true,
    connect: DHT.prototype.connect._qnForced === true
  };
}

function makeSwarm(extra) {
  const relayThrough = relayThroughFromEnv();
  const opts = relayThrough ? { ...extra, relayThrough } : extra;
  const bootstrap = dhtBootstrap();
  if (!bootstrap) return new Hyperswarm(opts);
  // A loopback bootstrap is hyperdht's own testnet case: bind loopback
  // too, or the node announces an undialable address and joins die with
  // zero attempts. Outside this opt-in the public path stays as
  // hyperswarm configures it (firewall detection included).
  const loopback = bootstrap.every((b) =>
    /^127\.|^::1$|^\[::1\]$/.test(b.host));
  const dht = new DHT({
    bootstrap,
    ephemeral: false,
    firewalled: false,
    ...(loopback ? { host: '127.0.0.1' } : {})
  });
  return new Hyperswarm({ dht, ...opts });
}
function assertRuntime(major = NODE_MAJOR_TESTED) {
  const m = Number(process.versions.node.split('.')[0]);
  if (m !== major) {
    throw new Error('qn-peer requires the tested node ' + major + '.x runtime, found ' + process.versions.node);
  }
}

// Exactly 32 bytes from stdin (the engine's token), fail-closed: early
// EOF or timeout is fatal, never a retry — a half-read secret is a
// failure. Extra bytes are drained (the engine keeps the pipe open).
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
    const onErr = () => { cleanup(); reject(new Error('stdin error before the token completed')); };
    const cleanup = () => {
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onErr);
    };
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onErr);
    stdin.resume();
  });
}

// Dial the engine's UDS; AUTH{token} is the first frame (seq 1, §2.1).
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
  process.stderr.write('usage: qn-peer --uds <path> [--token-timeout-ms <n>] [--name <p>] '
    + '[--gamedata <path>] [--gamedir <d>] [--dir <state>]\n');
  return 2;
}

const shaBuf = (b) => crypto.createHash('sha256').update(b).digest();

// --- long-term identity (spec §5.2) ---
// State dir 0700, key file 0600; a key file readable by anyone else is
// refused, never used.
function ensureIdentity(dir) {
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  const st = fs.statSync(dir);
  if ((st.mode & 0o077) !== 0) throw new Error('state dir is group/other-accessible');
  const keyPath = path.join(dir, 'identity.key');
  let seed;
  try {
    const raw = fs.readFileSync(keyPath);
    seed = Buffer.from(raw.toString('utf8').trim(), 'hex');
    if (seed.length !== 32) throw new Error('identity.key malformed');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    seed = crypto.randomBytes(32);
    const fd = fs.openSync(keyPath, 'wx', 0o600); // fail if raced into existence
    try { fs.writeFileSync(fd, seed.toString('hex') + '\n'); }
    finally { fs.closeSync(fd); }
  }
  const mode = fs.statSync(keyPath).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error('identity.key is group/other-accessible');
  const priv = E.privateKeyFromSeed(seed);
  return { priv, pub: Buffer.from(E.publicRaw(E.publicKeyFromSeed(seed))) };
}

// Per-(subject, match) monotonic roster epoch store, so a reused topic never
// restarts a counter at zero (spec §3.4a).
function makeEpochStore(dir) {
  return {
    load(subjectHex, matchHex) {
      try {
        const v = BigInt(fs.readFileSync(path.join(dir, `epoch-${subjectHex}-${matchHex}.txt`), 'utf8').trim());
        return v > 0n || v === 0n ? v : -1n;
      } catch { return -1n; }
    },
    save(subjectHex, matchHex, v) {
      const f = path.join(dir, `epoch-${subjectHex}-${matchHex}.txt`);
      const fd = fs.openSync(f + '.tmp', 'w', 0o600);
      try {
        fs.writeFileSync(fd, String(v) + '\n');
        fs.fsyncSync(fd);                            // durable before the visible swap
      } finally { fs.closeSync(fd); }
      fs.renameSync(f + '.tmp', f);                      // lost write leaves the old value
    },
  };
}

const BUILD_ID_MAGIC = Buffer.from('QNBID:', 'utf8');
const BUILD_ID_RE = /^[A-Za-z0-9._+-]{1,64}$/;
function extractBuildId(image) {
  const at = image.lastIndexOf(BUILD_ID_MAGIC);
  if (at < 0) return null;
  let end = image.indexOf(0, at + BUILD_ID_MAGIC.length);
  if (end < 0) end = image.length;
  const s = image.subarray(at + BUILD_ID_MAGIC.length, end).toString('latin1');
  return BUILD_ID_RE.test(s) ? Buffer.from(s, 'utf8') : null;
}

function computeIdentity({ gamedataPath, gamedir, ppid = process.ppid,
  exePath = undefined }) {
  const manifest = shaBuf(fs.readFileSync(gamedataPath));
  const fd = fs.openSync(exePath ?? `/proc/${ppid}/exe`, 'r');
  const parts = [];
  try {
    const chunk = Buffer.alloc(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n <= 0) break;
      parts.push(Buffer.from(chunk.subarray(0, n)));
    }
  } finally { fs.closeSync(fd); }
  const image = Buffer.concat(parts);
  const buildId = extractBuildId(image);
  if (!buildId) throw new Error('no engine build marker in parent image (§3.4a)');
  return { manifest, gamedir: Buffer.from(gamedir), buildId,
    platform: Buffer.from(`${process.platform}-${process.arch}`, 'utf8'),
    binarySha: shaBuf(image) };
}

// Join codes are secrets: composed console strings pass through here,
// stripping the raw-hex and display forms of every live code.
function makeRedactor() {
  const live = new Set();
  return {
    register(codeBytes) {
      live.add(codeBytes.toString('hex'));
      live.add(R.codeFromBytes(codeBytes));
    },
    release(codeBytes) {
      live.delete(codeBytes.toString('hex'));
      live.delete(R.codeFromBytes(codeBytes));
    },
    redact(s) {
      let out = String(s);
      for (const form of live) out = out.split(form).join('[redacted]');
      return out;
    },
  };
}

// Plane A pump: seq per direction, PING keepalives, unknown-type
// drop-storm (§2.2, §2.3, §6.5). AUTH took seq 1; upward only.
class PlaneA {
  constructor(sock, { clock = P.realClock, onFrame, onFatal }) {
    this.sock = sock;
    this.clock = clock;
    this.onFrame = onFrame;
    this.onFatal = onFatal;
    this.reader = new F.FrameReader();
    this.spoke = false; // engine sent at least one frame
    this.unknownRun = 0;
    this.lastIn = clock.now();
    this.seqPeer = 2; // AUTH travelled as seq 1; this direction never restarts (§2.2)
    this.timers = [];
    this.known = new Set(Object.values(F.TYPES));
    this.closed = false;
    sock.on('data', (c) => this.feed(c));
    sock.on('close', () => { if (!this.closed) { this.closed = true; this.stop(); onFatal('plane-a-close'); } });
    sock.on('error', () => {});
    this.schedulePing();
  }
  feed(chunk) {
    let frames;
    try { frames = this.reader.feed(chunk); }
    catch (e) { return this.onFatal('plane-a-malformed'); }
    for (const f of frames) {
      try {
        this.lastIn = this.clock.now();
        this.spoke = true;
        if (!this.known.has(f.type)) {
          if (++this.unknownRun > 10) return this.onFatal('plane-a-drop-storm');
          continue; // §2.3: drop and count
        }
        this.unknownRun = 0;
        if (f.type === F.TYPES.PING) { this.send(F.TYPES.PONG, f.payload); continue; }
        if (f.type === F.TYPES.PONG) continue; // keeps lastIn fresh
        this.onFrame(f);
      } catch { return this.onFatal('plane-a-malformed'); } // terminal cause, never a crash
    }
  }
  send(type, payload = Buffer.alloc(0)) {
    if (this.closed) return;
    const seq = this.seqPeer++;
    this.sock.write(F.encodeFrame(type, seq, payload));
  }
  schedulePing() {
    this.pingTimer = this.clock.setTimeout(() => {
      if (this.closed) return;
      // A hung engine (long map load) is the only case this catches;
      // a dead one closes the plane-A socket and dies via EOF instantly.
      if (this.clock.now() - this.lastIn > 30000) { this.stop(); return this.onFatal('engine-dead'); }
      const n = Buffer.alloc(4); n.writeUInt32LE((this.clock.now() >>> 0), 0);
      this.send(F.TYPES.PING, n);
      this.schedulePing();
    }, 2000);
  }
  stop() { for (const t of [this.pingTimer]) this.clock.clearTimeout(t); }
}

// ---- the daemon ----
async function run(opts) {
  const { redactor } = opts;
  const log = (s) => process.stderr.write('qn-peer: ' + redactor.redact(s) + '\n');
  let lane = null; // {role, swarm, room}
  let hostLobby = null, viewerLobby = null;
  const announced = new Set(); // client side: members already surfaced to the engine

  const destroyLane = () => {
    if (!lane) return;
    const { swarm, room } = lane;
    const role = lane.role;
    lane = null;
    if (hostLobby) { try { hostLobby.onWithdraw(); } catch { /* best-effort */ } }
    if (role === 'client' && room) room.closing = true; // intentional
    try { if (room) room.clock.clearTimeout(room.joinDeadlineTimer); } catch { /* cosmetic */ }
    try { if (room && room.code) redactor.release(room.code); } catch { /* cosmetic */ }
    try { swarm.destroy(); } catch { /* best-effort teardown */ }
  };

  let exiting = false; // first terminal decision owns the exit, no racing resolvers
  let joinedOnce = false; // refusals before the first join are expected outcomes
  const fatal = (cause) => {
    if (exiting) return;
    exiting = true;
    a.send(F.TYPES.FATAL, Buffer.from([cause]));
    destroyLane();
    a.stop();
    setTimeout(() => process.exit(1), 20); // flush the FATAL frame
  };

  const a = new PlaneA(opts.sock, {
    clock: opts.clock,
    onFatal: (why) => {
      if (exiting) return;
      exiting = true;
      log(why);
      // §2.3/§6.3: malformed and drop-storm deaths must reach the engine as a
      // FATAL frame with a cause, and never masquerade as a clean hangup.
      const report = why === 'plane-a-malformed' || why === 'plane-a-drop-storm';
      destroyLane();
      a.stop();
      if (report) { try { a.send(F.TYPES.FATAL, Buffer.from([2])); } catch { /* gone */ } }
      setTimeout(() => process.exit(report || why === 'engine-dead' ? 1 : (a.spoke ? 0 : 1)), 20);
    },
    onFrame: (f) => handle(f),
  });

  const lobbySwarm = (topic, { server }) => {
    const s = makeSwarm();
    s.on('error', () => {});
    s.join(topic, { server, client: !server });
    return s;
  };
  const hostLobbyEnsure = () => {
    if (!hostLobby) hostLobby = D.makeHostLobby({
      keys: opts.keys, epochs: opts.epochs, clock: opts.clock,
      swarmFactory: lobbySwarm,
      version: [E.MAJOR, E.MINOR], minVersion: [E.MAJOR, E.MINOR],
      getCode: () => (lane && lane.role === 'host' && lane.room ? lane.room.code : null),
      log,
    });
    return hostLobby;
  };
  const viewerLobbyEnsure = () => {
    if (!viewerLobby) viewerLobby = D.makeViewerLobby({
      clock: opts.clock, swarmFactory: lobbySwarm,
      send: (type, payload) => a.send(type, payload),
      log,
    });
    return viewerLobby;
  };

  const handle = (f) => {
    switch (f.type) {
      case F.TYPES.HOST_UP: {
        if (lane) return fatal(2); // second lane opener while one is live (§4.1)
        const t1 = new Map(F.decodeTLV(f.payload).map((x) => [x.tag, x.value]));
        const map = t1.get(1), hostname = t1.get(2), maxp = t1.get(3);
        const okTags = map && map.length >= 1 && map.length <= 16 &&
          hostname && hostname.length >= 1 && hostname.length <= 20 &&
          maxp && maxp.length === 1;
        if (!okTags) return fatal(2);
        for (const b of map) if (b < 0x20 || b > 0x7e) return fatal(2);
        for (const b of hostname) if (b < 0x20 || b > 0x7e) return fatal(2);
        return openHostLane(Buffer.from(map), P.roomSeats(maxp[0]));
      }
      case F.TYPES.HOST_DOWN:
        if (lane && lane.role === 'host') destroyLane();
        return;
      case F.TYPES.JOIN_PIN: {
        if (lane || opts.pinned || f.payload.length === 0) return fatal(2);
        const t1 = new Map(F.decodeTLV(f.payload).map((x) => [x.tag, x.value]));
        const pk = t1.get(1);
        if (!pk || pk.length !== 32 || t1.size !== 1) return fatal(2);
        opts.pinned = Buffer.from(pk);
        return;
      }
      case F.TYPES.JOIN_OPEN: {
        if (lane) return fatal(2);
        if (f.payload.length !== 10) return fatal(2);
        return openClientLane(Buffer.from(f.payload));
      }
      case F.TYPES.JOIN_CLOSE:
        if (lane && lane.role === 'client') destroyLane();
        return;
      case F.TYPES.LOBBY_ANNOUNCE: {
        if (!lane || lane.role !== 'host') { log('lobby: announce without host lane, dropped'); return; }
        try { hostLobbyEnsure().onAnnounce(f.payload); }
        catch { log('lobby: malformed announce, dropped'); }
        return;
      }
      case F.TYPES.LOBBY_WITHDRAW:
        if (f.payload.length !== 0) { log('lobby: malformed control frame, dropped'); return; }
        if (hostLobby) hostLobby.onWithdraw();
        return;
      case F.TYPES.LOBBY_WATCH:
        if (f.payload.length !== 0) { log('lobby: malformed control frame, dropped'); return; }
        try { viewerLobbyEnsure().start(); }
        catch { log('lobby: watch failed'); }
        return;
      case F.TYPES.LOBBY_UNWATCH:
        if (f.payload.length !== 0) { log('lobby: malformed control frame, dropped'); return; }
        if (viewerLobby) viewerLobby.stop();
        return;
      case F.TYPES.CLIENT_CMD: {
        if (!lane || lane.role !== 'client') return; // known type, no lane: drop
        const t1 = new Map(F.decodeTLV(f.payload).map((x) => [x.tag, x.value]));
        const body = t1.get(1);
        if (body && body.length <= 1100) lane.room.sendClientCmd(Buffer.from(body));
        return;
      }
      case F.TYPES.SV_DATA: {
        if (!lane || lane.role !== 'host') return; // host engine server output → relay
        const t1 = new Map(F.decodeTLV(f.payload).map((x) => [x.tag, x.value]));
        const body = t1.get(2);
        const target = t1.get(1);
        // Untargeted server output is a contract violation: fan-out to the
        // whole room would poison every non-recipient's datagram window.
        if (!body || body.length < 1 || body.length > 1100 || !target || target.length !== 32) return;
        lane.room.relayToClients(Buffer.from(body), Buffer.from(target));
        return;
      }
      default: // known but not dispatchable here (RELIABLE and friends): drop
        return;
    }
  };

  const openHostLane = async (map, seats) => {
    try {
      const code = R.randomJoinCode();
      redactor.register(code);
      const topic = R.topicOf(code);
      const memberShas = new Map(); // binary_sha per member: log-only watch
      const room = new P.HostRoom({
        swarm: null, matchId: R.matchIdOf(code), code, keys: opts.keys,
        identity: opts.identity, map, maxPeers: seats,
        minVersion: { major: E.MAJOR, minor: E.MINOR },
        clock: opts.clock, log,
        epochStart: (() => { const v = opts.epochs.load('host', topic.toString('hex')); return v < 0n ? 0n : v; })(),
        epochSave: (v) => opts.epochs.save('host', topic.toString('hex'), v),
        cbs: {
          onPeerUp: (pub, name, info) => {
            if (info) {
              const sh = info.binarySha.toString('hex');
              log('host: member ' + pub.subarray(0, 4).toString('hex')
                + ' platform='
                + (P.isPrintable(info.platform) ? info.platform.toString('latin1') : '<invalid>')
                + ' binary_sha=' + sh);
              for (const v of memberShas.values()) {
                if (v !== sh) {
                  log('host: member binary_sha divergence (diagnostic only)');
                  break;
                }
              }
              memberShas.set(pub.toString('hex'), sh);
            }
            a.send(F.TYPES.PEER_UP, F.encodeTLV([[1, pub], [2, name]]));
          },
          onPeerDown: (pub) => {
            memberShas.delete(pub.toString('hex'));
            a.send(F.TYPES.PEER_DOWN, F.encodeTLV([[1, pub], [3, Buffer.from([0])]]));
          },
          onClData: (from, body) => a.send(F.TYPES.CL_DATA,
            F.encodeTLV([[1, from], [2, body]])),
          onChat: () => log('host: chat received'),
          onEmpty: () => log('host: no peers'),
          onFatal: fatal,
        },
      });
      const swarm = makeSwarm({ firewall: (peerKey) => room.firewall(peerKey) });
      room.swarm = swarm;
      swarm.on('connection', (conn) => room.accept(conn));
      // Invariant: the engine sends the first LOBBY_ANNOUNCE in the same
      // pump tick as HOST_UP; lane (and room.code) must be set before the
      // first await or that announce falls through the host-role gate.
      lane = { role: 'host', swarm, room };
      const disc = swarm.join(topic, { server: true, client: false });
      await disc.flushed(); // only then is the room reachable (and the code displayable)
      if (!lane || lane.swarm !== swarm) return; // torn down while flushing
      a.send(F.TYPES.HOST_READY, F.encodeTLV([[1, code]]));
      log('host: room open maxpeers=' + seats
        + ', code delivered to the engine display surface');
    } catch (e) {
      log('host: room open failed (' + e.name + ')');
      fatal(4);
    }
  };

  const openClientLane = async (code) => {
    try {
      redactor.register(code);
      const topic = R.topicOf(code);
      const room = new P.ClientRoom({
        swarm: null, matchId: R.matchIdOf(code), code, keys: opts.keys,
        identity: opts.identity, name: opts.name, pinned: opts.pinned,
        clock: opts.clock, log,
        epochStart: opts.pinned
          ? opts.epochs.load(opts.pinned.toString('hex'), topic.toString('hex'))
          : -1n,
        epochSave: (v) => opts.pinned && opts.epochs.save(opts.pinned.toString('hex'), topic.toString('hex'), v),
        cbs: {
          onJoined: ({ hostKey, hostPlatform, hostBinarySha }) => {
            joinedOnce = true;
            log('client: host build platform='
              + (P.isPrintable(hostPlatform) ? hostPlatform.toString('latin1') : '<invalid>')
              + ' binary_sha=' + hostBinarySha.toString('hex'));
            log('client: joined');
            a.send(F.TYPES.PEER_UP, F.encodeTLV([[1, hostKey], [2, Buffer.from('host')]]));
          },
          onRefused: (cause) => {
            log('client: join refused, cause ' + cause);
            // A pre-join refusal (stale code) hangs up clean, exactly as
            // if the engine had hung up first; mid-match refusals are fatal.
            if (!joinedOnce) {
              if (exiting) return;
              exiting = true;
              // relay the reason to the player before the hangup (§6.2):
              try { a.send(F.TYPES.JOIN_NO, Buffer.from([cause])); } catch { /* gone */ }
              destroyLane();
              a.stop();
              setTimeout(() => process.exit(0), 20);
              return;
            }
            fatal(4);
          },
          onRoster: (members) => {
            // Membership reaches the engine as deltas: refresh broadcasts must
            // not re-announce, and departures must not stay silently present.
            const self = opts.keys.pub.toString('hex');
            const cur = new Set(members.map((m) => m.toString('hex')));
            cur.add(self); // the local identity is never a remote peer, up or down
            for (const m of members) {
              const hex = m.toString('hex');
              if (hex === self || announced.has(hex)) continue;
              announced.add(hex);
              a.send(F.TYPES.PEER_UP, F.encodeTLV([[1, m], [2, Buffer.from(hex.slice(0, 12))]]));
            }
            for (const hex of announced) {
              if (cur.has(hex)) continue;
              announced.delete(hex);
              a.send(F.TYPES.PEER_DOWN,
                F.encodeTLV([[1, Buffer.from(hex, 'hex')], [3, Buffer.from([0])]]));
            }
            log('client: roster v' + members.length);
          },
          onSvData: (origin, body) => a.send(F.TYPES.SV_DATA,
            F.encodeTLV([[1, origin], [2, body]])),
          onChat: () => log('client: chat received'),
          onBye: () => log('client: bye from host'),
          onHostLaneLost: () => { log('client: host connection lost'); fatal(4); },
          onJoinFailed: () => {
            // no host ever surfaced for this code: hang up clean exactly as
            // a pre-join refusal does -- the relayed cause is the verdict
            if (exiting) return;
            exiting = true;
            log('client: no host found for this code');
            try { a.send(F.TYPES.JOIN_NO, Buffer.from([2])); } catch { /* gone */ }
            destroyLane();
            a.stop();
            setTimeout(() => process.exit(0), 20);
          },
          onReplay: () => log('client: replay envelope dropped'),
          onRogueClosed: () => log('client: host-signed message off the host lane, connection closed'),
          onFatal: fatal,
        },
      });
        const swarm = makeSwarm();
      room.swarm = swarm;
      swarm.on('connection', (conn) => room.accept(conn));
      lane = { role: 'client', swarm, room };
      announced.clear(); // fresh lane, fresh membership view
      await swarm.join(topic, { server: false, client: true }).flushed();
      if (!lane || lane.swarm !== swarm) return;
      log('client: looking up the room');
    } catch (e) {
      log('client: lane open failed (' + e.name + ')');
      // an unresolvable topic is overwhelmingly a wrong or stale code (§6.2/2);
      // hang up clean so the engine is not left respawning a doomed daemon
      if (exiting) return;
      exiting = true;
      try { a.send(F.TYPES.JOIN_NO, Buffer.from([2])); } catch { /* gone */ }
      destroyLane();
      a.stop();
      setTimeout(() => process.exit(0), 20);
    }
  };

  return new Promise((resolve) => {
    opts.sock.on('close', () => { if (!exiting) resolve(a.spoke ? 0 : 1); });
  });
}

// ---- CLI ----
// Durable state default (identity key, epochs): $XDG_STATE_HOME/p2pquake,
// else ~/.p2pquake, with a per-instance subdir tagged by the socket dir so
// same-box engines never share an identity (the engine derives the same
// tag from its -qn-dir; the hash must match net_qn.c qn_fnv1a byte-for-
// byte — it hashes the UTF-8 bytes of the absolute socket dir).
function qnFnv1aHex(s) {
  let h = 0x811c9dc5;
  const buf = Buffer.from(s, 'utf8');
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
function defaultStateDir(uds) {
  const xdg = process.env.XDG_STATE_HOME;
  const abs = path.resolve(uds);
  const sockDir = path.dirname(abs);
  let root;
  if (typeof xdg === 'string' && xdg.startsWith('/')) {
    root = path.join(xdg, 'p2pquake');
  } else if (typeof process.env.HOME === 'string' && process.env.HOME.startsWith('/')) {
    root = path.join(process.env.HOME, '.p2pquake');
  } else {
    /* mirror the engine's exotic-env collapse into the socket dir;
     * os.homedir() must NOT be consulted here: it can answer from the
     * passwd entry where the engine sees no usable HOME (spec 5.2) */
    root = sockDir;
  }
  return path.join(root, qnFnv1aHex(sockDir));
}
function parseFlags(argv) {
  const o = { tokenTimeoutMs: 5000, name: 'player',
    gamedata: path.join(__dirname, '..', '..', 'gamedata.sha256'),
    gamedir: 'id1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : null);
    if (a === '--uds') o.uds = next();
    else if (a === '--token-timeout-ms') {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 50 || n > 60000) return null; // flags are not secrets; validate anyway
      o.tokenTimeoutMs = n;
    }
    else if (a === '--name') o.name = next();
    else if (a === '--gamedata') o.gamedata = next();
    else if (a === '--gamedir') o.gamedir = next();
    else if (a === '--dir') o.dir = next();
    else return null;
  }
  if (!o.uds) return null;
  if (o.dir === undefined) o.dir = defaultStateDir(o.uds);
  /* an explicit empty --dir would authenticate first and die only at
   * key load: refuse it at the flag gate */
  if (typeof o.gamedata !== 'string' || typeof o.dir !== 'string'
      || o.dir.length === 0)
    return null;                                   // fs args: strings only, no coercion
  if (typeof o.name !== 'string' ||
      !/^[\x20-\x7e]{1,20}$/.test(o.name)) return null;      // display name: printable, bounded
  if (typeof o.gamedir !== 'string' ||
      !/^[\x20-\x7e]{1,32}$/.test(o.gamedir)) return null;   // §3.4a gamedir contract
  return o;
}

async function main(argv) {
  assertRuntime();
  const o = parseFlags(argv);
  if (!o) return usageExit();
  let identity;
  try {
    identity = computeIdentity({ gamedataPath: o.gamedata, gamedir: o.gamedir });
  } catch {
    process.stderr.write('qn-peer: no engine build marker in parent image; not joining (\u00a73.4a)\n');
    throw new Error('local identity');
  }
  const token = await readToken(process.stdin, o.tokenTimeoutMs);
  const sock = await dialAndAuth(o.uds, token);
  const keys = ensureIdentity(o.dir);
  const redactor = makeRedactor();
  const epochs = makeEpochStore(o.dir);
  return run({ sock, keys, identity, name: Buffer.from(o.name), pinned: null,
    clock: P.realClock, redactor, epochs });
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch(() => {
    process.stderr.write('qn-peer: fatal, exiting fail-closed\n');
    process.exit(1);
  });
}

module.exports = {
  qnFnv1aHex, defaultStateDir,
  assertRuntime, readToken, dialAndAuth, usageExit, NODE_MAJOR_TESTED,
  ensureIdentity, makeEpochStore, computeIdentity, extractBuildId, makeRedactor,
  PlaneA, parseFlags, run,
  relayThroughFromEnv, applyRelayForcing, relayForcingState,
};
