#!/usr/bin/env node
'use strict';
/* qn-relay.cjs — the blind relay node. A relay sits inside the Noise
 * encrypted transport (hyperdht dials it like any peer and pipes the two
 * half-connections together), so it sees ciphertext and flow metadata —
 * addresses, stream ids, sizes, timing — never match contents. It is an
 * AVAILABILITY dependency only: a hostile or failing relay can stall or
 * drop a relayed connection but cannot read or forge plane B envelopes
 * (Noise + envelope signatures are end-to-end) and cannot impersonate
 * either side.
 *
 * Peers name relays out of band (QN_RELAY_THROUGH): the relay's 32-byte
 * DHT public key travels inside each side's encrypted handshake, and each
 * side then dials the relay itself and pairs the two legs by a random
 * bearer token. The token is never announced: it rides the handshake.
 *
 * blind-relay (the pairing engine) enforces no limits of its own, so the
 * caps below live in this glue: a relay is operator-run and must not
 * become a session sink. */

const DHT = require('hyperdht');
const { Server: BlindRelayServer } = require('blind-relay');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_SESSIONS = 64;   /* concurrent relayed half-connections accepted */
const MAX_ACTIVE_PAIRINGS = 32; /* paired (traffic-carrying) sessions */
const MAX_PAIRS_PER_SESSION = 8; /* pending+matched pairing entries from one half-connection */
const MAX_PENDING = 128;   /* unpaired first-leg entries, whole relay */
const IDLE_MS = 30000;     /* never-pairing half-connections are reaped after this */

function parseBootstrap(raw) {
  if (!raw || !raw.trim()) return null;
  const list = [];
  for (const part of raw.split(',')) {
    const m = /^([A-Za-z0-9._\-:[\]]+):(\d{1,5})$/.exec(part.trim());
    const port = m ? Number(m[2]) : 0;
    if (!m || port < 1 || port > 65535) {
      process.stderr.write('qn-relay: bootstrap malformed (want host:port[,host:port...])\n');
      return null;
    }
    let host = m[1];
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // dns.lookup rejects brackets
    list.push({ host, port });
  }
  return list;
}

/* The pinned RELAY-READY key friends configure in QN_RELAY_THROUGH is this
 * node's DHT identity; hyperdht mints a fresh keyPair per boot unless given
 * a seed, so the seed must persist or every restart silently rots the
 * operator's published key (same 0600 discipline as the player identity
 * key: loose modes are refused, never repaired silently). */
function relaySeedPath() {
  const base = process.env.QN_RELAY_STATE_DIR
    || (process.env.XDG_STATE_HOME
      ? path.join(process.env.XDG_STATE_HOME, 'p2pquake-relay')
      : path.join(os.homedir(), '.p2pquake-relay'));
  return path.join(base, 'relay.seed');
}

function loadOrCreateSeed(p) {
  let missing = false;
  try {
    const st = fs.statSync(p);
    if (st.mode & 0o077) throw new Error('relay seed mode too loose (need 0600): ' + p);
    const seed = fs.readFileSync(p);
    if (seed.length !== 32) throw new Error('relay seed must be 32 bytes: ' + p);
    return seed;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    missing = true;
  }
  if (!missing) return loadOrCreateSeed(p); // TOCTOU: lost between stat and read
  const seed = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = p + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, seed, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    if (e.code === 'EEXIST') return loadOrCreateSeed(p); // racer won; take theirs
    throw e;
  }
  return seed;
}

/* makeRelayNode({ bootstrap[, seedPath] }) -> { publicKey, stats, close }
 * stats mirrors the blind-relay counters the test lanes assert against:
 * { sessions, pairings, streams } plus the counts this glue enforces.
 * seedPath persists the DHT identity across restarts (see above). */
