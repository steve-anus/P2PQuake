'use strict';
// Two machines compressed onto one: two real qn-peer daemons (spawned
// binaries, Plane A clients) bridged by fake engines over owned UDS
// sockets, meeting over the live DHT. Covers the whole join path —
// HOST_UP→HOST_READY code issuance, KEY_BIND channel binding, JOIN with
// proof + asset identity, three-way host-key equality against the invite
// pin, RELAY bridging both directions — plus refusal lanes (bad proof,
// below-minimum version, tampered identity, non-printable name) and a
// rogue announcer playing host at the joined client. Malicious lanes are
// raw protocol speakers: an attacker does not run our code.
// Exit 0 = every assertion held.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const Hyperswarm = require('hyperswarm');
const DHT = require('hyperdht'); // shared swarm for every in-process lane

const F = require('../src/peer/qn_frame.cjs');
const E = require('../src/peer/qn_envelope.cjs');
const R = require('../src/peer/qn_room.cjs');
const P = require('../src/peer/qn_planeb.cjs');

const dht = new DHT();
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const shaBuf = (b) => crypto.createHash('sha256').update(b).digest();
const MANIFEST_ID = shaBuf(fs.readFileSync(path.join(__dirname, '..', 'gamedata.sha256')));
const PEER = path.join(__dirname, '..', 'src', 'peer', 'qn-peer.cjs');

const results = new Map();
const note = (n) => { results.set(n, true); console.log('OK  ', n); };
const failNote = (n, why) => { results.set(n, false); console.log('FAIL', n, '—', why); };

function mkTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2pquake-e2e-'));
  fs.chmodSync(dir, 0o700);
  return dir;
}

// ---- the engine side of Plane A: owns the socket, generates the token ----
class FakeEngine {
  constructor(name) {
    this.name = name;
    this.dir = mkTmpDir();
    this.sockPath = path.join(this.dir, 'engine.sock');
    this.token = crypto.randomBytes(32);
    this.frames = [];
    this.waiters = new Map(); // type -> [resolvers]
    this.seqOut = 0;
    this.state = { authOk: false, closedBad: false, peers: 0 };
    this.authed = new Promise((res) => { this._authed = res; });
  }
  async start() {
    this.server = net.createServer((conn) => {
      if (this.peer) { this.peer.destroy(); } // one qn-peer per match
      this.peer = conn;
      this.state.peers++;
      this.reader = new F.FrameReader();
      conn.on('data', (c) => {
        let frames;
        try { frames = this.reader.feed(c); }
        catch { this.state.closedBad = true; conn.destroy(); return; }
        for (const f of frames) {
          if (!this.authDone) {
            const ok = f.type === F.TYPES.AUTH && f.seq === 1 &&
              f.payload.length === this.token.length &&
              crypto.timingSafeEqual(f.payload, this.token);
            if (!ok) { this.state.closedBad = true; conn.destroy(); return; }
            this.authDone = true;
            this.state.authOk = true;
            this._authed();
            // keep the peer's §6.5 plane-A silence rule satisfied
            this.beat = setInterval(() => { try { this.send(F.TYPES.PING, Buffer.alloc(4)); } catch {} }, 1500);
            continue;
          }
          this.frames.push(f);
          const ws = this.waiters.get(f.type);
          if (ws) { while (ws.length) ws.shift()(f); }
        }
      });
      conn.on('error', () => {});
    });
    await new Promise((res) => this.server.listen(this.sockPath, res));
  }
  send(type, payload = Buffer.alloc(0)) {
    this.seqOut++;
    this.peer.write(F.encodeFrame(type, this.seqOut, payload));
  }
  expect(type, ms = 60000) {
    const hit = this.frames.find((f) => f.type === type);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error(this.name + ': frame 0x' + type.toString(16) + ' timeout')), ms);
      const list = this.waiters.get(type) || [];
      list.push((f) => { clearTimeout(to); res(f); });
      this.waiters.set(type, list);
    });
  }
  async destroy() {
    clearInterval(this.beat);
    if (this.peer) this.peer.destroy();
    this.server?.close();
    this.server?.closeAllConnections?.();
    fs.rmSync(this.dir, { recursive: true, force: true }); // ours only
  }
}

const FAKE_ENGINE = path.join(__dirname, '..', 'bin', 'fake-engine');

function spawnDaemon(sockPath, dir, extra = []) {
  const child = spawn(FAKE_ENGINE, ['--uds', sockPath, '--dir', dir, ...extra], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, QN_FAKE_ENGINE_NODE: process.execPath,
      QN_FAKE_ENGINE_SCRIPT: PEER },
  });
  const err = [];
  child.stderr.on('data', (c) => err.push(c));
  return {
    child,
    errText: () => Buffer.concat(err).toString('utf8'),
    token: null,
    exits: new Promise((res) => child.once('exit', (code, sig) => res({ code, sig }))),
  };
}

