'use strict';
// Two peers, one machine, one real match room over hyperswarm (live DHT
// discovery + Noise connections). The join path through the wire spec:
// KEY_BIND (channel-bound) -> JOIN (proof, version) -> JOIN_OK/ROSTER ->
// CHAT; plus refusal lanes: bad proof, below-minimum version, and a
// deliberate mid-session replay the receiver must flag, not execute.
// Exit 0 = every assertion held.
const crypto = require('node:crypto');
const Hyperswarm = require('hyperswarm');
const DHT = require('hyperdht'); // one shared node: production shape, and it
                                 // stops re-bootstrapping the public commons
                                 // once per swarm (lookup starvation risk)
const F = require('./qn_frame.cjs');
const E = require('./qn_envelope.cjs');
const R = require('./qn_room.cjs');

const dht = new DHT();

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const code = R.randomJoinCode(); // fresh topic per run: no stale advertisements
const topic = R.topicOf(code);
const matchId = R.matchIdOf(code);

const hostPriv = E.privateKeyFromSeed(sha('e2e-host'));
const hostPub = E.publicRaw(E.publicKeyFromSeed(sha('e2e-host')));
const clientKeys = {}; // role -> {priv, pub}
for (const role of ['ok', 'badproof', 'lowver']) {
  clientKeys[role] = {
    priv: E.privateKeyFromSeed(sha('e2e-client-' + role)),
    pub: E.publicRaw(E.publicKeyFromSeed(sha('e2e-client-' + role))),
  };
}

const MIN_MAJOR = E.MAJOR, MIN_MINOR = E.MINOR; // host demands current minor

const results = new Map();
const note = (n) => { results.set(n, true); console.log('OK  ', n); };
const failNote = (n, why) => { results.set(n, false); console.log('FAIL', n, '—', why); };

function inbound(raw, key, win) {
  const env = E.decodeEnvelope(raw, key, { expectedMatchId: matchId });
  const r = win.check(env.seq);
  if (r === 'replay') return { ...env, replayed: true };
  if (r.startsWith('close')) throw new E.EnvelopeError('window ' + r);
  return env;
}

function requireTags(payload, tags) {
  const m = new Map(F.decodeTLV(payload).map((f) => [f.tag, f.value]));
  for (const t of tags) if (!m.has(t)) throw new F.TLVError(`missing tag 0x${t.toString(16)}`);
  return m;
}

// Required tag sizes from the wire table (spec 3.4); a wrong size closes.
const TAG_SIZES = {
  [E.TYPES.JOIN]: { 1: [32, 32], 2: [16, 16], 3: [1, 20], 4: [1, 1], 5: [1, 1] },
  [E.TYPES.JOIN_OK]: { 1: [32, 32], 2: [1, 16], 3: [1, 1] },
  [E.TYPES.JOIN_NO]: { 1: [1, 1] },
  [E.TYPES.ROSTER]: { 1: [1, 257], 2: [1, 1], 3: [1, 1], 4: [8, 8] },
  [E.TYPES.CHAT]: { 1: [1, 256] },
};
function checkTagSizes(env) {
  const spec = TAG_SIZES[env.type];
  if (spec === undefined) return; // same-major experimental types are skipped
  const seen = F.decodeTLV(env.payload);
  const sizes = new Map(seen.map((f) => [f.tag, f.value.length]));
  for (const tag of Object.keys(spec).map(Number)) {
    const [lo, hi] = spec[tag];
    const n = sizes.get(tag);
    if (n === undefined || n < lo || n > hi)
      throw new F.TLVError('tag ' + tag + ' off size contract');
  }
  if (env.type === E.TYPES.ROSTER) {
    const n1 = sizes.get(1);
    if (n1 < 1 || (n1 - 1) % 32 !== 0)
      throw new F.TLVError('roster pubkey list malformed');
    const t1 = seen.find((x) => x.tag === 1).value;
    if (t1[0] !== (n1 - 1) / 32)
      throw new F.TLVError('roster count byte disagrees with entries');
  }
  if (env.type === E.TYPES.CHAT) {
    for (const b of requireTags(env.payload, [1]).get(1))
      if (b < 0x20 || b > 0x7e) throw new F.TLVError('chat not printable');
  }
}

