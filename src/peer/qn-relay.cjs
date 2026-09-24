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

/* makeRelayNode({ bootstrap }) -> { publicKey, stats, close }
 * stats mirrors the blind-relay counters the test lanes assert against:
 * { sessions, pairings, streams } plus the counts this glue enforces. */
async function makeRelayNode({ bootstrap, idleMs = IDLE_MS, sweepMs = 1000 }) {
  const loopback = bootstrap.every((b) => /^127\.|^::1$|^\[::1\]$/.test(b.host));
  const dht = new DHT({
    bootstrap,
    ephemeral: false,
    firewalled: false,
    ...(loopback ? { host: '127.0.0.1' } : {})
  });
  await dht.fullyBootstrapped();

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
    /* Pre-admission caps: accept() starts protomux on the (Noise-verified,
     * but anyone-can-mint-a-keypair) connection. These counters bound
     * ADMISSION only -- blind-relay's wire protocol lets one accepted
     * session stream raw pair frames, so pending fan-out and even matched
     * actives are bounded by the sweep below (blind-relay index.js
     * _onpair/_onclose). */
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
    conn.on('error', () => {});
    session.on('error', () => {});
    session._qnAdmittedAt = Date.now();
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
  await server.listen();

  return {
    publicKey: dht.defaultKeyPair.publicKey,
    get stats() {
      return { ...JSON.parse(JSON.stringify(relay.stats)), refused, dropped };
    },
    async close() {
      clearInterval(sweep);
      await server.close();
      await relay.close();
      await dht.destroy();
    }
  };
}

module.exports = { makeRelayNode, parseBootstrap, MAX_SESSIONS, MAX_ACTIVE_PAIRINGS,
  MAX_PAIRS_PER_SESSION, MAX_PENDING, IDLE_MS };

if (require.main === module) {
  const bootstrap = parseBootstrap(process.env.QN_DHT_BOOTSTRAP
    || (process.argv[2] || '').replace(/^--bootstrap=/, '') || null);
  if (!bootstrap) {
    process.stderr.write('usage: qn-relay.cjs --bootstrap=host:port[,host:port] (or QN_DHT_BOOTSTRAP)\n');
    process.exit(2);
  }
  makeRelayNode({ bootstrap }).then((node) => {
    process.stdout.write('RELAY-READY ' + node.publicKey.toString('hex') + '\n');
    setInterval(() => {
      const s = node.stats;
      process.stdout.write('RELAY-STATS sessions=' + s.sessions.accepted +
        ' pairings-active=' + s.pairings.active +
        ' pairings-pending=' + s.pairings.pending +
        ' streams-opened=' + s.streams.opened +
        ' refused=' + s.refused + ' dropped=' + s.dropped + '\n');
    }, 30000).unref();
  }).catch(() => {
    process.stderr.write('qn-relay: failed to start, exiting fail-closed\n');
    process.exit(1);
  });
}
