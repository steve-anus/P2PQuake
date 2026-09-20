'use strict';
// qn-peer: the p2pquake networking daemon (spec §4, Plane A client).
//
// The engine spawns this process, writes a 32-byte one-shot token raw to
// our stdin, and listens on its UDS. We read the token, dial the socket,
// and send AUTH{token} as our first frame. The token never appears in
// argv, the environment, logs, or any file, and no log line here echoes
// remote or secret bytes — messages are fixed strings, plus locally derived
// integers.
//
// After AUTH the daemon owns both lanes (spec §4.1):
//   HOST_UP   → host lane: generate the join code, announce the topic,
//               answer HOST_READY once, run the room (qn_planeb.HostRoom).
//   JOIN_PIN? → client lane: an optional pinned host key from the invite,
//   JOIN_OPEN → then the join code: run qn_planeb.ClientRoom.
// Engine bytes cross to Plane B as RELAY bodies; verified remote bytes come
// back as SV_DATA / CL_DATA with daemon-filled sender tags. Join codes are
// secrets: they print nowhere except the HOST_READY payload for the engine's
// display surface, and every composed log line passes the redactor.
//
// Exit codes: 0 clean (engine hung up after establishing), 1 failure,
// 2 usage error.
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Hyperswarm = require('hyperswarm');

const F = require('./qn_frame.cjs');
const E = require('./qn_envelope.cjs');
const R = require('./qn_room.cjs');
const P = require('./qn_planeb.cjs');

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
  process.stderr.write('usage: qn-peer --uds <path> [--token-timeout-ms <n>] [--name <p>] '
    + '[--gamedata <path>] [--gamedir <d>] [--dir <state>]\n');
  return 2;
}

const shaBuf = (b) => crypto.createHash('sha256').update(b).digest();

// --- long-term identity (spec §5.2) ---
// One Ed25519 keypair per player, under a private state dir (0700), key
// file 0600. A key file readable by anyone else is refused, never used.
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
      const fd = fs.openSync(path.join(dir, `epoch-${subjectHex}-${matchHex}.txt`),
        'w', 0o600);
      try { fs.writeFileSync(fd, String(v) + '\n'); } finally { fs.closeSync(fd); }
    },
  };
}

// Asset & build identity (spec §3.4a), computed from bytes, never asserted.
// engine_id binds to the parent's running image by fd (hash-by-fd).
function computeIdentity({ gamedataPath, gamedir, ppid = process.ppid }) {
  const manifest = shaBuf(fs.readFileSync(gamedataPath));
  const fd = fs.openSync(`/proc/${ppid}/exe`, 'r');
  try {
    const h = crypto.createHash('sha256');
    const chunk = Buffer.alloc(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n <= 0) break;
      h.update(chunk.subarray(0, n));
    }
    return { manifest, gamedir: Buffer.from(gamedir), engineId: h.digest() };
  } finally { fs.closeSync(fd); }
}

// Join codes are secrets: any string we compose for the console passes
// through here, stripping both the raw-hex and display forms of every
// currently live code (belt and braces — lanes log fixed strings only).
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

