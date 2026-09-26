'use strict';
// Daemon-side public lobby machinery (spec §3.6). Host role: serve the
// signed advert, re-signed with epoch++ on every publish and on the
// 60 s cadence (ROSTER precedent: monotonic, persisted, never restarted).
// Viewer role: discover topic peers, fetch-verify-collect adverts, and
// push LOBBY_LIST snapshots (one advert per frame, empty-payload
// terminator, §3.6) to the engine. Clock and swarmFactory are injected:
// the node suite drives both roles over fakes, the loopback lane over
// real hyperswarm.

const crypto = require('node:crypto');
const F = require('./qn_frame.cjs');
const L = require('./qn_lobby.cjs');

const LOBBY_TOPIC_NAME = 'qn-lobby-v1';
const LOBBY_TOPIC = crypto.createHash('sha256').update(LOBBY_TOPIC_NAME, 'utf8').digest();
const ANNOUNCE_MS = 60000;    // re-sign cadence, well inside the 120 s ttl
const SNAPSHOT_MS = 30000;    // §3.6 snapshot + rediscovery cadence
const FETCH_MS = 5000;        // per-connection fetch deadline
const INGEST_PER_S = 50;      // DHT-ingest meter: verification is the cost gate

function announceFields(payload) {
  let fields;
  try {
    fields = F.decodeTLV(payload);
  } catch (e) {
    throw new L.LobbyError('announce tlv: ' + e.message);
  }
  const m = new Map();
  for (const f of fields) {
    if (m.has(f.tag)) throw new L.LobbyError('announce: duplicate tag');
    m.set(f.tag, f.value);
  }
  for (const want of [0x01, 0x02, 0x03, 0x04])
    if (!m.has(want)) throw new L.LobbyError('announce: missing tag');
  const map = m.get(0x01).toString('latin1');
  const title = m.get(0x02).toString('latin1');
  const mp = m.get(0x03);
  const md = m.get(0x04);
  if (!/^[\x20-\x7e]{1,16}$/.test(map)) throw new L.LobbyError('announce: map');
  if (!/^[\x20-\x7e]{1,20}$/.test(title)) throw new L.LobbyError('announce: title');
  if (mp.length !== 1 || mp[0] < 2 || mp[0] > 8) throw new L.LobbyError('announce: maxp');
  if (md.length !== 1 || md[0] > 1) throw new L.LobbyError('announce: mode');
  return { map, title, maxPlayers: mp[0], mode: md[0] };
}

// swarmFactory(topic, { server }) -> EventEmitter emitting 'connection'
// with a duplex per remote, and exposing destroy(). Real: a makeSwarm()
// hyperswarm; tests: fakes.
function makeHostLobby(o) {
  // o: { keys, epochs, clock, swarmFactory, version, minVersion, getCode, log }
  const matchHex = LOBBY_TOPIC.toString('hex');
  const subjectHex = o.keys.pub.toString('hex');
  let advert = null, lastReq = null, swarm = null, pend = null, cadence = null;
  let lastPublish = -Infinity;

  const serve = (conn) => {
    conn.once('error', () => { try { conn.destroy(); } catch { /* gone */ } });
    if (!advert) { try { conn.destroy(); } catch { /* gone */ } return; }
    const h = Buffer.alloc(2);
    h.writeUInt16LE(advert.length, 0);
    try { conn.write(Buffer.concat([h, advert])); conn.end(); } catch { /* gone */ }
  };

  const ensureSwarm = () => {
    if (swarm) return;
    swarm = o.swarmFactory(LOBBY_TOPIC, { server: true });
    swarm.on('connection', serve);
  };

  const publish = () => {
    pend = null;
    if (!lastReq) return;
    const code = o.getCode();
    if (!Buffer.isBuffer(code) || code.length !== 10) {
      o.log('lobby: announce without room code, dropped');
      return;
    }
    const loaded = o.epochs.load(subjectHex, matchHex);
    const base = loaded < 0n ? 0n : loaded;
    const epoch = base + 1n;
    advert = L.encodeAdvert({
      map: lastReq.map, title: lastReq.title,
      maxPlayers: lastReq.maxPlayers, mode: lastReq.mode,
      code, pubkey: o.keys.pub,
      version: o.version, minVersion: o.minVersion, epoch,
    }, o.keys.priv);
    o.epochs.save(subjectHex, matchHex, epoch);
    lastPublish = o.clock.now();
    ensureSwarm();
    o.log('lobby: announced');
    if (!cadence) cadence = o.clock.setTimeout(tick, ANNOUNCE_MS);
  };

  const tick = () => {
    cadence = null;
    if (!lastReq) return;
    publish();
    if (advert) cadence = o.clock.setTimeout(tick, ANNOUNCE_MS);
  };

  return {
    onAnnounce(payload) {
      lastReq = announceFields(payload);            // throws: caller drops the frame
      const wait = L.REANNOUNCE_MIN_MS - (o.clock.now() - lastPublish);
      if (wait <= 0) publish();                     // reads lastReq at fire: latest wins
      else if (!pend) pend = o.clock.setTimeout(publish, wait);
    },
    onWithdraw() {
      advert = null;
      lastReq = null;
      if (pend) { o.clock.clearTimeout(pend); pend = null; }
      if (cadence) { o.clock.clearTimeout(cadence); cadence = null; }
      if (swarm) { try { swarm.destroy(); } catch { /* best-effort */ } swarm = null; }
      o.log('lobby: withdrawn');
    },
    serve,
    get advert() { return advert; },
  };
}

