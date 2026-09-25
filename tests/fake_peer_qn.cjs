#!/usr/bin/env node
'use strict';
/* fake_peer_qn.cjs — scripted stand-in for qn-peer on Plane A, spawned BY
 * THE ENGINE (via -qn-peer) for the loopback test: proves spawn,
 * token-on-stdin, AUTH gate, lane framing and virtual sockets without a
 * second machine or the DHT. Speaks the same frame grammar as
 * src/peer/qn-peer.cjs, reusing its codec module. Announces progress on
 * stderr as `LBSTEP <name> ok` lines (the engine inherits the child's
 * stderr into its own capture); tests/qn_loopback.cjs asserts the set.
 * Exit codes: 0 success, 1 protocol violation, 2 bad token, 3 socket
 * error, 4 watchdog. */

const net = require('node:net');
const path = require('node:path');
const F = require(path.join(__dirname, '..', 'src', 'peer', 'qn_frame.cjs'));

const T = F.TYPES;
const PLAYER_PUB = Buffer.alloc(32, 0x41);      /* the scripted player's identity */
const PROBE_PUB = Buffer.from(PLAYER_PUB);
PROBE_PUB[0] ^= 0xff;   /* a second identity: datagram-level replies only */
const HOST_CODE = Buffer.from([0x73, 0x79, 0x71, 0x7e, 0x76, 0x74, 0x72, 0x70, 0x6f, 0x6d]);

/* quake datagram layer constants (Quake/net_defs.h, net_dgrm.c) */
const LEN_MASK = 0x0000ffff;
const F_DATA = 0x00010000, F_ACK = 0x00020000, F_EOM = 0x00080000, F_CTL = 0x80000000, F_UNRELIABLE = 0x00100000;
const CCREQ_CONNECT = 0x01, CCREP_ACCEPT = 0x81;
const NET_PROTOCOL_VERSION = 3;
/* game layer (Quake/protocol.h) */
const clc_stringcmd = 4;
const SVC_SERVERINFO = 11, SVC_SIGNONNUM = 25, SVC_PRINT = 8;

const step = (n) => console.error(`LBSTEP ${n} ok`);
const fail = (why) => { console.error(`LBSTEP FAIL ${why}`); process.exit(1); };

function parseUds(argv) {
  const i = argv.indexOf('--uds');
  if (i < 0 || i + 1 >= argv.length) fail('missing --uds');
  return argv[i + 1];
}

/* read exactly the 32-byte AUTH token from stdin, then EOF (spec 4) */
function readToken() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => reject(new Error('token timeout')), 4000);
    process.stdin.on('data', (c) => { chunks.push(c); size += c.length;
      if (size > 32) { clearTimeout(timer); reject(new Error('token too long')); } });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    process.stdin.on('error', reject);
  });
}

function ctlPacket(payload) {
  const h = Buffer.alloc(4);
  /* >>> 0: NETFLAG_CTL is 0x80000000, and the bitwise OR signs the
   * value; writeUInt32BE needs the unsigned form */
  h.writeUInt32BE(((F_CTL | (payload.length + 4)) >>> 0), 0);
  return Buffer.concat([h, payload]);
}

function dataPacket(seq, payload, eom) {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(((payload.length + 8) | F_DATA | (eom ? F_EOM : 0)) >>> 0, 0);
  h.writeUInt32BE(seq >>> 0, 4);
  return Buffer.concat([h, payload]);
}

function stringCmd(s) {
  return Buffer.concat([Buffer.from([clc_stringcmd]), Buffer.from(s + '\0', 'latin1')]);
}