// Plane A pump: per-direction sequence numbers, PING keepalives, and the
// unknown-type drop-storm rule (§2.2, §2.3, §6.5). AUTH already travelled
// as seq 1; everything else continues strictly upward.
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
      if (this.clock.now() - this.lastIn > 6000) { this.stop(); return this.onFatal('engine-dead'); }
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
  const announced = new Set(); // client side: members already surfaced to the engine

  const destroyLane = () => {
    if (!lane) return;
    const { swarm, room } = lane;
    lane = null;
    try { if (room && room.code) redactor.release(room.code); } catch { /* cosmetic */ }
    try { swarm.destroy(); } catch { /* best-effort teardown */ }
  };

  let exiting = false; // first terminal decision owns the exit, no racing resolvers
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
        return openHostLane(Buffer.from(map), Math.min(maxp[0], 8));
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
        if (body && body.length <= 1100) lane.room.relayToClients(Buffer.from(body));
        return;
      }
      default: // known but not dispatchable here (RELIABLE and friends): drop
        return;
    }
  };

  const openHostLane = async (map, maxPlayers) => {
    try {
      const code = R.randomJoinCode();
      redactor.register(code);
      const topic = R.topicOf(code);
      const room = new P.HostRoom({
        swarm: null, matchId: R.matchIdOf(code), code, keys: opts.keys,
        identity: opts.identity, map, maxPeers: maxPlayers,
        minVersion: { major: E.MAJOR, minor: E.MINOR },
        clock: opts.clock, log,
        epochStart: (() => { const v = opts.epochs.load('host', topic.toString('hex')); return v < 0n ? 0n : v; })(),
        epochSave: (v) => opts.epochs.save('host', topic.toString('hex'), v),
        cbs: {
          onPeerUp: (pub, name) => a.send(F.TYPES.PEER_UP,
            F.encodeTLV([[1, pub], [2, name]])),
          onPeerDown: (pub) => a.send(F.TYPES.PEER_DOWN,
            F.encodeTLV([[1, pub], [3, Buffer.from([0])]])),
          onClData: (from, body) => a.send(F.TYPES.CL_DATA,
            F.encodeTLV([[1, from], [2, body]])),
          onChat: () => log('host: chat received'),
          onEmpty: () => log('host: no peers'),
          onFatal: fatal,
        },
      });
      const swarm = new Hyperswarm({ firewall: (peerKey) => room.firewall(peerKey) });
      room.swarm = swarm;
      swarm.on('connection', (conn) => room.accept(conn));
      lane = { role: 'host', swarm, room };
      const disc = swarm.join(topic, { server: true, client: false });
      await disc.flushed(); // only then is the room reachable (and the code displayable)
      if (!lane || lane.swarm !== swarm) return; // torn down while flushing
      a.send(F.TYPES.HOST_READY, F.encodeTLV([[1, code]]));
      log('host: room open, code delivered to the engine display surface');
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
          onJoined: ({ hostKey }) => {
            log('client: joined');
            a.send(F.TYPES.PEER_UP, F.encodeTLV([[1, hostKey], [2, Buffer.from('host')]]));
          },
          onRefused: (cause) => { log('client: join refused, cause ' + cause); fatal(4); },
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
          onReplay: () => log('client: replay envelope dropped'),
          onRogueClosed: () => log('client: host-signed message off the host lane, connection closed'),
          onFatal: fatal,
        },
      });
      const swarm = new Hyperswarm();
      room.swarm = swarm;
      swarm.on('connection', (conn) => room.accept(conn));
      lane = { role: 'client', swarm, room };
      announced.clear(); // fresh lane, fresh membership view
      await swarm.join(topic, { server: false, client: true }).flushed();
      if (!lane || lane.swarm !== swarm) return;
      log('client: looking up the room');
    } catch (e) {
      log('client: lane open failed (' + e.name + ')');
      fatal(4);
    }
  };

  return new Promise((resolve) => {
    opts.sock.on('close', () => { if (!exiting) resolve(a.spoke ? 0 : 1); });
  });
}

// ---- CLI ----
function parseFlags(argv) {
  const o = { tokenTimeoutMs: 5000, name: 'player',
    gamedata: path.join(__dirname, '..', '..', 'gamedata.sha256'),
    gamedir: 'id1', dir: path.join(os.homedir(), '.p2pquake') };
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
  if (!/^[\x20-\x7e]{1,20}$/.test(o.name)) return null;      // display name: printable, bounded
  if (!/^[\x20-\x7e]{1,32}$/.test(o.gamedir)) return null;   // §3.4a gamedir contract
  return o;
}

async function main(argv) {
  assertRuntime();
  const o = parseFlags(argv);
  if (!o) return usageExit();
  const token = await readToken(process.stdin, o.tokenTimeoutMs);
  const sock = await dialAndAuth(o.uds, token);
  const keys = ensureIdentity(o.dir);
  const identity = computeIdentity({ gamedataPath: o.gamedata, gamedir: o.gamedir });
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
  assertRuntime, readToken, dialAndAuth, usageExit, NODE_MAJOR_TESTED,
  ensureIdentity, makeEpochStore, computeIdentity, makeRedactor, PlaneA, parseFlags, run,
};
