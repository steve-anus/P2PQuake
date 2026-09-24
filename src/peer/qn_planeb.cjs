'use strict';
// Plane B session machinery for qn-peer, per src/protocol/qn_protocol.md §3.
// One connection = one session; rooms own the shared state. Timing goes
// through the injected clock (deterministic stage timers in tests).
// Log/callback values are locally produced fixed strings or integers:
// wire bytes are never echoed, only verified and forwarded.
const E = require('./qn_envelope.cjs');
const F = require('./qn_frame.cjs');
const R = require('./qn_room.cjs');

const isPrintable = (buf) => {
  for (const b of buf) if (b < 0x20 || b > 0x7e) return false;
  return buf.length > 0;
};

// Required tag sizes from the wire table (§3.4); a wrong size closes.
const TAG_SIZES = {
  [E.TYPES.JOIN]: { 1: [32, 32], 2: [16, 16], 3: [1, 20], 4: [1, 1], 5: [1, 1],
    6: [32, 32], 7: [1, 32], 10: [1, 64], 11: [1, 32], 12: [32, 32] },
  [E.TYPES.JOIN_OK]: { 1: [32, 32], 2: [1, 16], 3: [1, 1],
    6: [32, 32], 7: [1, 32], 9: [32, 32], 10: [1, 64], 11: [1, 32],
    12: [32, 32] },
  [E.TYPES.JOIN_NO]: { 1: [1, 1] },
  [E.TYPES.ROSTER]: { 1: [1, 257], 2: [1, 1], 3: [1, 1], 4: [8, 8], 5: [32, 32] },
  [E.TYPES.RELAY]: { 1: [32, 32], 2: [1, 1100] },
  [E.TYPES.CHAT]: { 1: [1, 256] },
  [E.TYPES.PING]: { 1: [4, 4] },
  [E.TYPES.PONG]: { 1: [4, 4] },
};

function tagMap(payload, tags) {
  const m = new Map(F.decodeTLV(payload).map((f) => [f.tag, f.value]));
  for (const t of tags) if (!m.has(t)) throw new F.TLVError(`missing tag 0x${t.toString(16)}`);
  return m;
}

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
    if (n1 < 1 || (n1 - 1) % 32 !== 0) throw new F.TLVError('roster pubkey list malformed');
    const t1 = seen.find((x) => x.tag === 1).value;
    if (t1[0] !== (n1 - 1) / 32) throw new F.TLVError('roster count byte disagrees with entries');
  }
  if (env.type === E.TYPES.CHAT && !isPrintable(tagMap(env.payload, [1]).get(1)))
    throw new F.TLVError('chat not printable');
  if (env.type === E.TYPES.JOIN && !isPrintable(tagMap(env.payload, [3]).get(3)))
    throw new F.TLVError('name not printable');
  if (env.type === E.TYPES.JOIN || env.type === E.TYPES.JOIN_OK) {
    const tt = tagMap(env.payload, [10, 11]);
    if (!isPrintable(tt.get(10))) throw new F.TLVError('build_id not printable');
    if (!isPrintable(tt.get(11))) throw new F.TLVError('platform not printable');
  }
}

// §2.4/§3.5b: only the experimental range may ride along unknown; any
// other undefined tag is counted and dropped (else: a counting-exempt
// spam channel).
function hasIllegalTags(env) {
  const spec = TAG_SIZES[env.type];
  if (spec === undefined) return false; // unknown types: the caller counts those
  for (const f of F.decodeTLV(env.payload))
    if (spec[f.tag] === undefined && f.tag < 0x8000) return true;
  return false;
}

const realClock = {
  now: () => globalThis.performance.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (h) => clearTimeout(h),
};