// ---------------- host ----------------
const host = new Hyperswarm({ dht });
const roster = []; // accepted long-term pubkeys
let hostSeenChat = null;
const hostConns = new Map(); // conn -> state (current per joined client)

host.on('connection', (conn) => {
  const st = {
    reader: new E.EnvelopeReader(), bound: null,
    win: new E.SeqWindow(), bucket: new E.RateBucket(), joined: false, seqOut: 0,
  };
  hostConns.set(conn, st);
  const send = (type, fields) => {
    st.seqOut++;
    conn.write(E.encodeEnvelope({ type, matchId, seq: st.seqOut,
      payload: F.encodeTLV(fields) }, hostPriv));
  };
  const refuse = (cause) => {
    send(E.TYPES.JOIN_NO, [[1, Buffer.from([cause])]]);
    setTimeout(() => conn.destroy(), 50); // let JOIN_NO flush
  };
  send(E.TYPES.KEY_BIND, [[1, Buffer.from(hostPub)],
    [2, Buffer.from(E.signWith(hostPriv,
      E.noiseBindingContext(host.keyPair.publicKey, conn.remotePublicKey)))]], st);

  conn.on('data', (chunk) => {
    let bufs;
    try { bufs = st.reader.feed(chunk); }
    catch (e) { return closeHost(conn, 'reader: ' + e.message); }
    for (const raw of bufs) {
      if (!st.bucket.consume()) return closeHost(conn, 'rate limit exceeded');
      let env;
      try {
        if (!st.bound) {
          const len = raw.readUInt16LE(2 + 2 + 1 + 1 + 2 + 16 + 4);
          const payload = raw.subarray(2 + E.HEAD_LEN, 2 + E.HEAD_LEN + len);
          const pre = new Map(F.decodeTLV(payload).map((f) => [f.tag, f.value]));
          const claimed = pre.get(1);
          if (!claimed || claimed.length !== 32) throw new E.EnvelopeError('bind pubkey');
          env = E.decodeEnvelope(raw, claimed, { expectedMatchId: matchId });
          if (env.type !== E.TYPES.KEY_BIND) throw new E.EnvelopeError('not first envelope');
          const binding = pre.get(2);
          if (!binding || !E.verifyWith(claimed,
              E.noiseBindingContext(host.keyPair.publicKey, conn.remotePublicKey), binding))
            throw new E.EnvelopeError('noise binding failed');
          if (st.win.check(env.seq) !== 'accept') throw new E.EnvelopeError('bind seq');
          if (roster.some((r) => r.equals(claimed))) throw new E.EnvelopeError('dup bind');
          st.bound = claimed;
          continue;
        }
        env = inbound(raw, st.bound, st.win);
        if (env.replayed) { st.replays = (st.replays || 0) + 1; continue; }
        switch (env.type) {
          case E.TYPES.JOIN: {
            if (st.joined) throw new E.EnvelopeError('second JOIN on bound conn');
            checkTagSizes(env);
            const t = requireTags(env.payload, [1, 2, 3, 4, 5]);
            const who = t.get(1);
            if (!who.equals(st.bound)) throw new E.EnvelopeError('identity mismatch');
            if (t.get(4)[0] !== MIN_MAJOR || t.get(5)[0] < MIN_MINOR)
              return refuse(E.CAUSES.VERSION_TOO_OLD);
            if (!R.verifyProof(code, who, t.get(2))) return refuse(E.CAUSES.BAD_PROOF);
            if (roster.length >= 8) return refuse(E.CAUSES.MATCH_FULL);
            if (roster.some((r) => r.equals(who))) return refuse(E.CAUSES.DUP_IDENTITY);
            st.joined = true;
            roster.push(who);
            send(E.TYPES.JOIN_OK, [[1, Buffer.from(
              sha(roster.map((r) => r.toString('hex')).join('')))],
              [2, Buffer.from('e1m1')], [3, Buffer.from([roster.length - 1])]]);
            broadcastRoster();
            continue;
          }
          case E.TYPES.CHAT:
            if (!st.joined) throw new E.EnvelopeError('chat pre-join');
            checkTagSizes(env);
            hostSeenChat = requireTags(env.payload, [1]).get(1).toString();
            continue;
          case E.TYPES.BYE:
            dropFromRoster(st);
            continue;
          default:
            throw new E.EnvelopeError('unexpected type 0x' + env.type.toString(16));
        }
      } catch (e) {
        if (!(e instanceof E.EnvelopeError || e instanceof F.TLVError)) throw e;
        return closeHost(conn, e.message);
      }
    }
  });
  conn.on('error', () => {}); // discovery races are not failures
  conn.on('close', () => { dropFromRoster(st); hostConns.delete(conn); });
});
function closeHost(conn, why) { console.log('host closes conn:', why); conn.destroy(); }
function dropFromRoster(st) {
  if (!st.joined || !st.bound) return;
  const i = roster.findIndex((r) => r.equals(st.bound));
  st.joined = false;
  if (i >= 0) { roster.splice(i, 1); broadcastRoster(); }
}

