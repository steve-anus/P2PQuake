#!/usr/bin/env node
'use strict';
/* qn-relay sweep enforcement tests. The caps exist because a relay is
 * operator-run and anyone who can mint a keypair may connect; so the
 * enforcement path is reachable by attackers and must be exercised here
 * (the two-player lane asserts dropped===0, which by itself never runs
 * the kill branch). Traffic proof for this file = the relay counters:
 * the relay process surviving an overrunning session IS the assertion —
 * a throw in the sweep callback takes this test process down with it. */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const DHT = require('hyperdht');
const createTestnet = require('hyperdht/testnet');
const { Client: BlindRelayClient } = require('blind-relay');
const { once } = require('node:events');
const { makeRelayNode, MAX_PAIRS_PER_SESSION } = require('../src/peer/qn-relay.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = (dht, key) => new Promise((res, rej) => {
  const c = dht.connect(key);            // event-style socket (index.js:89 —
  c.on('open', () => res(c));            // no callback arg), open/err events
  c.on('error', rej);
});

async function startTestnet() {
  for (let i = 0; i < 5; i++) {
    try { return await createTestnet(3, { port: 0 }); }
    catch (e) { if (!/EADDRINUSE|listen/.test(String(e && e.code || e))) throw e; }
  }
  throw new Error('no free port for the private testnet');
}

/* Pair frames are only reliably wired once the blind-relay channel has
 * opened: BlindRelayRequest._open fires on streamx nextTick and a send
 * racing the protomux open window is silently dropped (observed
 * requested=0). Await the client's 'open' before pairing. */
async function clientReady (client) {
  if (client._channel.opened !== true) await once(client, 'open');
}

function floodPair(client, isInitiator, tokens, baseId) {
  const reqs = [];
  for (let i = 0; i < tokens.length; i++) {
    // pair frames need only stream.id on the wire (blind-relay
    // BlindRelayRequest._open); the relay allocates its own legs.
    const req = client.pair(isInitiator, tokens[i], { id: baseId + i });
    // a 'data' listener is REQUIRED to start the request's streamx
    // auto-open (BlindRelayRequest._open sends the wire frame only once
    // the Readable flows — hyperdht does the same, connect.js:815)
    req.on('data', () => {});
    req.on('error', () => {}); // the sweep destroying the session errors
    req.on('close', () => {}); // in-flight requests: expected teardown noise
    reqs.push(req);
  }
  return reqs;
}

test('sweep caps matched-link fan-out and survives the kill', { timeout: 60000 }, async () => {
  const tnet = await startTestnet();
  const relay = await makeRelayNode({ bootstrap: tnet.bootstrap, idleMs: 5000, sweepMs: 200 });
  const attacker = new DHT({ bootstrap: tnet.bootstrap, port: 0 });
  const conns = [];
  try {
    await attacker.fullyBootstrapped();
    const a = await connect(attacker, relay.publicKey);
    const b = await connect(attacker, relay.publicKey);
    a.on('error', () => {}); b.on('error', () => {});
    conns.push(a, b);
    const ca = BlindRelayClient.from(a, { id: a.publicKey });
    const cb = BlindRelayClient.from(b, { id: b.publicKey });
    await Promise.all([clientReady(ca), clientReady(cb)]);
    // Self-pair across two sessions the attacker owns: both legs of each
    // token arrive, so _pairing stays at ~0 and _links grows past the cap
    // — a pending-only cap would never fire.
    const n = MAX_PAIRS_PER_SESSION + 2;
    const tokens = Array.from({ length: n }, () => crypto.randomBytes(32));
    floodPair(ca, true, tokens, 1000);
    floodPair(cb, false, tokens, 5000);
    await sleep(1500); // multiple sweep ticks
    const st = relay.stats;
    assert.ok(st.pairings.matched >= n, 'links formed: ' + JSON.stringify(st));
    assert.ok(st.dropped >= 2, 'overrunning sessions reaped: dropped=' + st.dropped);
    assert.ok(st.sessions.closed >= 2, 'closed=' + st.sessions.closed);
    assert.equal(st.pairings.pending, 0, 'reaped pairings must return to zero');
  } finally {
    for (const c of conns) { try { c.destroy(); } catch (e) { /* gone */ } }
    attacker.destroy();
    await relay.close();
    await tnet.destroy();
  }
});

test('idle sweep reaps a pending-holding squatter', { timeout: 60000 }, async () => {
  const tnet = await startTestnet();
  const relay = await makeRelayNode({ bootstrap: tnet.bootstrap, idleMs: 400, sweepMs: 100 });
  const attacker = new DHT({ bootstrap: tnet.bootstrap, port: 0 });
  const conns = [];
  try {
    await attacker.fullyBootstrapped();
    const a = await connect(attacker, relay.publicKey);
    a.on('error', () => {});
    conns.push(a);
    const ca = BlindRelayClient.from(a, { id: a.publicKey });
    await clientReady(ca);
    // One unfinished pairing (isInitiator only): _pairing stays non-empty
    // while _links stays 0 — the session (and its MAX_SESSIONS slot) must
    // still be reaped, not squat forever.
    floodPair(ca, true, [crypto.randomBytes(32)], 1000);
    await sleep(1200); // idleMs 400 + sweep headroom
    const st = relay.stats;
    assert.ok(st.dropped >= 1, 'squat reaped: dropped=' + st.dropped);
    assert.ok(st.sessions.closed >= 1, 'closed=' + st.sessions.closed);
  } finally {
    for (const c of conns) { try { c.destroy(); } catch (e) { /* gone */ } }
    attacker.destroy();
    await relay.close();
    await tnet.destroy();
  }
});