class Peer {
  constructor(sock) {
    this.sock = sock;
    this.pongs = 0;
    this.lastPongAt = Date.now();
    this.lastAckAt = Date.now();
    this.reader = new F.FrameReader();
    this.seq = 2;                     /* AUTH consumed seq 1 */
    this.state = 'await-host-up';
    this.sendSeq = 0;                 /* our qsocket sendSequence */
    this.recvSeq = 0;                 /* our qsocket receiveSequence */
    this.assembled = [];              /* reassembled host message bytes */
    this.pending = null;              /* unacked outbound message */
    this.outbound = [];               /* queued follow-up messages */
    this.resendTimer = null;
    this.steps = new Set();
    sock.on('data', (c) => this.feed(c));
    sock.on('close', () => {
      if (this.state === 'done') process.exit(0);   /* session over, by choice */
      fail('engine closed Plane A in state ' + this.state);
    });
    sock.on('error', () => process.exit(3));
    this.pingTimer = setInterval(() => {
      /* crash replacement can consume a connect request without ever
       * answering it (datagram-layer semantics): like the real connect
       * loop, keep asking while a re-dial is pending */
      if ((this.state === 'await-churn' || this.state === 'await-redial') &&
          Date.now() - (this.lastConnectSendAt || 0) > 1200) {
        this.lastConnectSendAt = Date.now();
        const st = this.state;
        this.sendConnect();	/* the Datagram_Connect equivalent resets
				   state to await-accept: keep the re-dial
				   posture (and its pacing condition) alive */
        this.state = st;
      }
      const n = Buffer.alloc(4); n.writeUInt32BE((Date.now() >>> 0), 0);
      this.send(T.PING, n);
    }, 2000);
  }
  send(type, payload) {
    this.sock.write(F.encodeFrame(type, this.seq++, payload || Buffer.alloc(0)));
  }
  clData(body) {
    this.send(T.CL_DATA, F.encodeTLV([[1, PLAYER_PUB], [2, body]]));
  }
  ack(seq) { this.clData(Buffer.concat([
      (() => { const h = Buffer.alloc(8); h.writeUInt32BE((8 | F_ACK) >>> 0, 0); h.writeUInt32BE(seq >>> 0, 4); return h; })(),
    ])); }
  sendMessage(msg) {                   /* stop-and-wait, like Datagram_SendMessage */
    if (this.pending) { this.outbound.push(msg); return; }
    this.pending = { msg, seq: this.sendSeq, tries: 0 };
    this.armResend();
    this.clData(dataPacket(this.sendSeq, msg, true));
  }
  armResend() {
    clearTimeout(this.resendTimer);
    this.resendTimer = setTimeout(() => {
      if (!this.pending) return;
      if (++this.pending.tries > 4) fail('no ACK for outbound seq ' + this.pending.seq);
      this.clData(dataPacket(this.pending.seq, this.pending.msg, true));
      this.armResend();
    }, 700);
  }
  feed(chunk) {
    let frames;
    try { frames = this.reader.feed(chunk); } catch { return fail('frame parse'); }
    for (const f of frames) {
      if (f.type === T.PING) { this.send(T.PONG, f.payload); continue; }
      if (f.type === T.PONG) {
        this.pongs++;
        this.lastPongAt = Date.now();
        continue;
      }
      if (f.type === T.HOST_UP) { this.onHostUp(f); continue; }
      if (f.type === T.SV_DATA) { this.onSvData(f); continue; }
      if (f.type === T.FATAL) fail('FATAL cause ' + (f.payload[0] ?? '?'));
    }
  }
  onHostUp(f) {
    if (this.state !== 'await-host-up') fail('HOST_UP in ' + this.state);
    const t = new Map(F.decodeTLV(f.payload).map((x) => [x.tag, x.value]));
    const map = (t.get(1) || Buffer.alloc(0)).toString('latin1');
    const host = (t.get(2) || Buffer.alloc(0)).toString('latin1');
    const maxp = t.get(3) ? t.get(3)[0] : 0;
    if (map !== 'lqdm1') fail('HOST_UP map is ' + JSON.stringify(map));
    if (!host.length || !maxp) fail('HOST_UP missing hostname/maxplayers');
    step('host-up');
    this.send(T.HOST_READY, F.encodeTLV([[1, HOST_CODE]]));
    this.send(T.PEER_UP, F.encodeTLV([[1, PLAYER_PUB], [2, Buffer.from('LoopbackPlayer')]]));
    step('host-ready');
    this.sendConnect();
  }
  sendConnect() {
    this.lastConnectSendAt = Date.now();
    /* the player's connect request, exactly the bytes Datagram_Connect
     * builds (net_dgrm.c): CTL header, CCREQ_CONNECT, "QUAKE", version */
    const p = Buffer.concat([Buffer.from([CCREQ_CONNECT]),
                             Buffer.from('QUAKE\0', 'latin1'),
                             Buffer.from([NET_PROTOCOL_VERSION])]);
    this.clData(ctlPacket(p));
    this.state = 'await-accept';
  }
  onSvData(f) {
    const t = new Map(F.decodeTLV(f.payload).map((x) => [x.tag, x.value]));
    const body = t.get(2);
    /* four-byte floor: control datagrams are header+command; nothing
     * honest on this lane is shorter, and the parser below reads the
     * eight-byte reliable header */
    if (!body || body.length < 4) return fail('SV_DATA without body');
    if (body.length < 8) return;
    const head = body.readUInt32BE(0);
    const flags = head & ~LEN_MASK, len = head & LEN_MASK;
    if (flags & F_CTL) {
      if (body[4] === 0x83 /* CCREP_SERVER_INFO */) step('srvinfo-probe');
      if (body[4] === 0x84 /* CCREP_PLAYER_INFO */) step('playerinfo-probe');
      if (body[4] === CCREP_ACCEPT && this.state === 'await-churn') {
        /* a counted cycle must be a genuine crash replacement: the
         * datagram layer answers every re-dial landing within 2.0 s
         * of its accept with a duplicate CCREP that closes nothing
         * and accepts nothing (net_dgrm.c dedup branch), so counting
         * those would prove nothing. A reply younger than the
         * replacement window is not a cycle -- the ping-timer re-dial
         * pacing keeps asking until one crosses the boundary. */
        const now = Date.now();
        if (now - (this.lastChurnAcceptAt || 0) < 2200) return;
        this.lastChurnAcceptAt = now;
        this.sendSeq = 0; this.recvSeq = 0;
        this.pending = null; this.outbound = []; this.assembled = [];
        clearTimeout(this.resendTimer);
        if (++this.churnN >= this.churnTarget) {
          this.state = 'done';
          step('churn-done');
        }
        return;
      }
      if (body[4] === CCREP_ACCEPT &&
          (this.state === 'await-accept' || this.state === 'await-redial')) {
        if (this.state === 'await-redial') {
          /* fresh qsocket: the datagram layer restarted its counters from
           * zero, so ours must too -- the fuzz diet continues against a
           * live client instead of dying into duplicate-sequence silence */
          this.sendSeq = 0; this.fseq = 0; this.recvSeq = 0;
          this.pending = null; this.outbound = []; this.assembled = [];
          clearTimeout(this.resendTimer);
          this.state = 'fuzzing';
          step('redial');
        } else {
          step('ccrep-accept');
          this.state = 'await-serverinfo';
        }
      }
      return;
    }
    if (flags & F_ACK) {
      this.lastAckAt = Date.now();
      const aseq = body.readUInt32BE(4);
      if (this.pending && aseq === this.pending.seq) {
        clearTimeout(this.resendTimer);
        this.pending = null;
        this.sendSeq++;
        if (this.outbound.length) {
          const next = this.outbound.shift();
          this.pending = { msg: next, seq: this.sendSeq, tries: 0 };
          this.armResend();
          this.clData(dataPacket(this.sendSeq, next, true));
        }
      }
      return;
    }
    if (!(flags & F_DATA)) return;
    const seq = body.readUInt32BE(4);
    this.ack(seq);
    if (seq === this.recvSeq) {
      this.recvSeq++;
      this.assembled.push(body.subarray(8, len));
      if (flags & F_EOM) this.onHostMessage(Buffer.concat(this.assembled.splice(0)));
    }
  }
  onHostMessage(m) {
    if (this.state === 'await-serverinfo') {
      if (m[0] !== SVC_PRINT) fail('server message does not begin svc_print');
      if (!m.includes(Buffer.from('FITZQUAKE', 'latin1'))) fail('no FITZQUAKE banner');
      if (!m.includes(Buffer.from([SVC_SERVERINFO]))) fail('no svc_serverinfo');
      if (!m.includes(Buffer.from([SVC_SIGNONNUM, 1]))) fail('no svc_signonnum 1');
      step('serverinfo');
      /* the signon dance, byte-for-byte the CL_SignonReply sequence
       * (cl_main.c): prespawn, then name/color/spawn, then begin */
      this.sendMessage(stringCmd('prespawn'));
      this.state = 'await-signon2';
      return;
    }
    /* the signon buffers arrive as several messages; advance only on the
     * marker, ignore the rest, and let the 40 s watchdog judge real stalls */
    if (this.state === 'await-signon2') {
      if (!m.includes(Buffer.from([SVC_SIGNONNUM, 2]))) return;
      step('signon2');
      this.sendMessage(stringCmd(process.env.QN_BADNAME
        ? /* wire-level newline injection: does the host split commands? */
          'name "lm4\nquit"'
        : 'name "LoopbackPlayer"'));
      this.sendMessage(stringCmd('color 0 0'));
      this.sendMessage(stringCmd('spawn'));
      this.state = 'await-signon3';
      return;
    }
    if (this.state === 'await-signon3') {
      if (!m.includes(Buffer.from([SVC_SIGNONNUM, 3]))) return;
      step('signon3');
      this.sendMessage(stringCmd('begin'));
      this.sendMessage(stringCmd('say loopback-online'));
      this.state = 'await-chat-echo';
      return;
    }
    if (this.state === 'await-chat-echo') {
      /* the chat echo comes back through the server's own progs */
      if (m[0] === SVC_PRINT && m.includes(Buffer.from('loopback-online', 'latin1'))) {
        step('chat-echo');
        /* spec 6.4 stufftext gate: rejects first, the allowlisted
         * phrase last. The engine's own QN: notes (deduped per fixed
         * string) are the orchestrator's markers. */
        this.send(T.STUFFTEXT, Buffer.from('quit\0', 'latin1'));
        this.send(T.STUFFTEXT, Buffer.from('exec autoexec.cfg\0', 'latin1'));
        this.send(T.STUFFTEXT, Buffer.from('reconnect\nquit\0', 'latin1'));
        this.send(T.STUFFTEXT, Buffer.from('reconnect; quit\0', 'latin1'));
        this.send(T.STUFFTEXT, Buffer.from('Reconnect\0', 'latin1'));
        this.send(T.STUFFTEXT, Buffer.from('reconnect extra\0', 'latin1'));
        this.send(T.STUFFTEXT, Buffer.from('reconnect'));	/* missing NUL */
        this.send(T.STUFFTEXT, Buffer.from('reconnect\0', 'latin1'));
        this.state = 'done';
        step('done');
        if (process.env.QN_REFUSE) {
          /* §6.2 relay: the joiner must see the fixed reason (the real
           * daemon's onRefused shape; stay alive so the engine catches
           * the frame, as the fatal mode does) */
          this.send(T.JOIN_NO, Buffer.from([parseInt(process.env.QN_REFUSE, 10)]));
        } else if (process.env.QN_FATAL) {
          /* spec 2.3: a peer→engine FATAL must tear the match down; the
           * orchestrator asserts on the engine's reported cause */
          this.send(T.FATAL, Buffer.from([parseInt(process.env.QN_FATAL_CAUSE || '4', 10)]));
        } else if (process.env.QN_REDIAL_CHURN) {
          /* connection churn: repeated crash-style re-dials exercise
           * the datagram table (forwarding slots must not strand
           * entries) */
          this.churnTarget = parseInt(process.env.QN_REDIAL_CHURN, 10);
          this.churnN = 0;
          this.lastChurnAcceptAt = Date.now();	/* the first reply must
						   cross the window too */
          this.sendConnect();
          this.state = 'await-churn';
        }
        if (process.env.QN_FUZZ) this.startFuzz();
        /* a real daemon lives until the session ends: stay connected
         * (the ping timer keeps the loop alive) and exit 0 only when
         * the engine closes Plane A */
      }
      return;
    }
  }
}