// Decode envelope + apply the §3.3 window for a bound connection.
function inbound(raw, boundKey, win, matchId) {
  const env = E.decodeEnvelope(raw, boundKey, { expectedMatchId: matchId });
  const r = win.check(env.seq);
  if (r === 'replay') return { env, replayed: true };
  if (r.startsWith('close')) throw new E.EnvelopeError('window ' + r);
  return { env, replayed: false };
}

// One Plane B connection. The KEY_BIND lane is shared by both roles;
// subclasses decide what a bound peer may send.
class Session {
  constructor(room, conn, role) {
    this.room = room;
    this.conn = conn;
    this.role = role;
    this.reader = new E.EnvelopeReader();
    this.bound = null;
    this.win = new E.SeqWindow();
    this.bucket = new E.RateBucket({ now: room.clock.now });
    this.preBucket = new E.RateBucket({ rate: 10, burst: 5, now: room.clock.now });
    this.unknownRun = 0;
    this.seqOut = 0;
    this.joined = false;
    this.dead = false;
    this.timers = [];
    this.lastIn = room.clock.now();
  }

  schedule(ms, fn) {
    const h = this.room.clock.setTimeout(() => { this.timers = this.timers.filter((x) => x !== h); fn(); }, ms);
    this.timers.push(h);
    return h;
  }
  clearTimers() { for (const h of this.timers) this.room.clock.clearTimeout(h); this.timers = []; }

  // Hosts send KEY_BIND on accept; clients on connect (spec §3.4: each
  // direction's first envelope is KEY_BIND, so both sides send one).
  sendBind() {
    const swarm = this.room.swarm;
    this.send(E.TYPES.KEY_BIND, [[1, Buffer.from(this.room.keys.pub)],
      [2, Buffer.from(E.signWith(this.room.keys.priv,
        E.noiseBindingContext(swarm.keyPair.publicKey, this.conn.remotePublicKey)))]]);
  }

  send(type, fields) {
    this.seqOut++;
    this.conn.write(E.encodeEnvelope(
      { type, matchId: this.room.matchId, seq: this.seqOut, payload: F.encodeTLV(fields) },
      this.room.keys.priv));
  }

  start(onData) {
    this.bindTimer = this.schedule(this.room.timeouts.keyBindMs, () =>
      this.close('key-bind timeout'));
    this.conn.on('data', (chunk) => {
      let bufs;
      try { bufs = this.reader.feed(chunk); }
      catch (e) { return this.close('reader: ' + e.name); }
      for (const raw of bufs) {
        const pipe = this.bound ? this.bucket : this.preBucket; // §6.1
        if (!pipe.consume()) return this.close('rate limit exceeded');
        this.lastIn = this.room.clock.now();
        try {
          if (!this.bound) { this.acceptBind(raw); continue; }
          this.onBoundEnvelope(raw);
        } catch (e) {
          if (!(e instanceof E.EnvelopeError || e instanceof F.TLVError)) throw e;
          return this.close(e.message);
        }
      }
    });
    this.conn.on('error', () => {}); // discovery races are not failures
    this.conn.on('close', () => this.close('remote close'));
    this.pingLoop();
    if (onData) onData();
  }

  pingLoop() {
    const step = () => {
      if (this.dead) return;
      const silence = this.room.clock.now() - this.lastIn;
      if (silence > this.room.timeouts.deadMs) return this.close('dead peer');
      try { this.send(E.TYPES.PING, [[1, this.room.nonceBuf()]]); }
      catch { return this.close('ping encode failed'); }
      this.pingTimer = this.schedule(this.room.timeouts.pingMs, step);
      this.timers.push(this.pingTimer);
    };
    this.pingTimer = this.schedule(this.room.timeouts.pingMs, step);
  }

