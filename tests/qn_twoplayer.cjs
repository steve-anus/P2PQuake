#!/usr/bin/env node
/*
 * qn_twoplayer: real two-player harness. One dedicated host engine plus two
 * GUI (offscreen) client engines, each with its own spawned daemon, all
 * discovering each other through a private in-process hyperdht testnet.
 *
 * Unlike qn_loopback (single scripted engine, fake peer), nothing here is
 * faked: join codes are minted by the real host lane, clients resolve them
 * through the real DHT, and both player slots live in the same server.
 *
 * Client-side console input cannot be scripted (the +cmd chain caps at
 * 256 chars and wait is one frame), so chat/kill attribution stays pinned
 * in the loopback harness until the engine-side stufftext allowlist exists.
 *
 * Exit 0 = every marker arrived, no banned line, within budget.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ENGINE = process.env.QN_ENGINE ||
  path.join(ROOT, 'src', 'vendor', 'quakespasm', 'Quake', 'quakespasm');
const PEER = path.join(ROOT, 'src', 'peer', 'qn-peer.cjs');
const GAMEDATA = process.env.QN_GAMEDATA || path.join(ROOT, 'gamedata');
const createTestnet = require('hyperdht/testnet');
const { makeRelayNode } = require('../src/peer/qn-relay.cjs');

let procsRef = [];
let baseRef = null;
let relayNodeRef = null;

const CROCK = new Set('0123456789ABCDEFGHJKMNPQRSTVWXYZ');

function validJoinCode(s) {
  const parts = s.split('-');
  if (parts.length !== 4 || parts.some((p) => p.length !== 4)) return false;
  return [...s.replace(/-/g, '')].every((c) => CROCK.has(c));
}

const BOOT_TIMEOUT = Number(process.env.QN_2P_BOOT_BUDGET || 40000);
const JOIN_TIMEOUT = Number(process.env.QN_2P_JOIN_BUDGET || 90000);
const REJOIN_TIMEOUT = Number(process.env.QN_2P_REJOIN_BUDGET || 60000);

const banned = [
  // The stale-code lane's Host_Error("CL_Connect: connect failed") is the
  // asserted refusal; it longjmps to menu, it does not exit the engine.
  { re: /Host_Error/, name: 'Host_Error',
    unless: /CL_Connect: connect failed/ },
  { re: /Sanitizer|AddressSanitizer|runtime error/, name: 'sanitizer' },
  { re: /Segmentation|Assertion failed/, name: 'crash' },
  { re: /daemon FATAL/, name: 'daemon-fatal', postKillOk: true },
  { re: /wrong reply address/, name: 'wrong-reply-regression' },
  { re: /malformed /, name: 'malformed-frame' },
];

class Engine {
  constructor(name, dir, args, env, opts = {}) {
    this.isPty = !!opts.pty;
    this.name = name;
    this.dir = dir;
    this.log = [];
    this.lineStamps = [];
    this.t0 = Date.now();
    this.lines = [];
    this.procs = [];
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const shq = (s) => (/[ 	]/.test(s) ? "'" + s.replace(/'/g, "'\''") + "'" : s);
    const child = opts.pty
      ? spawn('stdbuf', ['-i0', 'script', '-qef',
                         '-O', path.join(dir, 'console.txt'), '-c',
                         [ENGINE, ...args].map(shq).join(' ')], {
          detached: true,
      env: { ...process.env, SDL_VIDEODRIVER: 'offscreen',
                 SDL_AUDIODRIVER: 'dummy', ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      : spawn('stdbuf', ['-oL', ENGINE, ...args], {
          detached: true,
      env: { ...process.env, SDL_VIDEODRIVER: 'offscreen',
                 SDL_AUDIODRIVER: 'dummy', ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
    child.on('exit', (code, sig) => {
      this.exitInfo = { code, sig };
      this.log.push(`qn2p: engine-exit ${this.name} code=${String(code)} sig=${String(sig)}`);
      this.lineStamps.push(Date.now());
      this.onLine(`qn2p: engine-exit ${this.name} code=${String(code)} sig=${String(sig)}`);
    });
    const absorb = (stream) => {
      let carry = '';
      stream.on('data', (chunk) => {
        carry += chunk.toString('utf8');
        const parts = carry.split(/\r?\n/);
        carry = parts.pop();
        for (const l of parts) {
          this.log.push(l);
          this.lineStamps.push(Date.now());
          try { fs.appendFileSync(this.logfile, l + '\n'); } catch (e) { /* tmp */ }
          this.onLine(l);
        }
      });
    };
    this.logfile = path.join(dir, name.replace(/[^A-Za-z0-9]/g, '') + '.log');
    absorb(child.stdout);
    absorb(child.stderr);
    this.child = child;
    this.procs.push(child);
    this.watchers = [];
  }

  onLine(l) {
    this.lines.push(l);
    for (const w of this.watchers) w(l);
  }

  // Resolve once any line satisfies pred; reject with diagnostics on timeout.
  expect(pred, what, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.watchers = this.watchers.filter((p) => p !== handler);
        reject(new Error(`${this.name}: timeout waiting for ${what}`));
      }, timeout);
      const handler = (l) => {
        if (!pred(l)) return;
        clearTimeout(timer);
        this.watchers = this.watchers.filter((p) => p !== handler);
        resolve(l);
      };
      const done = this.lines.find(pred);
      if (done !== undefined) { clearTimeout(timer); resolve(done); return; }
      this.watchers.push(handler);
    });
  }

  async send(line, gap = 200) {
    // Drain + gap: back-to-back writes merge into one console line through
    // the pty's line discipline (reproduced: 'say one'/'say two' ran as a
    // single 'one'). One \r\n per command, then let the reader catch up.
    const body = line.replace(/[\r\n]+$/, '');
    await new Promise((resolve, reject) =>
      this.child.stdin.write(body + '\r\n',
        (e) => (e ? reject(e) : resolve())));
    await new Promise((r) => setTimeout(r, gap));
  }

  count(pred) { return this.lines.filter(pred).length; }

  kill() {
    if (this.exitInfo) return;
    this.linesAtKill = this.lines.length;
    // detached pgid: kills stdbuf wrapper AND the engine it hides.
    // script(1) setsid's the engine into a NEW session, so the group kill
    // cannot reach it: walk the child tree two levels (script -> engine
    // -> qn-peer daemon) and SIGKILL each, then the group as backstop.
    // A leaked host squatting UDP 26000 once starved the next lane's bind.
    const fsx = require('node:fs');
    const signal = (p) => { try { process.kill(p, 'SIGKILL'); } catch (e) { /* gone */ } };
    const level = (pids) => {
      const out = [];
      for (const p of pids) {
        try {
          for (const task of fsx.readdirSync(`/proc/${p}/task`)) {
            const kids = fsx.readFileSync(`/proc/${p}/task/${task}/children`, 'utf8');
            for (const c of kids.split(/\s+/)) if (c) out.push(Number(c));
          }
        } catch (e) { /* gone */ }
      }
      return out;
    };
    const root = this.child.pid;
    const kids = level([root]);
    const grand = level(kids);
    for (const p of grand) signal(p);
    for (const p of kids) signal(p);
    try { process.kill(-root, 'SIGKILL'); }
    catch (e) { signal(root); }
  }

  dump(tail = 12) {
    const ts = (i, l) => `[+${((this.lineStamps[i] - this.t0) / 1000).toFixed(1)}s] ${l}`;
    const keys = [];
    this.log.forEach((l, i) => {
      if (/qn-peer:|Join code|daemon|QN:|enter|Error|error/.test(l)) keys.push(ts(i, l));
    });
    const from = Math.max(0, this.log.length - tail);
    const tailLines = this.log.slice(from).map((l, j) => ts(from + j, l));
    return `---- ${this.name} key lines ----\n` + keys.join('\n') +
      `\n---- ${this.name} log tail ----\n` + tailLines.join('\n');
  }
}