// ---- fixed identities for the daemon lanes (pre-seeded key files) ----
const hostDir = mkTmpDir(), clientDir = mkTmpDir();
const HOST_SEED = sha('e2e-host');
const CLIENT_SEED = sha('e2e-client-ok');
fs.writeFileSync(path.join(hostDir, 'identity.key'), HOST_SEED.toString('hex') + '\n', { mode: 0o600 });
fs.writeFileSync(path.join(clientDir, 'identity.key'), CLIENT_SEED.toString('hex') + '\n', { mode: 0o600 });
const hostPub = Buffer.from(E.publicRaw(E.publicKeyFromSeed(HOST_SEED)));
const clientPub = Buffer.from(E.publicRaw(E.publicKeyFromSeed(CLIENT_SEED)));
// The spawned daemons hash /proc/<ppid>/exe: their parent is the
// marker-carrying bin/fake-engine image, so these bytes are what the join
// lane proves, nothing asserted about them.
const ENGINE_IMAGE = fs.readFileSync(FAKE_ENGINE);
const ENGINE_ID = shaBuf(ENGINE_IMAGE);
const { extractBuildId } = require('../src/peer/qn-peer.cjs');
const BUILD_ID = extractBuildId(ENGINE_IMAGE);
const PLATFORM = Buffer.from(`${process.platform}-${process.arch}`, 'utf8');

// ---------------- raw attacker lanes (malicious peers don't run our code) ----
function rawClient(role, topic, matchId, code, opts = {}) {
  const seed = sha('e2e-client-' + role);
  const priv = E.privateKeyFromSeed(seed);
  const pub = Buffer.from(E.publicRaw(E.publicKeyFromSeed(seed)));
  const swarm = new Hyperswarm({ dht });
  const goal = {};
  const done = new Promise((res) => { goal.resolve = res; });
  const settle = (x) => { if (!goal.settled) { goal.settled = true; goal.resolve(x); } };
  swarm.join(topic, { server: false, client: true });
  swarm.on('connection', (conn) => {
    const st = { reader: new E.EnvelopeReader(), bound: null, win: new E.SeqWindow(),
      seqOut: 0 };
    const send = (type, fields) => {
      st.seqOut++;
      conn.write(E.encodeEnvelope({ type, matchId, seq: st.seqOut,
        payload: F.encodeTLV(fields) }, priv));
    };
    send(E.TYPES.KEY_BIND, [[1, Buffer.from(pub)],
      [2, Buffer.from(E.signWith(priv,
        E.noiseBindingContext(swarm.keyPair.publicKey, conn.remotePublicKey)))]]);
    conn.on('data', (chunk) => {
      let bufs;
      try { bufs = st.reader.feed(chunk); } catch { return settle('reader'); }
      for (const raw of bufs) {
        try {
          if (!st.bound) {
            const len = raw.readUInt16LE(2 + 2 + 1 + 1 + 2 + 16 + 4);
            const payload = raw.subarray(2 + E.HEAD_LEN, 2 + E.HEAD_LEN + len);
            const pre = new Map(F.decodeTLV(payload).map((f) => [f.tag, f.value]));
            const claimed = pre.get(1);
            if (!claimed || claimed.length !== 32) return settle('bad bind key');
            const env = E.decodeEnvelope(raw, claimed, { expectedMatchId: matchId });
            if (env.type !== E.TYPES.KEY_BIND) return settle('not-first');
            if (st.win.check(env.seq) !== 'accept') return settle('bind window');
            st.bound = claimed;
            const proof = role === 'badproof' ? Buffer.alloc(16, 0) : R.proofOf(code, pub);
            const minor = role === 'lowver' ? 0 : E.MINOR;
            const manifest = role === 'mismatch'
              ? Buffer.from(MANIFEST_ID).fill(MANIFEST_ID[0] ^ 0xff, 0, 1)
              : Buffer.from(MANIFEST_ID);
            const fields = [[1, Buffer.from(pub)], [2, Buffer.from(proof)],
              [3, Buffer.from(role)], [4, Buffer.from([E.MAJOR])],
              [5, Buffer.from([minor])], [6, manifest], [7, Buffer.from('id1')],
              [10, BUILD_ID], [11, PLATFORM], [12, Buffer.from(ENGINE_ID)]];
            if (role === 'badname') fields[2][1] = Buffer.from([0x07, 0x1b, 0x5b, 0x33, 0x31, 0x6d]);
            if (role === 'member') fields.push([0x8123, Buffer.from([7])]); // skipped, not fatal
            send(E.TYPES.JOIN, fields);
            continue;
          }
          const env = E.decodeEnvelope(raw, st.bound, { expectedMatchId: matchId });
          const r = st.win.check(env.seq);
          if (r.startsWith('close')) return settle('window ' + r);
          if (r === 'replay') continue;
          if (env.type === E.TYPES.JOIN_OK && role === 'member') {
            settle('joined');
            // signed chat, then the byte-identical duplicate: the receiver
            // must count it and never execute it twice.
            st.seqOut++;
            const chat = E.encodeEnvelope({ type: E.TYPES.CHAT, matchId, seq: st.seqOut,
              payload: F.encodeTLV([[1, Buffer.from('hello from client')]]) }, priv);
            conn.write(chat);
            conn.write(Buffer.from(chat));
          }
          if (env.type === E.TYPES.JOIN_NO) {
            const cause = new Map(F.decodeTLV(env.payload).map((f) => [f.tag, f.value])).get(1)[0];
            settle('refused:' + cause);
          }
        } catch { return settle('error'); }
      }
    });
    conn.on('error', () => {});
    conn.on('close', () => { if (!goal.settled) settle('closed early'); });
  });
  return { swarm, goal, done };
}