/* Fuzz target 3: hostile engine-plane bytes fed through the real driver
 * path — datagram packets that reach net_dgrm's receive validation and,
 * when well-formed enough to pass it, sv_main/sv_user's client-message
 * parse. The check is liveness: the engine must keep answering Plane A
 * pings (Plane A is ours; the parser under attack is the engine plane),
 * and any early exit surfaces through the close handler as a failure. */
Peer.prototype.startFuzz = function () {
  const rounds = parseInt(process.env.QN_FUZZ_ROUNDS || '60', 10);
  /* deterministic corpus: mulberry32 keyed by QN_FUZZ_SEED (default 1);
   * the seed is published as a step so any red run replays exactly */
  const fuzzSeed = (parseInt(process.env.QN_FUZZ_SEED || '1', 10) >>> 0) || 1;
  let seed = fuzzSeed;
  const rand = (n) => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
  const randBytes = (k) => { const b = Buffer.allocUnsafe(k);
                             for (let i = 0; i < k; i++) b[i] = rand(256);
                             return b; };
  const printableGarbage = () => {
    const k = 1 + rand(40); const parts = [];
    for (let i = 0; i < k; i++) parts.push(32 + rand(95));
    return Buffer.concat([Buffer.from([clc_stringcmd]),
                          Buffer.from(String.fromCharCode(...parts) + '\0', 'latin1')]);
  };
  this.state = 'fuzzing';
  step('fuzz-start');
  step('fuzz-seed-' + fuzzSeed);
  /* a dedicated sequence for the well-formed half of the diet; raw sends
   * (no stop-and-wait): a server that lawfully drops the player for bad
   * input must not strand the fuzz phase — Plane A pongs prove it */
  this.fseq = this.sendSeq;
  /* deterministic hostile probes, once per fuzz session, at the exact next
   * sequence so they reach the datagram layer's trusted-copy paths:
   * a DATA header declaring 65535 bytes with 8 real, and a lying UNRELIABLE
   * of the same shape. Without the receive-side length validation these
   * are global-buffer overruns; the ASan build of the test must show them,
   * and green must mean the validation holds. */
  {
    const lie = (flags, seq) => {
      const b = Buffer.alloc(8);
      b.writeUInt32BE(((65535 | flags) >>> 0), 0);
      b.writeUInt32BE(seq >>> 0, 4);
      return b;
    };
    this.clData(lie(F_DATA | F_EOM, this.fseq));
    this.clData(lie(F_UNRELIABLE, 7));
    /* a second unreliable lie at the now-elevated expectation */
    const u = Buffer.alloc(8);
    u.writeUInt32BE((((70000 & 0xffff) | F_UNRELIABLE) >>> 0), 0);
    u.writeUInt32BE(9, 4);
    this.clData(u);
    /* honest-shaped control requests from a second identity: the
     * browse and player flows are real four-byte-headered CTL
     * datagrams — a receive gate that demands the eight-byte reliable
     * header kills them silently. The checks: the datagram layer's
     * CCREP_SERVER_INFO and CCREP_PLAYER_INFO replies must come back
     * to the probe lane. */
    const si = Buffer.concat([Buffer.from([2]),
                              Buffer.from('QUAKE\0', 'latin1'),
                              Buffer.from([NET_PROTOCOL_VERSION])]);
    const sip = Buffer.alloc(4 + si.length);
    sip.writeUInt32BE(((sip.length | F_CTL) >>> 0), 0);
    si.copy(sip, 4);
    this.send(T.CL_DATA, F.encodeTLV([[1, PROBE_PUB], [2, sip]]));
    const pi = Buffer.alloc(6);
    pi.writeUInt32BE(((6 | F_CTL) >>> 0), 0);
    pi.writeUInt8(3, 4);                    /* CCREQ_PLAYER_INFO */
    pi.writeUInt8(0, 5);                    /* player number 0 (0-based) */
    /* a distinct identity: same-key probes coalesce into one table
     * slot and share its single accept offer -- the second would
     * starve behind the first */
    const pi2 = Buffer.from(PROBE_PUB);
    pi2[1] ^= 0xff;
    this.send(T.CL_DATA, F.encodeTLV([[1, pi2], [2, pi]]));
  }
  step('probes');
  let batch = 0;
  const iv = setInterval(() => {
    if (Date.now() - this.lastPongAt > 5000)
      fail('engine stopped answering pings under fuzz (batch ' + batch + ')');
    if (this.state === 'fuzzing' && this.fseq > 2 &&
        Date.now() - this.lastAckAt > 2500) {
      /* the server lawfully dropped the player (badread / unknown command
       * char): re-dial the datagram connect so the parser diet keeps
       * reaching a live client rather than the void */
      this.pending = null;
      clearTimeout(this.resendTimer);
      this.sendConnect();
      this.state = 'await-redial';
    }
    /* well-formed traffic keeps the real reliable parser fed: */
    this.clData(dataPacket(this.fseq, printableGarbage(), true));
    this.fseq++;
    this.clData(dataPacket(this.fseq, Buffer.concat([Buffer.from([3]),
                           randBytes(29)]), true)); /* clc_move */
    this.fseq++;
    /* and the junk that must be dropped, not processed: */
    this.clData(randBytes(8 + rand(200)));                       /* header noise */
    const lie = Buffer.alloc(8);                                /* lying length */
    lie.writeUInt32BE(((batch % 2 ? 300 : 65535) | F_DATA | F_EOM) >>> 0, 0);
    lie.writeUInt32BE((batch % 2 ? this.recvSeq : this.fseq) >>> 0, 4);
    this.clData(lie);
    this.clData(ctlPacket(Buffer.concat([Buffer.from([rand(256)]), randBytes(rand(24))])));
    if (++batch % 20 === 0) step('fuzz-alive-' + batch);
    if (batch >= rounds) {
      clearInterval(iv);
      this.state = 'done';
      step('fuzz-done-' + batch);
    }
  }, 150);
};

async function main() {
  const uds = parseUds(process.argv.slice(2));
  const token = await readToken().catch((e) => { console.error('LBSTEP FAIL ' + e.message); process.exit(2); });
  if (token.length !== 32) process.exit(2);
  step('token');
  const sock = net.connect(uds);
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  step('plane-a-connected');
  sock.write(F.encodeFrame(T.AUTH, 1, token));
  new Peer(sock);
  /* paced churn cycles (each must cross the 2.0 s replacement window)
   * run far past the honest budget: scale the suicide timer with them */
  setTimeout(() => process.exit(4), process.env.QN_FUZZ ? 90000 :
    process.env.QN_REDIAL_CHURN ?
      (Math.max(1, parseInt(process.env.QN_REDIAL_CHURN, 10)) * 5000 + 30000)
      : 40000);
}
main().catch(() => process.exit(3));
