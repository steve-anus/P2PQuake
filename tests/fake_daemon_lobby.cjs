#!/usr/bin/env node
'use strict';
/* fake_daemon_lobby.cjs — scripted Plane A daemon (spawned BY THE ENGINE
 * via -qn-peer) that streams public-lobby advert runs to the engine-side
 * LOBBY_LIST consumer. Runs are paced so the lane can assert the
 * QNLOBBY swap markers (QN_LOBBY_DUMP=1 lab knob) in engine stdout:
 * honest fields, mask-on-control-bytes (raw-signed to bypass the codec's
 * own validation, signature valid — the daemon is the trusted relayer
 * here), oversized and bad-width drops, an interrupted run (PING between
 * frames kills the swap), a poisoned 65-advert run, and a recovery run.
 * Exit codes: 0 done, 1 protocol violation, 2 bad token, 3 socket error. */

const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const F = require(path.join(__dirname, '..', 'src', 'peer', 'qn_frame.cjs'));
const E = require(path.join(__dirname, '..', 'src', 'peer', 'qn_envelope.cjs'));

const T = F.TYPES;
const LB = (n) => console.error(`LBSTEP ${n} ok`);
const fail = (why) => { console.log(`LBSTEP FAIL ${why}`); process.exit(1); };

const argv = process.argv.slice(2);
const ui = argv.indexOf('--uds');
if (ui < 0 || ui + 1 >= argv.length) fail('missing --uds');
const udsPath = argv[ui + 1];

function readToken() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => reject(new Error('token timeout')), 4000);
    process.stdin.on('data', (c) => {
      chunks.push(c); size += c.length;
      if (size > 32) { clearTimeout(timer); reject(new Error('token too long')); }
    });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    process.stdin.on('error', reject);
  });
}

const seed = crypto.randomBytes(32);
const priv = E.privateKeyFromSeed(seed);
const pub = Buffer.from(E.publicRaw(E.publicKeyFromSeed(seed)));

const rt = (tag, val) => {
  const h = Buffer.alloc(4);
  h.writeUInt16LE(tag, 0);
  h.writeUInt16LE(val.length, 2);
  return Buffer.concat([h, val]);
};
const ver = (a, b) => { const x = Buffer.alloc(4); x.writeUInt16LE(a, 0); x.writeUInt16LE(b, 2); return x; };
const epoch1 = () => { const b = Buffer.alloc(8); b.writeBigUInt64LE(1n, 0); return b; };
const ttl = () => { const b = Buffer.alloc(2); b.writeUInt16LE(120, 0); return b; };

function advertRaw(fields, sigKey) {
  const canonical = Buffer.concat([
    rt(0x01, Buffer.from(fields.map ?? 'lqdm1', 'latin1')),
    rt(0x02, Buffer.from(fields.title, 'latin1')),
    rt(0x03, fields.maxp ?? Buffer.from([fields.maxPlayers ?? 8])),
    rt(0x04, Buffer.from([fields.mode ?? 1])),
    rt(0x05, fields.code ?? Buffer.from('0000000000', 'latin1')),
    rt(0x06, fields.pubkey ?? pub),
    rt(0x07, fields.verRaw ?? ver(0, 2)),
    rt(0x08, fields.minVerRaw ?? ver(0, 2)),
    rt(0x09, fields.epochRaw ?? epoch1()),
    rt(0x0a, fields.ttlRaw ?? ttl()),
    rt(0x0b, fields.players ?? Buffer.from([Math.min(3, fields.maxPlayers ?? 8)])),
    ...(fields.extra ? fields.extra.map(([t, v]) => rt(t, v)) : []),
  ]);
  const digest = crypto.createHash('sha256')
    .update(Buffer.concat([Buffer.from('QNLA', 'latin1'), canonical])).digest();
  return Buffer.concat([canonical, E.signWith(sigKey ?? priv, digest)]);
}

async function main() {
  const token = await readToken();
  const sock = net.createConnection(udsPath);
  let seq = 1;
  const send = (type, payload = Buffer.alloc(0)) => sock.write(F.encodeFrame(type, seq++, payload));
  const at = (ms, fn) => setTimeout(() => { try { fn(); } catch (e) { fail('send: ' + e.message); } }, ms);

  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 4000);
  });
  sock.on('error', () => {});
  const reader = new F.FrameReader();
  let sawWatch = false;
  sock.on('data', (c) => {
    let frames;
    try { frames = reader.feed(c); } catch { return fail('malformed plane-A stream'); }
    for (const f of frames) {
      if (f.type === T.PING) { send(T.PONG, f.payload); continue; }
      if (f.type === T.LOBBY_WATCH && !sawWatch) { sawWatch = true; LB('watch observed'); }
    }
  });

  send(T.AUTH, token);
  LB('auth sent');

  const good = (title, map, maxPlayers) => advertRaw({ title, map, maxPlayers });

  at(300, () => { send(T.LOBBY_LIST, good('Alpha Room', 'lqdm1', 8)); send(T.LOBBY_LIST); LB('run1 honest'); });
  at(600, () => {
    send(T.LOBBY_LIST, good('Beta Room', 'lq_e1m1', 4));
    const tab = String.fromCharCode(9);
    const del = String.fromCharCode(127);
    send(T.LOBBY_LIST, good('Bad' + tab + 'Name' + del, 'evil map!', 6));
    send(T.LOBBY_LIST);
    LB('run2 mask');
  });
  at(900, () => {
    const big = advertRaw({ title: 'Oversize', map: 'lqdm1',
      extra: [[0x0fff, Buffer.alloc(1130, 0x41)]] });
    if (big.length <= 1200 || big.length > 2048) fail('oversize advert malformed: ' + big.length);
    send(T.LOBBY_LIST, big);                                   // over cap: refused whole
    send(T.LOBBY_LIST, advertRaw({ title: 'BadWidth', maxp: Buffer.from([8, 0]) }));
    send(T.LOBBY_LIST);
    LB('run3 all-bad swap');
  });
  at(1200, () => {
    send(T.LOBBY_LIST, good('Interrupted', 'lqdm1', 8));       // then a PING lands:
    send(T.PING, Buffer.from([0, 0, 0, 1]));                   // run dies (spec 3.6)
    send(T.LOBBY_LIST);
    LB('run4 interrupted');
  });
  at(1500, () => {
    for (let i = 0; i < 65; i++) send(T.LOBBY_LIST, good('F' + i, 'lqdm1', 8));
    send(T.LOBBY_LIST);
    LB('run5 poisoned');
  });
  at(1900, () => { send(T.LOBBY_LIST, good('Recovered', 'lqdm1', 8)); send(T.LOBBY_LIST); LB('run6 recovery'); });
  at(2600, () => { LB('script complete'); });
  sock.on('close', () => process.exit(0));
  setInterval(() => { try { send(T.PING, Buffer.from([0, 0, 0, 0])); } catch { /* dying */ } }, 1000).unref();
  setTimeout(() => fail('overall watchdog'), 20000);
}

main().catch((e) => fail(String(e && e.message || e)));