  acceptBind(raw) {
    const len = raw.readUInt16LE(2 + 2 + 1 + 1 + 2 + 16 + 4);
    const payload = raw.subarray(2 + E.HEAD_LEN, 2 + E.HEAD_LEN + len);
    const pre = new Map(F.decodeTLV(payload).map((f) => [f.tag, f.value]));
    const claimed = pre.get(1);
    if (!claimed || claimed.length !== 32) throw new E.EnvelopeError('bind pubkey');
    const env = E.decodeEnvelope(raw, claimed, { expectedMatchId: this.room.matchId });
    if (env.type !== E.TYPES.KEY_BIND) throw new E.EnvelopeError('not first envelope');
    const binding = pre.get(2);
    const ctx = E.noiseBindingContext(this.room.swarm.keyPair.publicKey, this.conn.remotePublicKey);
    if (!binding || !E.verifyWith(claimed, ctx, binding))
      throw new E.EnvelopeError('noise binding failed');
    if (this.win.check(env.seq) !== 'accept') throw new E.EnvelopeError('bind seq');
    this.bound = claimed;
    this.room.clock.clearTimeout(this.bindTimer);
    this.afterBind();
  }

  close(why) {
    if (this.dead) return;
    this.dead = true;
    this.clearTimers();
    this.room.sessionClosed(this, why);
    this.conn.destroy();
  }
}

// ---------------- host ----------------
class HostSession extends Session {
  constructor(room, conn) { super(room, conn, 'host'); }
  start() {
    super.start(() => this.sendBind());
  }
  afterBind() {
    this.joinTimer = this.schedule(this.room.timeouts.joinMs, () =>
      this.close('join timeout'));
  }
  onBoundEnvelope(raw) {
    const { env, replayed } = inbound(raw, this.bound, this.win, this.room.matchId);
    if (replayed) return; // counted by the window; never executed
    if (hasIllegalTags(env)) {
      if (++this.unknownRun > 10) throw new E.EnvelopeError('drop storm (§3.4b)');
      return;
    }
    switch (env.type) {
      case E.TYPES.JOIN: {
        if (this.joined) throw new E.EnvelopeError('second JOIN on bound conn');
        checkTagSizes(env);
        const t = tagMap(env.payload, [1, 2, 3, 4, 5, 6, 7, 10, 11, 12]);
        const who = t.get(1);
        if (!who.equals(this.bound)) throw new E.EnvelopeError('identity mismatch');
        if (t.get(4)[0] !== this.room.minVersion.major ||
            t.get(5)[0] < this.room.minVersion.minor)
          return this.refuse(E.CAUSES.VERSION_TOO_OLD);
        if (!R.verifyProof(this.room.code, who, t.get(2))) {
          this.room.lockout(this.conn.remotePublicKey, 'bad proof');
          return this.refuse(E.CAUSES.BAD_PROOF);
        }
        // §3.4a: 11/12 are info-only; never compared here.
        if (!t.get(6).equals(this.room.identity.manifest) ||
            !t.get(7).equals(this.room.identity.gamedir) ||
            !t.get(10).equals(this.room.identity.buildId))
          return this.refuse(E.CAUSES.ASSET_MISMATCH);
        if (this.room.peerCount() >= this.room.maxPeers)
          return this.refuse(E.CAUSES.MATCH_FULL);
        if (this.room.hasMember(who)) return this.refuse(E.CAUSES.DUP_IDENTITY);
        const slot = this.room.allocSlot(who);
        if (slot === null) return this.refuse(E.CAUSES.MATCH_FULL);
        this.joined = true;
        this.unknownRun = 0;
        this.room.clock.clearTimeout(this.joinTimer);
        this.room.cbs.onPeerUp(who, t.get(3),
          { platform: t.get(11), binarySha: t.get(12) });
        this.send(E.TYPES.JOIN_OK, [[1, this.room.rosterHash()],
          [2, this.room.mapTag()], [3, Buffer.from([slot])],
          [6, Buffer.from(this.room.identity.manifest)],
          [7, Buffer.from(this.room.identity.gamedir)],
          [9, Buffer.from(this.room.keys.pub)],
          [10, Buffer.from(this.room.identity.buildId)],
          [11, Buffer.from(this.room.identity.platform)],
          [12, Buffer.from(this.room.identity.binarySha)]]);
        this.room.broadcastRoster();
        return;
      }
      case E.TYPES.CHAT:
        if (!this.joined) throw new E.EnvelopeError('chat pre-join');
        checkTagSizes(env);
        this.room.cbs.onChat(this.bound, tagMap(env.payload, [1]).get(1));
        return;
      case E.TYPES.BYE:
        this.room.dropFromRoster(this);
        this.unknownRun = 0;
        return;
      case E.TYPES.RELAY: {
        if (!this.joined) throw new E.EnvelopeError('relay pre-join');
        checkTagSizes(env);
        const t = tagMap(env.payload, [1, 2]);
        if (!t.get(1).equals(this.bound)) // host side: origin must be this connection's bound key
          throw new E.EnvelopeError('relay origin != bound key');
        this.room.cbs.onClData(this.bound, t.get(2));
        return;
      }
      case E.TYPES.PING:
        checkTagSizes(env);
        this.send(E.TYPES.PONG, [[1, tagMap(env.payload, [1]).get(1)]]);
        return;
      case E.TYPES.PONG:
        return; // our ping answered
      default:
        this.unknownRun++; // §3.4b: drop+count, close at 10
        if (this.unknownRun > 10) throw new E.EnvelopeError('drop storm (§3.4b)');
    }
  }
  refuse(cause) {
    this.send(E.TYPES.JOIN_NO, [[1, Buffer.from([cause])]]);
    this.schedule(50, () => this.close('refused ' + cause)); // flush JOIN_NO
  }
}