async function makeRelayNode({ bootstrap, idleMs = IDLE_MS, sweepMs = 1000, seedPath = null,
  port = 49737, anyPort = true }) {
  const loopback = bootstrap.every((b) => /^127\.|^::1$|^\[::1\]$/.test(b.host));
  const dht = new DHT({
    bootstrap,
    ephemeral: false,
    firewalled: false,
    port, anyPort,
    ...(seedPath ? { seed: loadOrCreateSeed(seedPath) } : {}),
    ...(loopback ? { host: '127.0.0.1' } : {})
  });
  try { await dht.fullyBootstrapped(); }
  catch (error) {
    // dht-rpc's destroy awaits the failed bind and can throw before closing
    // its native interface watcher. Retire that handle and preserve the
    // original startup error (covered by the occupied-port regression).
    try { await dht.destroy(); } catch { /* failed bind */ }
    dht.io.networkInterfaces.destroy();
    throw error;
  }

  let refused = 0;
  const relay = new BlindRelayServer({
    createStream({ firewall }) {
      /* Legs are the node's own tracked raw streams: each peer's raw
       * stream is told to connect to (this node's socket, this leg's
       * stream id, port, host) once pairing completes — the same
       * construction hyperdht uses for holepunched raw streams
       * (lib/server.js, lib/connect.js). */
      return dht.createRawStream({ framed: true, firewall });
    }
  });

  let dropped = 0;
  const server = dht.createServer((conn) => {
    // Rejected transports may also emit errors while closing.
    conn.on('error', () => {});
    /* Pre-admission caps: accept() starts protomux on the (Noise-verified,
     * but anyone-can-mint-a-keypair) connection. These counters bound
     * ADMISSION only -- blind-relay's wire protocol lets one accepted
     * session stream raw pair frames, so pair admission below also checks
     * the caps before allocating any raw streams. */
    let active = 0;
    for (const _s of relay.sessions) active++;
    if (active >= MAX_SESSIONS || relay.stats.pairings.active >= MAX_ACTIVE_PAIRINGS ||
        relay.stats.pairings.pending >= MAX_PENDING) {
      refused++;
      conn.destroy();
      return;
    }
    /* Channel id must equal the dialer's key: that is the id hyperdht's
     * relay Client opens the 'blind-relay' protomux channel with
     * (lib/connect.js:811, lib/server.js:684). A null id never matches,
     * the channel never opens, and _onpair never fires
     * (hyperdht test/relaying.js). */
    const session = relay.accept(conn, { id: conn.remotePublicKey });
    /* A half-vanished leg surfaces as an 'error' on the blind-relay session
     * (index.js:105-107 _onerror emits it; hyperdht's own relay test attaches
     * the same listeners). Unhandled EventEmitter 'error' would crash the
     * node; teardown itself is blind-relay's close path plus the sweep. */
    session.on('error', () => {});
    session.once('close', () => conn.destroy());
    session._qnAdmittedAt = Date.now();
    /* blind-relay 1.6.1 exposes no pair admission hook. Guard its Protomux
     * handler before it allocates streams; sweeps alone permit unbounded
     * bursts and admission-only caps miss already-connected clients.
     * These private fields are version-pinned and exercised by real-wire
     * tests. Re-audit this adapter when upgrading blind-relay. */
    const pair = session._pair.onmessage;
    session._pair.onmessage = (message) => {
      if (session.closed) return;
      const key = message.token.toString('hex');
      const pending = relay._pairing.get(key);
      if (pending && pending.links[+message.isInitiator]) return; // duplicate leg
      // The library counts active pairings by token, so reusing a live token
      // across different sessions would otherwise undercount raw streams.
      if ((!pending && relay._activePairingRefs.has(key)) || session._links.has(key) ||
          session._links.size + session._pairing.size >= MAX_PAIRS_PER_SESSION ||
          (!pending && relay.stats.pairings.pending >= MAX_PENDING) ||
          (pending && relay.stats.pairings.active >= MAX_ACTIVE_PAIRINGS)) {
        refused++;
        session.destroy();
        return;
      }
      return pair(message);
    };
  });
  const sweep = setInterval(() => {
    const now = Date.now();
    const overrun = relay.stats.pairings.pending > MAX_PENDING;
    for (const s of relay.sessions) {
      const links = s._links.size;
      const pending = s._pairing.size;
      const idle = links === 0 && now - s._qnAdmittedAt > idleMs;
      const over = pending + links > MAX_PAIRS_PER_SESSION;
      const offender = overrun && pending > 0 && links === 0;
      if (idle || over || offender) {
        try { s.destroy(); dropped++; } catch (e) { /* next tick retries */ }
      }
    }
  }, sweepMs);
  sweep.unref();
  try { await server.listen(); }
  catch (error) {
    clearInterval(sweep);
    await dht.destroy();
    throw error;
  }

  return {
    publicKey: dht.defaultKeyPair.publicKey,
    address: dht.address(),
    get stats() {
      return { ...JSON.parse(JSON.stringify(relay.stats)), refused, dropped };
    },
    async close() {
      clearInterval(sweep);
      // end() waits for pending pairings; explicitly retire them on stop.
      for (const session of relay.sessions) session.destroy();
      await server.close();
      await relay.close();
      await dht.destroy();
    }
  };
}

module.exports = { makeRelayNode, parseBootstrap, loadOrCreateSeed, relaySeedPath,
  MAX_SESSIONS, MAX_ACTIVE_PAIRINGS,
  MAX_PAIRS_PER_SESSION, MAX_PENDING, IDLE_MS };

if (require.main === module) {
  const bootstrap = parseBootstrap(process.env.QN_DHT_BOOTSTRAP
    || (process.argv[2] || '').replace(/^--bootstrap=/, '') || null);
  if (!bootstrap) {
    process.stderr.write('usage: qn-relay.cjs --bootstrap=host:port[,host:port] '
      + '(or QN_DHT_BOOTSTRAP) [--state=seedfile] (or QN_RELAY_STATE)\n');
    process.exit(2);
  }
  const stateArg = (process.argv.slice(3).find((a) => a.startsWith('--state=')) || '')
    .replace(/^--state=/, '');
  const seedPath = stateArg || process.env.QN_RELAY_STATE || relaySeedPath();
  const port = Number(process.env.QN_RELAY_PORT || 49737);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write('qn-relay: QN_RELAY_PORT must be 1..65535\n');
    process.exit(2);
  }
  // A service's firewall opens this port; silently falling back to a random
  // port makes RELAY-READY misleading. Library callers retain testnet defaults.
  makeRelayNode({ bootstrap, seedPath, port, anyPort: false }).then((node) => {
    process.stdout.write('RELAY-READY ' + node.publicKey.toString('hex') + '\n');
    process.stdout.write('RELAY-LISTEN udp=' + node.address.port + '\n');
    const statsTimer = setInterval(() => {
      const s = node.stats;
      process.stdout.write('RELAY-STATS sessions-active=' + s.sessions.active +
        ' sessions-accepted=' + s.sessions.accepted +
        ' pairings-active=' + s.pairings.active +
        ' pairings-pending=' + s.pairings.pending +
        ' streams-opened=' + s.streams.opened +
        ' refused=' + s.refused + ' dropped=' + s.dropped + '\n');
    }, 30000).unref();
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearInterval(statsTimer);
      const deadline = setTimeout(() => process.exit(1), 10000);
      node.close().then(() => { clearTimeout(deadline); process.exit(0); },
        () => { clearTimeout(deadline); process.exit(1); });
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }).catch(() => {
    process.stderr.write('qn-relay: failed to start, exiting fail-closed\n');
    process.exit(1);
  });
}