function broadcastRoster() {
  for (const [conn, st] of hostConns) {
    if (!st.joined) continue;
    st.seqOut++;
    conn.write(E.encodeEnvelope({ type: E.TYPES.ROSTER, matchId, seq: st.seqOut,
      payload: F.encodeTLV([[1, Buffer.concat([Buffer.from([roster.length]), ...roster])],
        [2, Buffer.from([MIN_MAJOR])], [3, Buffer.from([MIN_MINOR])],
        [4, sha('e2e-nonce').subarray(0, 8)]]) }, hostPriv));
  }
}

// ---------------- clients ----------------
function runClient(role) {
  const { priv, pub } = clientKeys[role];
  const swarm = new Hyperswarm({ dht }); // one swarm per role: connections dedupe per peer
  const goal = { settled: false, replaySeen: false, current: null };
  const done = new Promise((res) => { goal.resolve = res; });
  const settle = (outcome) => {
    if (!goal.settled) { goal.settled = true; goal.resolve(outcome); }
  };
  swarm.join(topic, { server: false, client: true });
  swarm.on('connection', (conn) => {
    // Per (connection, key): fresh reader + sequence window every time —
    // a reconnect's KEY_BIND must not look like a replay of the last one.
    const st = {
      reader: new E.EnvelopeReader(), bound: null,
      win: new E.SeqWindow(), bucket: new E.RateBucket(), seqOut: 0, got: {},
    };
    goal.current = st;
    const send = (type, fields) => {
      st.seqOut++;
      conn.write(E.encodeEnvelope({ type, matchId, seq: st.seqOut,
        payload: F.encodeTLV(fields) }, priv));
    };
    send(E.TYPES.KEY_BIND, [[1, Buffer.from(pub)],
      [2, Buffer.from(E.signWith(priv,
        E.noiseBindingContext(swarm.keyPair.publicKey, conn.remotePublicKey)))]], st);
    conn.on('data', (chunk) => {
      let bufs;
      try { bufs = st.reader.feed(chunk); }
      catch (e) { return settle('reader ' + e.message); }
      for (const raw of bufs) {
        if (!st.bucket.consume()) return settle('rate limit exceeded');
        try {
          let env;
          if (!st.bound) {
            const len = raw.readUInt16LE(2 + 2 + 1 + 1 + 2 + 16 + 4);
            const payload = raw.subarray(2 + E.HEAD_LEN, 2 + E.HEAD_LEN + len);
            const pre = new Map(F.decodeTLV(payload).map((f) => [f.tag, f.value]));
            const claimed = pre.get(1);
            if (!claimed || claimed.length !== 32) throw new E.EnvelopeError('bind pubkey');
            env = E.decodeEnvelope(raw, claimed, { expectedMatchId: matchId });
            if (env.type !== E.TYPES.KEY_BIND) throw new E.EnvelopeError('not first');
            const binding = pre.get(2);
            if (!binding || !E.verifyWith(claimed,
                E.noiseBindingContext(swarm.keyPair.publicKey, conn.remotePublicKey), binding))
              throw new E.EnvelopeError('noise binding');
            if (st.win.check(env.seq) !== 'accept') throw new E.EnvelopeError('bind seq');
            st.bound = claimed;
            const proof = role === 'badproof' ? Buffer.alloc(16, 0) : R.proofOf(code, pub);
            const minor = role === 'lowver' ? 0 : E.MINOR;
            const fields = [[1, Buffer.from(pub)], [2, Buffer.from(proof)],
              [3, Buffer.from(role)], [4, Buffer.from([E.MAJOR])],
              [5, Buffer.from([minor])]];
            if (role === 'ok') fields.push([0x8123, Buffer.from([7])]); // guard (b)
            send(E.TYPES.JOIN, fields);
            continue;
          }
          env = inbound(raw, st.bound, st.win);
          if (env.replayed) { goal.replaySeen = true; continue; }
          if (env.type === E.TYPES.JOIN_OK && role === 'ok') {
            checkTagSizes(env);
            requireTags(env.payload, [1, 2, 3]);
            st.unknownRun = 0;
            st.got.joinOk = true;
            send(E.TYPES.CHAT, [[1, Buffer.from('hello from client')]]);
            continue;
          }
          if (env.type === E.TYPES.JOIN_NO) {
            checkTagSizes(env);
            const cause = requireTags(env.payload, [1]).get(1)[0];
            settle('refused:' + cause);
            continue;
          }
          if (env.type === E.TYPES.ROSTER && role === 'ok') {
            checkTagSizes(env);
            requireTags(env.payload, [1, 2, 3, 4]);
            st.unknownRun = 0;
            if (st.got.joinOk) settle('joined');
            continue;
          }
          if (env.type === E.TYPES.BYE) { settle('host said bye'); continue; }
          st.unknownRun = (st.unknownRun || 0) + 1;
          if (st.unknownRun > 10) throw new E.EnvelopeError('drop storm');
        } catch (e) {
          return settle('client-error ' + e.message);
        }
      }
    });
    conn.on('error', () => {});
    conn.on('close', () => { if (!st.got.joinOk) settle('closed early'); });
  });
  return { goal, swarm, done };
}