class HostRoom {
  // {swarm, matchId, code, keys:{priv,pub},
  //  identity:{manifest,gamedir,buildId,platform,binarySha},
  //  map: Buffer, maxPeers, clock, log, cbs:{onPeerUp,onPeerDown,onClData,onChat,onFatal}}
  constructor(opts) {
    Object.assign(this, opts);
    this.sessions = new Map(); // conn -> HostSession
    this.roster = [];          // accepted long-term pubkeys
    this.slotMap = new Map();  // pubkey hex -> live slot
    this.names = new Map();    // pubkey hex -> name (from JOIN, display only)
    this.lockouts = new Map(); // noise-key hex -> reason (bounded below)
    this.epoch = opts.epochStart ?? 0n;
    this.refreshH = null;
    this.timeouts = { keyBindMs: 5000, joinMs: 10000, pingMs: 2000, deadMs: 6000,
      refreshMs: 25000 }; // §6.5: host cadence must stay under the client staleness bound
    this.nonceBuf = () => {
      const b = Buffer.alloc(4); b.writeUInt32LE(this.clock.now() >>> 0, 0); return b;
    };
  }
  firewall = (peerKey) => this.lockouts.has(peerKey.toString('hex'));
  lockout(peerKey, why) {
    const k = Buffer.from(peerKey).toString('hex');
    if (!this.lockouts.has(k) && this.lockouts.size >= 256)
      this.lockouts.delete(this.lockouts.keys().next().value); // evict oldest, never wipe
    this.lockouts.set(k, why);
  }
  peerCount() { return this.roster.length; }
  hasMember(pub) { return this.roster.some((r) => r.equals(pub)); }
  allocSlot(pub) {
    const used = new Set(this.slotMap.values());
    let slot = 0;
    while (slot < 256 && used.has(slot)) slot++;
    if (slot === 256) return null;
    this.roster.push(Buffer.from(pub));
    this.slotMap.set(pub.toString('hex'), slot);
    return slot;
  }
  dropFromRoster(session) {
    if (!session.joined || !session.bound) return;
    const i = this.roster.findIndex((r) => r.equals(session.bound));
    session.joined = false;
    if (i >= 0) {
      this.roster.splice(i, 1);
      this.slotMap.delete(session.bound.toString('hex'));
      this.names.delete(session.bound.toString('hex'));
      this.cbs.onPeerDown(session.bound, 0);
      this.broadcastRoster();
    }
  }
  rosterHash() {
    return require('node:crypto').createHash('sha256')
      .update(this.roster.map((r) => r.toString('hex')).join('')).digest();
  }
  mapTag() { return Buffer.from(this.map); }
  sessionClosed(session, why) {
    this.sessions.delete(session.conn);
    this.dropFromRoster(session);
    this.log('host: connection closed (' + why + ')');
    if (this.peerCount() === 0) this.cbs.onEmpty();
  }
  accept(conn) {
    let unbound = 0;
    for (const s of this.sessions.values()) if (!s.bound) unbound++;
    if (unbound >= 4 || this.sessions.size >= this.maxPeers + 4) {
      conn.destroy(); // §6.1 pre-auth connection cap
      return;
    }
    const s = new HostSession(this, conn);
    this.sessions.set(conn, s);
    s.start();
    this.armRefresh();
  }
  armRefresh() {
    if (this.refreshH) return;
    this.refreshH = this.clock.setTimeout(() => {
      this.refreshH = null;
      if (this.sessions.size === 0) return; // nobody to refresh for
      this.broadcastRoster();
      this.armRefresh();
    }, this.timeouts.refreshMs);
  }
  broadcastRoster() {
    this.epoch += 1n;
    this.epochSave(this.epoch);
    const epochBuf = Buffer.alloc(8);
    epochBuf.writeBigUInt64LE(this.epoch);
    for (const [conn, s] of this.sessions) {
      if (!s.joined || s.dead) continue;
      s.send(E.TYPES.ROSTER, [[1, Buffer.concat([Buffer.from([this.roster.length]), ...this.roster])],
        [2, Buffer.from([this.minVersion.major])], [3, Buffer.from([this.minVersion.minor])],
        [4, epochBuf], [5, Buffer.from(this.keys.pub)]]);
    }
  }
  relayToClients(body, target) {
    // Host is the sole RELAY source for clients (§3.4a); origin is the host
    // key, target is the slot's bound peer: one frame, one recipient.
    if (!target || target.length !== 32) return; // targeted delivery only
    for (const s of this.sessions.values()) {
      if (!s.joined || s.dead) continue;
      if (!s.bound || !s.bound.equals(target)) continue;
      s.send(E.TYPES.RELAY, [[1, Buffer.from(this.keys.pub)], [2, body]]);
    }
  }
}