// A second announcer on the same topic that plays host at whoever binds to
// it without pinning: JOIN_OK/ROSTER claiming its own key. The client
// daemon must close it and keep its pinned join intact.
function runRogue(topic, matchId) {
  const priv = E.privateKeyFromSeed(sha('e2e-rogue-host'));
  const pub = Buffer.from(E.publicRaw(E.publicKeyFromSeed(sha('e2e-rogue-host'))));
  const swarm = new Hyperswarm({ dht });
  const tally = { attacked: 0, closedByPeer: 0 };
  let epoch = 0n;
  swarm.on('connection', (conn) => {
    const st = { reader: new E.EnvelopeReader(), bound: null, win: new E.SeqWindow(),
      seqOut: 0, joinedOff: false, attacked: false };
    const send = (type, fields) => {
      st.seqOut++;
      conn.write(E.encodeEnvelope({ type, matchId, seq: st.seqOut,
        payload: F.encodeTLV(fields) }, priv));
    };
    conn.on('data', (chunk) => {
      let bufs;
      try { bufs = st.reader.feed(chunk); } catch { conn.destroy(); return; }
      for (const raw of bufs) {
        try {
          if (!st.bound) {
            const len = raw.readUInt16LE(2 + 2 + 1 + 1 + 2 + 16 + 4);
            const payload = raw.subarray(2 + E.HEAD_LEN, 2 + E.HEAD_LEN + len);
            const claimed = new Map(F.decodeTLV(payload).map((f) => [f.tag, f.value])).get(1);
            if (!claimed || claimed.length !== 32) { conn.destroy(); return; }
            const env = E.decodeEnvelope(raw, claimed, { expectedMatchId: matchId });
            if (env.type !== E.TYPES.KEY_BIND) { conn.destroy(); return; }
            if (st.win.check(env.seq) !== 'accept') { conn.destroy(); return; }
            st.bound = claimed;
            send(E.TYPES.KEY_BIND, [[1, Buffer.from(pub)],
              [2, Buffer.from(E.signWith(priv,
                E.noiseBindingContext(swarm.keyPair.publicKey, conn.remotePublicKey)))]]);
            // A pinned client binds then goes silent (no JOIN): that is our
            // mark. Raw joiners send JOIN promptly and are left in peace.
            setTimeout(() => {
              if (st.joinedOff || st.attacked || conn.destroyed) return;
              st.attacked = true; tally.attacked++;
              send(E.TYPES.JOIN_OK, [[1, sha('rogue-roster')], [2, Buffer.from('e1m1')],
                [3, Buffer.from([9])], [6, Buffer.from(MANIFEST_ID)],
                [7, Buffer.from('id1')], [9, Buffer.from(pub)],
                [10, BUILD_ID], [11, PLATFORM], [12, Buffer.from(ENGINE_ID)]]);
              epoch++;
              const ep = Buffer.alloc(8); ep.writeBigUInt64LE(epoch);
              send(E.TYPES.ROSTER, [[1, Buffer.concat([Buffer.from([1]), pub])],
                [2, Buffer.from([E.MAJOR])], [3, Buffer.from([E.MINOR])],
                [4, ep], [5, Buffer.from(pub)]]);
            }, 400);
            continue;
          }
          const env = E.decodeEnvelope(raw, st.bound, { expectedMatchId: matchId });
          const r = st.win.check(env.seq);
          if (r !== 'accept') continue;
          if (env.type === E.TYPES.JOIN) st.joinedOff = true;
        } catch { conn.destroy(); return; }
      }
    });
    conn.on('close', () => { if (st.attacked) tally.closedByPeer++; });
    conn.on('error', () => {});
  });
  return { swarm, tally };
}

