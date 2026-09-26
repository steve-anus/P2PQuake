'use strict';
// Loaded via `node --require` by qn-relayauto-launch.sh (make relayauto)
// into the real daemon. Simulates a symmetric/provider NAT: the INITIATOR
// hole-punch fails after a realistic timeout with the exact trigger code
// hyperswarm's relay fallback gate listens for (hyperswarm index.js:224-230,
// 670-677). The delay matters: a real punch fails slowly, so the direct
// handshake (which carries the relay pairing token, hyperdht
// lib/connect.js:100-101,534) wins the race and tells the responder to dial
// the relay -- an instant failure would destroy the socket before the
// handshake and simulate nothing real. Non-initiator punchers are untouched.
// Marks (QN_RELAYAUTO_MARK) drive the lane's vacuity gate.
const fs = require('node:fs');
const Holepuncher = require('hyperdht/lib/holepuncher');
const DHT = require('hyperdht');

const MARK = process.env.QN_RELAYAUTO_MARK || null;
const mark = (line) => { if (MARK) { try { fs.appendFileSync(MARK, line + '\n'); } catch (e) { /* test-only */ } } };
const PUNCH_FAIL_MS = Number(process.env.QN_RELAYAUTO_PUNCH_MS || 1200);

const origPunch = Holepuncher.prototype._punch;
Holepuncher.prototype._punch = function _punch() {
  if (!this.isInitiator) return origPunch.call(this);
  mark('punch-fail');
  return new Promise((_, reject) => {
    setTimeout(() => reject(Object.assign(
      new Error('lane: simulated symmetric NAT'), { code: 'CANNOT_HOLEPUNCH' })),
      PUNCH_FAIL_MS);
  });
};

const origConnect = DHT.prototype.connect;
const dials = new Map();
DHT.prototype.connect = function connect(publicKey, opts) {
  const pk = publicKey.toString('hex');
  const n = (dials.get(pk) || 0) + 1;
  dials.set(pk, n);
  mark((n === 1 ? 'dial ' : 'redial ') + pk.slice(0, 16) +
    (opts && opts.relayThrough ? ' relay' : ' direct'));
  return origConnect.call(this, publicKey, opts);
};