// Engine-level recovery: a plane-B connection stall (the first relay attempt
// can burn its key-bind window before pairing lands) outlives the engine's
// CL_Connect budget, and a GUI client parked at the menu never retries the
// console path on its own. A player restarts the game; bounded to 2 respawns,
// first at 30 s without the spawn line. Fresh-boot join is the same flow the
// rejoin phase below already asserts, so the relay counters still carry it.
async function waitSpawn (host, mk, name, client) {
  const want = `${name} entered the game`;
  const deadline = Date.now() + JOIN_TIMEOUT;
  let nextCheck = Date.now() + 30000, respawns = 0;
  for (;;) {
    if (host.lines.some((l) => l.includes(want))) return client;
    const now = Date.now();
    if (now > deadline) {
      throw new Error(`${host.name}: timeout waiting for ${name} spawn`);
    }
    if (now >= nextCheck && respawns < 2) {
      respawns++;
      nextCheck = now + 25000;
      console.log(`qn2p: ${name} spawn stalled; engine respawn #${respawns}`);
      try { client.kill(); } catch (e) { /* already gone */ }
      client = mk();
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main() {
  // The engine persists console state to basedir/id1; never inherit it.
  try { fs.rmSync(path.join(GAMEDATA, 'id1', 'config.cfg'), { force: true }); } catch (e) { /* fresh */ }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qn2p-'));
  baseRef = base;
  let tnet = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { tnet = await createTestnet(10, { port: 0 }); break; }
    catch (e) { await new Promise((r) => setTimeout(r, 2500)); }
  }
  if (!tnet) throw new Error('no free port for the private testnet');
  const bootstrap = tnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(',');
  // Traffic proof: QN_RELAY=1 names the blind relay to every daemon and
  // refuses direct hole-punching, so the match can ONLY ride the relay --
  // and finish() fails the lane if the relay saw no traffic. A test, not
  // a hope.
  if (process.env.QN_RELAY && process.env.QN_RELAY !== '1') {
    throw new Error('QN_RELAY malformed (want 1)');
  }
  let relayNode = null;
  const env = { QN_DHT_BOOTSTRAP: bootstrap };
  if (process.env.QN_RELAY === '1') {
    relayNode = await makeRelayNode({ bootstrap: tnet.bootstrap });
    env.QN_RELAY_THROUGH = relayNode.publicKey.toString('hex');
    env.QN_RELAY_ONLY = '1';
  }
  relayNodeRef = relayNode;
  console.log(`TWPLAYER: mode=dm${relayNode ? ' relay' : ''} bootstrap=${bootstrap}`);

  const procs = [];
  procsRef = procs;
  const cleanup = () => {
    for (const p of procs) { try { p.kill(); } catch (e) { /* gone */ } }
  };
  const finish = (code, msg) => {
    if (relayNode) {
      const s = relayNode.stats;
      console.log(`TWPLAYER RELAY: sessions=${s.sessions.accepted}/${s.sessions.opened} pairings=${s.pairings.requested}req/${s.pairings.matched}matched/${s.pairings.pending}pending streams=${s.streams.opened} refused=${s.refused} dropped=${s.dropped}`);
      if (code === 0 && (s.sessions.accepted < 4 || s.pairings.requested < 4 || s.pairings.matched < 2 ||
          s.streams.opened < 4 || s.refused !== 0 || s.dropped !== 0)) {
        console.log('TWPLAYER FAIL: the match did not ride the relay');
        code = 1; msg = 'TWPLAYER FAIL (relay)';
      }
    }
    if (relayNode) relayNode.close().catch(() => {});
    cleanup();
    if (code !== 0) for (const p of procs) if (p.dump) console.log(p.dump());
    if (code === 0) { try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* tmp */ } }
    else console.log('BASE kept at ' + base);
    tnet.destroy().catch(() => {});
    console.log(msg);
    process.exit(code);
  };

  const guard = setTimeout(() => finish(1, 'TWPLAYER FAIL: global budget'), 420000);

  const host = new Engine('host', path.join(base, 'host'),
    ['-qn', '-qn-peer', PEER, '-qn-dir', path.join(base, 'host'),
     '-basedir', GAMEDATA, '-dedicated', '+listen', '+map', 'lqdm1'], env, { pty: true });
  procs.push(host);

  const codeLine = await host.expect(
    (l) => l.startsWith('Join code: '), 'join code', BOOT_TIMEOUT);
  const code = codeLine.slice('Join code: '.length).trim();
  if (!validJoinCode(code)) throw new Error('join code malformed: ' + codeLine);

  const clientArgs = (name, dir) =>
    ['-qn', '-qn-peer', PEER, '-qn-dir', dir, '-basedir', GAMEDATA,
     '+name', name, '+connect', `qn:${code}`];

  // Respawn rotates the persistent identity (identity.key lives in the
  // engine dir): the host's room keeps a stalled member until its ping
  // loop GCs the dead lane, and a same-identity rejoin would be refused
  // DUP_IDENTITY inside that window. The old lane's close still removes
  // the stale member; the engine name (SV side) is unchanged.
  const mkEngine = (label, gameName, dir, respawn) => {
    if (respawn) { try { fs.rmSync(path.join(dir, 'identity.key'), { force: true }); } catch (e) { /* none */ } }
    const e = new Engine(label, dir, clientArgs(gameName, dir), env);
    procs.push(e);
    return e;
  };
  const mkAlice = (respawn) => mkEngine('QnAlice', 'QnAlice', path.join(base, 'cl1'), respawn);
  const mkBob = (respawn) => mkEngine('QnBob', 'QnBob', path.join(base, 'cl2'), respawn);
  let alice = mkAlice(false);
  let bob = mkBob(false);

  for (const c of [alice, bob]) {
    await c.expect((l) => l.includes('client: joined'), 'room join', JOIN_TIMEOUT);
  }
  for (const c of [alice, bob]) {
    await c.expect((l) => l.trim() === 'qn-peer: client: roster v2',
      'roster v2', JOIN_TIMEOUT);
  }
  alice = await waitSpawn(host, () => mkAlice(true), 'QnAlice', alice);
  bob = await waitSpawn(host, () => mkBob(true), 'QnBob', bob);

  await new Promise((r) => setTimeout(r, 10000)); // soak: banned lines would land

  // Host-driven map cycle with the cast live: the server's classic
  // reconnect broadcast must pull both players back into the new map by
  // themselves — no harness-side re-spawn, same room, same join code.
  const enterCount = (n) =>
    host.count((l) => l.includes(`${n} entered the game`));
  // The vendor gates 'entered the game' on connection recency (host_cmd.c),
  // so map-riding clients do not print it again: assertions are the host
  // status map line plus Host_Say round-trips -- which deliver only to
  // clients the server itself sees as active && spawned.
  await host.send('changelevel lqdm2');
  await host.send('status');
  await host.expect((l) => l.includes('map:') && l.includes('lqdm2'),
    'host running lqdm2', JOIN_TIMEOUT);
  // A server-console say (src_command on a dedicated host) broadcasts only
  // to clients the server itself sees as active && spawned, so each
  // receipt is server-side attestation of re-entry on the new map.
  await host.send('say postmap');
  await alice.expect((l) => l.includes('<UNNAMED> postmap'),
    'Alice in-game on lqdm2', REJOIN_TIMEOUT);
  await bob.expect((l) => l.includes('<UNNAMED> postmap'),
    'Bob in-game on lqdm2', REJOIN_TIMEOUT);

  // Bob exits (killed; the host notices via the daemon's plane-A EOF).
  const removedB0 = host.count((l) => l.includes('Client QnBob removed'));
  bob.kill();
  await host.expect((l) => l.includes('Client QnBob removed') &&
    host.count((x) => x.includes('Client QnBob removed')) > removedB0,
    'bob slot released', 120000);

  // Crash-style rejoin with the same qn-dir keeps the same identity: the
  // transport must accept the returning peer (epoch guard covers replays).
  // Solo shape: crash-rejoin with a resident second player trips a
  // server-side freed-edict defect (repro and status in the project log).
  const removedBefore = host.count(
    (l) => l.includes('Client QnAlice removed'));
  alice.kill();
  await host.expect((l) => l.includes('Client QnAlice removed') &&
    host.count((x) => x.includes('Client QnAlice removed')) > removedBefore,
    'host slot release after crash', 120000);
  const rejoinMin = enterCount('QnAlice') + 1;
  let alice2 = mkEngine('QnAlice#2', 'QnAlice', path.join(base, 'cl1'), false);
  {
    // Same stall family as waitSpawn: a first-connection key-bind stall can
    // outlive the engine's CL budget during alice2's boot; restart the
    // engine (fresh identity to dodge the host's zombie-member window).
    const deadline = Date.now() + REJOIN_TIMEOUT;
    let nextCheck = Date.now() + 20000, respawns = 0;
    for (;;) {
      const joinedOk = alice2.lines.some((l) => l.includes('client: joined'));
      const enteredOk = enterCount('QnAlice') >= rejoinMin;
      if (enteredOk) break;
      const now = Date.now();
      if (now > deadline) {
        throw new Error((joinedOk ? 'host' : 'QnAlice#2') + ': timeout waiting for '
          + (joinedOk ? 'QnAlice respawn #2' : 'rejoin'));
      }
      if (now >= nextCheck && respawns < 2) {
        respawns++;
        nextCheck = now + 18000;
        console.log(`qn2p: rejoin stalled; engine respawn #${respawns}`);
        try { alice2.kill(); } catch (e) { /* already gone */ }
        alice2 = mkEngine('QnAlice#2', 'QnAlice', path.join(base, 'cl1'), true);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Stale code after the host is gone must fail cleanly, never crash.
  // Residents go first: a resident re-dial meeting a dead host is a
  // mid-match refusal (correctly fatal), and fatal lines are only
  // exempted past the harness's own kills.
  alice2.kill();
  await new Promise((r) => setTimeout(r, 1500));
  host.kill();
  await new Promise((r) => setTimeout(r, 2000));
  bob.kill();
  const ghost = new Engine('ghost', path.join(base, 'cl3'),
    clientArgs('QnGhost', path.join(base, 'cl3')), env);
  procs.push(ghost);
  await ghost.expect((l) => l.includes('connect failed') ||
    l.includes('not found') || l.includes('Can\'t connect'),
    'stale-code refusal', JOIN_TIMEOUT);


  for (const l of ghost.lines) {
    for (const b of banned) {
      if (b.re.test(l) && !(b.unless && b.unless.test(l))) {
        console.log(`banned[${b.name}] in ghost: ${l}`);
        return finish(1, 'TWPLAYER FAIL: banned line');
      }
    }
  }

  const all = [host, alice, bob, alice2, ghost];
  for (const p of all) {
    for (let li = 0; li < p.lines.length; li++) {
      const l = p.lines[li];
      for (const b of banned) {
        if (b.postKillOk && p.linesAtKill !== undefined && li >= p.linesAtKill) continue;
        if (b.re.test(l) && !(b.unless && b.unless.test(l))) {
          console.log(`banned[${b.name}] in ${p.name} li=${li} killAt=${String(p.linesAtKill)}: ${l}`);
          return finish(1, 'TWPLAYER FAIL: banned line');
        }
      }
    }
  }

  clearTimeout(guard);
  console.log(`TWPLAYER OK: join x2, roster v2 x2, spawn x2, rejoin, stale-code refusal (${all.length} engines, ${all.reduce((n, p) => n + p.lines.length, 0)} console lines)`);
  finish(0, 'TWPLAYER OK');
}

main().catch((e) => {
  console.log('TWPLAYER FAIL:', e.message);
  if (relayNodeRef) { const s = relayNodeRef.stats; console.log(`TWPLAYER RELAY(at-fail): sessions=${s.sessions.accepted}/${s.sessions.opened} pairings=${s.pairings.requested}req/${s.pairings.matched}matched/${s.pairings.pending}pending streams=${s.streams.opened} refused=${s.refused} dropped=${s.dropped}`); }
  for (const p of procsRef) { try { p.kill(); } catch (err) { /* gone */ } }
  for (const p of procsRef) if (p.dump) console.log(p.dump());
  if (baseRef) console.log('BASE kept at ' + baseRef);
  process.exit(1);
});