// ---------------- run ----------------
const guard = setTimeout(() => {
  console.log('E2E FAIL: 240 s guard expired (DHT egress?)');
  process.exit(2);
}, 240000);

const spawned = [];
let hostEngine = null, clientEngine = null;
async function main() {
  // host daemon: fake engine hosts, daemon announces and returns the code
  hostEngine = new FakeEngine('host-engine');
  await hostEngine.start();
  const hostDaemon = spawnDaemon(hostEngine.sockPath, hostDir);
  spawned.push(hostDaemon);
  hostDaemon.child.stdin.write(hostEngine.token);
  await hostEngine.authed; // engine frames only after the daemon is on the socket
  hostEngine.send(F.TYPES.HOST_UP, F.encodeTLV([[1, Buffer.from('e1m1')],
    [2, Buffer.from('test-host')], [3, Buffer.from([8])]]));
  const hostReady = await hostEngine.expect(F.TYPES.HOST_READY);
  const codeFromFrame = () => {
    const t = new Map(F.decodeTLV(hostReady.payload).map((f) => [f.tag, f.value]));
    const c = t.get(1);
    return c && c.length === 10 ? c : null;
  };
  const code = codeFromFrame();
  if (!code) throw new Error('HOST_READY malformed — cannot continue');
  note('host lane issues the join code to the engine display');
  const topic = R.topicOf(code);
  const matchId = R.matchIdOf(code);

  const rogue = runRogue(topic, matchId);
  await rogue.swarm.join(topic, { server: true, client: false }).flushed();

  // client daemon: pinned by the invite (code + host key), like a real join
  clientEngine = new FakeEngine('client-engine');
  await clientEngine.start();
  const clientDaemon = spawnDaemon(clientEngine.sockPath, clientDir, ['--name', 'ok']);
  spawned.push(clientDaemon);
  clientDaemon.child.stdin.write(clientEngine.token);
  await clientEngine.authed;
  clientEngine.send(F.TYPES.JOIN_PIN, F.encodeTLV([[1, Buffer.from(hostPub)]]));
  clientEngine.send(F.TYPES.JOIN_OPEN, Buffer.from(code));
  try {
    const up = await clientEngine.expect(F.TYPES.PEER_UP); // host surfaced to the engine
    const ut = new Map(F.decodeTLV(up.payload).map((x) => [x.tag, x.value]));
    ut.get(1) && ut.get(1).equals(hostPub)
      ? note('client daemon joins by proof+signature')
      : failNote('client daemon joins by proof+signature', 'PEER_UP not keyed to the pinned host');
  } catch (e) {
    const tail = (d) => d.errText().trim().split('\n').slice(-6).join(' | ');
    failNote('client daemon joins by proof+signature',
      e.message + ' || host:[' + tail(hostDaemon) + '] client:[' + tail(clientDaemon) + ']');
  }

  // no PEER_UP may ever carry the client's own identity key back to it
  const selfUps = clientEngine.frames.filter((f) => f.type === F.TYPES.PEER_UP)
    .map((f) => new Map(F.decodeTLV(f.payload).map((x) => [x.tag, x.value])))
    .filter((t) => t.get(1) && t.get(1).equals(clientPub));
  selfUps.length === 0
    ? note('the engine is never told it is its own remote peer')
    : failNote('the engine is never told it is its own remote peer', selfUps.length + ' self PEER_UPs');

  // bridge host→client: engine server output reaches the client engine tagged
  const body = Buffer.from('servmsg-' + Date.now());
  clientEngine.frames.length = 0;
  hostEngine.send(F.TYPES.SV_DATA, F.encodeTLV([[1, Buffer.from(clientPub)], [2, body]]));
  try {
    const f = await clientEngine.expect(F.TYPES.SV_DATA);
    const t = new Map(F.decodeTLV(f.payload).map((x) => [x.tag, x.value]));
    t.get(1).equals(hostPub) && t.get(2).equals(body)
      ? note('server output bridges host→client engine')
      : failNote('server output bridges host→client engine', 'origin or body wrong');
  } catch (e) {
    failNote('server output bridges host→client engine', e.message);
  }

  // bridge client→host: local user input reaches the host engine tagged
  const cmd = Buffer.from('usercmd-' + Date.now());
  hostEngine.frames.length = 0;
  clientEngine.send(F.TYPES.CLIENT_CMD, F.encodeTLV([[1, cmd]]));
  try {
    const f = await hostEngine.expect(F.TYPES.CL_DATA);
    const t = new Map(F.decodeTLV(f.payload).map((x) => [x.tag, x.value]));
    t.get(1).equals(clientPub) && t.get(2).equals(cmd)
      ? note('user input bridges client→host engine')
      : failNote('user input bridges client→host engine', 'origin or body wrong');
  } catch (e) {
    failNote('user input bridges client→host engine', e.message);
  }

  // malicious lanes against the live host daemon, staggered to respect the
  // §6.1 pre-auth connection cap (one wave of three, then the name lane)
  const attackers = {};
  for (const role of ['badproof', 'lowver', 'mismatch'])
    attackers[role] = rawClient(role, topic, matchId, code);
  const verdicts = await Promise.all([
    attackers.badproof.done, attackers.lowver.done, attackers.mismatch.done]);
  const want = [
    ['bad proof refused with cause 2', `refused:${E.CAUSES.BAD_PROOF}`, 'badproof'],
    ['below-minimum version refused with cause 1', `refused:${E.CAUSES.VERSION_TOO_OLD}`, 'lowver'],
    ['tampered asset identity refused with cause 7', `refused:${E.CAUSES.ASSET_MISMATCH}`, 'mismatch'],
  ];
  for (let i = 0; i < want.length; i++) {
    verdicts[i] === want[i][1] ? note(want[i][0]) : failNote(want[i][0], String(verdicts[i]));
  }
  const badName = rawClient('badname', topic, matchId, code);
  const nameVerdict = await badName.done;
  // The close and the host's log line travel different pipes; poll the log
  // to its own deadline rather than racing a single look.
  let logged = false;
  for (let i = 0; i < 30 && !logged; i++) {
    logged = /name not printable/.test(hostDaemon.errText());
    if (!logged) await new Promise((r) => setTimeout(r, 100));
  }
  nameVerdict === 'closed early' && logged
    ? note('non-printable name kills the connection at parse (name contract)')
    : failNote('non-printable name kills the connection at parse',
        String(nameVerdict) + ' logged-rule:' + logged);

  // honest raw member: experimental TLV skipped; signed chat received once
  // despite the byte-identical duplicate (window counts it, nothing executes)
  const member = rawClient('member', topic, matchId, code);
  const memberVerdict = await member.done;
  memberVerdict === 'joined'
    ? note('unknown experimental TLV skipped, not fatal')
    : failNote('unknown experimental TLV skipped, not fatal', String(memberVerdict));
  await new Promise((r) => setTimeout(r, 3000));
  const chatHits = (hostDaemon.errText().match(/host: chat received/g) || []).length;
  chatHits === 1
    ? note('signed chat verified; the byte-identical duplicate dropped, not executed')
    : failNote('mid-session replay dropped by receiver', 'chat logged ' + chatHits + 'x');

  // rogue announcer lane: it played host at the pinned client and must have
  // been closed while the real join stands (bridge once more to prove it)
  const body2 = Buffer.from('servmsg2-' + Date.now());
  clientEngine.frames.length = 0;
  hostEngine.send(F.TYPES.SV_DATA, F.encodeTLV([[1, Buffer.from(clientPub)], [2, body2]]));
  try {
    await clientEngine.expect(F.TYPES.SV_DATA, 30000);
    rogue.tally.attacked >= 1 && rogue.tally.closedByPeer >= 1
      ? note('non-pinned host closed by the client; the pinned host still joins')
      : failNote('non-pinned host closed by the client',
        `attacked=${rogue.tally.attacked} closed=${rogue.tally.closedByPeer}`);
  } catch (e) {
    failNote('non-pinned host closed by the client', 'join lost after rogue: ' + e.message);
  }
}

main().then(async () => {
  const allPass = [...results.values()].every(Boolean);
  console.log(allPass ? 'E2E OK:' : 'E2E FAILED:', results.size, 'assertions');
  clearTimeout(guard);
  for (const d of spawned) if (d.child.exitCode === null) d.child.kill('SIGTERM');
  await Promise.allSettled([hostEngine?.destroy(), clientEngine?.destroy()]);
  process.exit(allPass ? 0 : 1);
}).catch(async (e) => {
  clearTimeout(guard);
  console.log('E2E CRASH:', e.stack || e);
  for (const d of spawned) if (d.child.exitCode === null) d.child.kill('SIGTERM');
  process.exit(1);
});