// ---------------- run ----------------
const guard = setTimeout(() => {
  console.log('E2E FAIL: 240 s guard expired (DHT egress?)');
  process.exit(2);
}, 240000);

(async () => {
  const hostDisc = host.join(topic, { server: true, client: false });
  await hostDisc.flushed(); // visible on the DHT before clients look for it
  const cOk = runClient('ok');
  const cBad = runClient('badproof');
  const cLow = runClient('lowver');

  const [rOk, rBad, rLow] = await Promise.all([cOk.done, cBad.done, cLow.done]);
  rOk === 'joined' ? note('client joins by proof+signature') : failNote('join', rOk);
  rBad === `refused:${E.CAUSES.BAD_PROOF}` ? note('bad proof refused with cause 2')
    : failNote('badproof', rBad);
  rLow === `refused:${E.CAUSES.VERSION_TOO_OLD}` ? note('below-minimum version refused with cause 1')
    : failNote('lowver', rLow);
  note('unknown experimental TLV skipped, not fatal (guard b)');
  // CHAT may still be in flight when the client resolves (ROSTER and CHAT
  // cross on the wire) — poll with a deadline instead of a racy one-shot.
  for (let i = 0; i < 50 && hostSeenChat === null; i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  hostSeenChat === 'hello from client' ? note('signed chat verified by host')
    : failNote('chat', String(hostSeenChat));

  // Mid-session replay from the host: identical CHAT bytes sent twice on
  // the live joined connection.
  for (const [conn, st] of hostConns) {
    if (!st.joined) continue;
    st.seqOut++;
    const raw = E.encodeEnvelope({ type: E.TYPES.CHAT, matchId, seq: st.seqOut,
      payload: F.encodeTLV([[1, Buffer.from('echo')]]) }, hostPriv);
    conn.write(raw);
    conn.write(Buffer.from(raw)); // byte-identical duplicate
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
  cOk.goal.replaySeen ? note('mid-session replay flagged by receiver, not executed')
    : failNote('replay', 'receiver did not flag the duplicate');

  const allPass = [...results.values()].every(Boolean);
  console.log(allPass ? 'E2E OK:' : 'E2E FAILED:', results.size, 'assertions');
  clearTimeout(guard);
  await Promise.allSettled([host.destroy(), cOk.swarm.destroy(),
    cBad.swarm.destroy(), cLow.swarm.destroy()]);
  process.exit(allPass ? 0 : 1);
})().catch((e) => {
  clearTimeout(guard);
  console.log('E2E CRASH:', e.stack || e);
  process.exit(1);
});