function makeViewerLobby(o) {
  // o: { clock, swarmFactory, send, log } — send(type, payload) writes Plane A.
  let store = new L.AdvertStore();
  let swarm = null, timer = null, dirty = false;
  let bucketAt = -Infinity, bucketN = 0;

  const metered = () => {
    const t = o.clock.now();
    if (t - bucketAt >= 1000) { bucketAt = t; bucketN = 0; }
    return ++bucketN <= INGEST_PER_S;
  };

  const snapshot = () => {
    dirty = false;
    for (const e of store.live(o.clock.now())) o.send(F.TYPES.LOBBY_LIST, e.buf);
    o.send(F.TYPES.LOBBY_LIST, Buffer.alloc(0));    // terminator (§3.6)
  };

  const markDirty = () => {
    if (dirty) return;
    dirty = true;
    o.clock.setTimeout(() => { if (dirty && timer) snapshot(); }, 10);
  };

  const fetch = (conn) => {
    if (!timer) { try { conn.destroy(); } catch { /* gone */ } return; }   // stopped mid-flight
    let buf = Buffer.alloc(0);
    let need = -1;
    let done = false;
    const kill = () => {
      if (done) return;
      done = true;
      o.clock.clearTimeout(deadline);
      try { conn.destroy(); } catch { /* gone */ }
    };
    const deadline = o.clock.setTimeout(kill, FETCH_MS);
    conn.on('data', (c) => {
      if (done) return;
      buf = Buffer.concat([buf, c]);
      if (buf.length > 2 + L.ADVERT_MAX) return kill();
      if (need < 0) {
        if (buf.length < 2) return;
        need = 2 + buf.readUInt16LE(0);
        if (need > 2 + L.ADVERT_MAX) return kill();
      }
      if (buf.length < need) return;
      if (buf.length !== need) return kill();       // strict: no trailing slop
      const raw = buf.subarray(2, need);
      try {
        const adv = L.decodeAdvert(raw);
        if (metered() && store.apply(adv, raw, o.clock.now()) === 'stored') markDirty();
      } catch { /* invalid adverts drop silently (§3.6) */ }
      kill();
    });
    conn.once('error', kill);
    conn.once('close', kill);
  };

  const rejoin = () => {
    if (swarm) { try { swarm.destroy(); } catch { /* best-effort */ } }
    swarm = o.swarmFactory(LOBBY_TOPIC, { server: false });
    swarm.on('connection', fetch);
  };

  return {
    start() {
      if (timer) return;
      rejoin();
      snapshot();                                   // empty swap: viewer starts from nothing
      timer = o.clock.setTimeout(refresh, SNAPSHOT_MS);
    },
    stop() {
      if (timer) { o.clock.clearTimeout(timer); timer = null; }
      if (swarm) { try { swarm.destroy(); } catch { /* best-effort */ } swarm = null; }
      store = new L.AdvertStore();
    },
    fetch,
    snapshot,
    get store() { return store; },
    get live() { return store.live(o.clock.now()); },
  };

  function refresh() {
    timer = null;
    rejoin();                                       // fresh peer set: present hosts resurface
    snapshot();
    timer = o.clock.setTimeout(refresh, SNAPSHOT_MS);
  }
}

module.exports = {
  LOBBY_TOPIC, LOBBY_TOPIC_NAME, ANNOUNCE_MS, SNAPSHOT_MS, FETCH_MS, INGEST_PER_S,
  announceFields, makeHostLobby, makeViewerLobby,
};