// ---------------- client ----------------
class ClientSession extends Session {
  constructor(room, conn) { super(room, conn, 'client'); }
  start() {
    super.start(() => this.sendBind());
  }
  afterBind() {
    const room = this.room;
    const idleKill = () => { if (room.hostLane !== this) this.close('non-lane idle'); };
    if (room.hostLane && room.hostLane !== this) {
      // A second bound peer in a star topology: idle for now, never idle forever.
      this.schedule(room.timeouts.idleMs, idleKill);
      return;
    }
    if (room.pinned) {
      // not our host: stay silent (no proof leaves), and don't linger forever
      if (!this.bound.equals(room.pinned)) { this.schedule(room.timeouts.idleMs, idleKill); return; }
      room.hostLane = this;
    } else {
      if (room.hostLane) return; // already have one
      room.hostLane = this;
      room.warnOpenInvite();
    }
    this.joinTimer = this.schedule(room.timeouts.joinOkMs, () => this.close('join-ack timeout'));
    const proof = R.proofOf(room.code, room.keys.pub);
    this.send(E.TYPES.JOIN, [[1, Buffer.from(room.keys.pub)],
      [2, Buffer.from(proof)], [3, Buffer.from(room.name)],
      [4, Buffer.from([E.MAJOR])], [5, Buffer.from([E.MINOR])],
      [6, Buffer.from(room.identity.manifest)],
      [7, Buffer.from(room.identity.gamedir)],
      [10, Buffer.from(room.identity.buildId)],
      [11, Buffer.from(room.identity.platform)],
      [12, Buffer.from(room.identity.binarySha)]]);
  }
  onBoundEnvelope(raw) {
    const { env, replayed } = inbound(raw, this.bound, this.win, this.room.matchId);
    if (replayed) { this.room.cbs.onReplay(); return; } // counted, never executed
    if (hasIllegalTags(env)) {
      if (++this.unknownRun > 10) throw new E.EnvelopeError('drop storm (§3.4b)');
      return;
    }
    const hostLane = this.room.hostLane === this;
    if ((env.type === E.TYPES.JOIN_OK || env.type === E.TYPES.ROSTER ||
         env.type === E.TYPES.RELAY) && !hostLane) {
      // Host-signed traffic only ever rides the host lane (§3.4a).
      this.room.cbs.onRogueClosed();
      return this.close('host-signed off the host lane');
    }
    switch (env.type) {
      case E.TYPES.JOIN_OK: {
        checkTagSizes(env);
        const t = tagMap(env.payload, [1, 2, 3, 6, 7, 9, 10, 11, 12]);
        if (!t.get(9).equals(this.bound)) throw new E.EnvelopeError('host key claim != bound key');
        if (this.room.pinned && !this.bound.equals(this.room.pinned))
          throw new E.EnvelopeError('bound key != pinned host key');
        // §3.4a: host platform/binary_sha are info-only; never compared.
        if (!t.get(6).equals(this.room.identity.manifest) ||
            !t.get(7).equals(this.room.identity.gamedir) ||
            !t.get(10).equals(this.room.identity.buildId))
          throw new E.EnvelopeError('host assets differ from this install (§3.4a)');
        this.unknownRun = 0;
        this.room.clock.clearTimeout(this.joinTimer);
        this.room.joined = true;
        this.room.slot = t.get(3)[0];
        this.room.lastRosterAt = this.room.clock.now(); // §6.5 staleness baseline
        this.room.armRosterWatch();
        this.room.cbs.onJoined({ slot: t.get(3)[0], map: Buffer.from(t.get(2)),
          hostKey: Buffer.from(t.get(9)),
          hostPlatform: Buffer.from(t.get(11)), hostBinarySha: Buffer.from(t.get(12)) });
        return;
      }
      case E.TYPES.JOIN_NO: {
        checkTagSizes(env);
        const cause = tagMap(env.payload, [1]).get(1)[0];
        this.room.cbs.onRefused(cause);
        return this.close('refused ' + cause);
      }
      case E.TYPES.ROSTER: {
        checkTagSizes(env);
        const t = tagMap(env.payload, [1, 2, 3, 4, 5]);
        if (!t.get(5).equals(this.bound)) throw new E.EnvelopeError('roster host key claim != bound key');
        if (this.room.pinned && !this.bound.equals(this.room.pinned))
          throw new E.EnvelopeError('roster from a non-pinned key');
        const epoch = t.get(4).readBigUInt64LE(0);
        if (epoch <= this.room.epoch) throw new E.EnvelopeError('roster epoch regression (§3.4a)');
        this.room.epoch = epoch;
        this.room.epochSave(epoch);
        this.room.lastRosterAt = this.room.clock.now();
        this.unknownRun = 0;
        const n = t.get(1)[0];
        const members = [];
        for (let i = 0; i < n; i++) members.push(t.get(1).subarray(1 + i * 32, 33 + i * 32));
        this.room.members = members;
        this.room.cbs.onRoster(members, epoch);
        return;
      }
      case E.TYPES.RELAY: {
        checkTagSizes(env);
        const t = tagMap(env.payload, [1, 2]);
        const origin = t.get(1);
        const isHost = origin.equals(this.bound);
        const isMember = this.room.members.some((m) => m.equals(origin));
        if (!isHost && !isMember) throw new E.EnvelopeError('relay origin not in host+roster');
        this.room.cbs.onSvData(origin, t.get(2));
        return;
      }
      case E.TYPES.CHAT:
        checkTagSizes(env);
        this.room.cbs.onChat(this.bound, tagMap(env.payload, [1]).get(1));
        return;
      case E.TYPES.BYE:
        this.room.cbs.onBye(this.bound);
        return;
      case E.TYPES.PING:
        checkTagSizes(env);
        this.send(E.TYPES.PONG, [[1, tagMap(env.payload, [1]).get(1)]]);
        return;
      case E.TYPES.PONG:
        return;
      default:
        this.unknownRun++;
        if (this.unknownRun > 10) throw new E.EnvelopeError('drop storm (§3.4b)');
    }
  }
}

class ClientRoom {
  // {swarm, matchId, code, keys:{priv,pub},
  //  identity:{manifest,gamedir,buildId,platform,binarySha},
  //  name, pinned|null, clock, log, cbs:{onJoined,onRefused,onRoster,onSvData,
  //  onChat,onBye,onHostLaneLost,onReplay,onRogueClosed,onFatal}}
  constructor(opts) {
    Object.assign(this, opts);
    this.sessions = new Map();
    this.hostLane = null;
    this.joined = false;
    this.slot = null;
    this.members = []; // current signed roster (RELAY origin set)
    this.epoch = opts.epochStart ?? -1n;
    this.maxSessions = opts.maxSessions ?? 12; // star needs one lane; the rest is noise
    this.timeouts = { keyBindMs: 5000, joinOkMs: 10000, pingMs: 2000, deadMs: 6000,
      idleMs: 15000, rosterMs: 30000 }; // §6.5 (+ non-lane idle bound)
    this.lastRosterAt = 0;
    this.rosterWatch = null;
    this.nonceBuf = () => {
      const b = Buffer.alloc(4); b.writeUInt32LE(this.clock.now() >>> 0, 0); return b;
    };
    this.openInviteWarned = false;
  }
  warnOpenInvite() {
    if (this.openInviteWarned) return;
    this.openInviteWarned = true;
    this.log('client: open-invite join — host impersonation not detectable on this lane');
  }
  accept(conn) {
    // Remote-fed connection count must stay bounded (§6.1 shape): the star
    // needs exactly the host lane, so anything past a small headroom is
    // discovery noise or an overhearing announcer — capped, never accumulated.
    if (this.sessions.size >= this.maxSessions) { conn.destroy(); return; }
    const s = new ClientSession(this, conn);
    this.sessions.set(conn, s);
    s.start();
  }
  armRosterWatch() {
    if (this.rosterWatch !== null) return;
    const step = () => {
      this.rosterWatch = null;
      if (!this.joined || !this.hostLane) return; // lane teardown owns that path
      if (this.clock.now() - this.lastRosterAt > this.timeouts.rosterMs) {
        this.cbs.onFatal(4); // §6.5: a host silent past the refresh bound is a dead host
        return;
      }
      this.armRosterWatch();
    };
    this.rosterWatch = this.clock.setTimeout(step, 5000);
  }
  sessionClosed(session, why) {
    this.sessions.delete(session.conn);
    this.log('client: connection closed (' + why + ')');
    if (this.hostLane === session) {
      this.hostLane = null;
      if (this.joined && !this.closing) this.cbs.onHostLaneLost();
    }
  }
  sendClientCmd(body) {
    if (!this.hostLane || !this.joined) return false;
    this.hostLane.send(E.TYPES.RELAY, [[1, Buffer.from(this.keys.pub)], [2, body]]);
    return true;
  }
}

module.exports = {
  TAG_SIZES, tagMap, checkTagSizes, isPrintable, inbound,
  realClock, Session, HostSession, HostRoom, ClientSession, ClientRoom,
};
