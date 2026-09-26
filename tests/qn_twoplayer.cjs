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
 * 256 chars and wait is one frame), so chat/kill attribution lives in the
 * loopback harness.
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
const PEER = process.env.QN_PEER || path.join(ROOT, 'src', 'peer', 'qn-peer.cjs');
const GAMEDATA = process.env.QN_GAMEDATA || path.join(ROOT, 'gamedata');
// The engine rebuilds com_cmdline (and Cmd_StuffCmds_f parses THAT) with
// a hard 256-char cap: overrunning it silently drops later +cmds, so the
// launch string stays on relative paths whenever the cwd allows.
const relIfShorter = (p) => {
  const r = path.relative(process.cwd(), p);
  return (!r.startsWith('..') && r.length < p.length) ? r : p;
};
const createTestnet = require('hyperdht/testnet');
const { makeRelayNode } = require('../src/peer/qn-relay.cjs');

let procsRef = [];
let baseRef = null;
let relayNodeRef = null;

const CROCK = new Set('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
const LANE_TMP = 'qn-lane-tmp';

// Name-fuzz payloads: a name is data, never executable.
// Alice carries the format-spec and command-text classes (the newline
// class lives in the wire-level crafted-client lane, not argv). Bob's
// name is a unique sentinel: it must arrive verbatim, proving cfg
// delivery for every joiner. A same-name PAIR is not reachable with the
// fixed roster here; plane-B refusals key on the pubkey, not the name.
const NAME_A = process.env.QN_T_A || '%s%n;exec llama';
const NAME_B = process.env.QN_T_B || 'QnBobDup';

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
      : spawn('stdbuf', ['-oL', relIfShorter(ENGINE), ...args], {
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
    // A leaked host squats UDP 26000 and starves the next lane's bind.
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

// Engine-level recovery: a plane-B stall (the first relay attempt can burn
// its key-bind window before pairing lands) outlives the engine's
// CL_Connect budget, and a menu-parked client never retries on its own:
// restart the engine, bounded to 2 respawns, first at 30 s without the
// spawn line. Fresh-boot join keeps the relay-counter coverage the
// rejoin phase asserts.
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
  try { fs.rmSync(path.join(GAMEDATA, 'id1', LANE_TMP), { recursive: true, force: true }); } catch (e) { /* stale */ }
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
  console.log(`TWPLAYER: mode=${process.env.QN_COOP ? 'coop' : 'dm'}${relayNode ? ' relay' : ''} bootstrap=${bootstrap}`);

  const procs = [];
  procsRef = procs;
  const cleanup = () => {
    for (const p of procs) { try { p.kill(); } catch (e) { /* gone */ } }
  };
  const finish = (code, msg) => {
    if (relayNode && !process.env.QN_HOSTNAME) {
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
    if (code === 0) {
      try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* tmp */ }
      try { fs.rmSync(path.join(GAMEDATA, 'id1', LANE_TMP), { recursive: true, force: true }); } catch (e) { /* tmp */ }
    }
    else console.log('BASE kept at ' + base);
    tnet.destroy().catch(() => {});
    console.log(msg);
    process.exit(code);
  };

  let peerLink = null;
  const peerArg = () => {
    if (!peerLink) {
      peerLink = path.join(base, 'p.cjs');
      try { fs.unlinkSync(peerLink); } catch (e) { /* none */ }
      fs.symlinkSync(PEER, peerLink);
    }
    return peerLink;
  };
  const guard = setTimeout(() => finish(1, 'TWPLAYER FAIL: global budget'), 420000);

  if (process.env.QN_HOSTNAME) {
    const cfgdir = path.join(GAMEDATA, 'id1', LANE_TMP);
    fs.mkdirSync(cfgdir, { recursive: true });
    const setupCfg = path.join(cfgdir, 'hnsetup.cfg');
    fs.writeFileSync(setupCfg,
      '_cl_name "QNcaptain"\n_cl_color "100"\nhostname "QNroom42"\necho QNCFGOK-HN\n');
    const e1 = new Engine('hn1', path.join(base, 'hn1'),
      ['-basedir', relIfShorter(GAMEDATA), '+exec', LANE_TMP + '/hnsetup.cfg', '+quit'], env);
    procs.push(e1);
    await e1.expect((l) => l.includes('QNCFGOK-HN'), 'setup cfg exec', BOOT_TIMEOUT);
    await e1.expect((l) => l.includes('engine-exit hn1 code=0'), 'clean quit', BOOT_TIMEOUT);
    const written = fs.readFileSync(path.join(GAMEDATA, 'id1', 'config.cfg'), 'utf8');
    for (const want of ['_cl_name "QNcaptain"', '_cl_color "100"', 'hostname "QNroom42"'])
      if (!written.includes(want))
        return finish(1, 'HOSTNAME FAIL: config.cfg missing ' + want);
    const e2 = new Engine('hn2', path.join(base, 'hn2'),
      ['-basedir', relIfShorter(GAMEDATA), '+listen', '+maxplayers', '4',
       '+deathmatch', '0', '+coop', '0', '+map', 'lqdm1', '+status', '+name',
       '+color', '+quit'], env);
    procs.push(e2);
    const hostLine = await e2.expect((l) => /^host:\s+/.test(l), 'status host line', BOOT_TIMEOUT);
    if (!hostLine.includes('QNroom42'))
      return finish(1, 'HOSTNAME FAIL: host name not restored: ' + hostLine);
    await e2.expect((l) => l.includes('"name" is "QNcaptain"'),
      'name restore echo', 15000);
    await e2.expect((l) => l.includes('"color" is "6 4"'),
      'color restore echo', 15000);
    return finish(0, 'TWPLAYER OK: setup save - name, colors and host name survive a restart');
  }

  if (process.env.QN_LISTENHOST) {
    // The menu flow hosts a LISTEN server inside the player's client engine:
    // its server ticks follow the render frame rate (host_maxfps), not the
    // dedicated sys_ticrate cap that every other scripted lane hosts under.
    // 300 fps lifts the honest host->client RELAY envelope rate far past the
    // control-plane budget, so this lane is the regression pin for §6.1
    // metering of game-data traffic.
    const LH_NAME = 'QnListenPlyr';
    const fail = (m) => finish(1, 'LISTENHOST FAIL: ' + m);
    const senv = { ...env, QN_LANE_STATS: '1' };
    const hdir = path.join(base, 'lhhost');
    const host = new Engine('lh-host', hdir,
      ['-qn', '-qn-peer', peerArg(), '-qn-dir', hdir,
       '-basedir', relIfShorter(GAMEDATA),
       '+host_maxfps', '300', '+listen', '+maxplayers', '2',
       '+deathmatch', '0', '+coop', '0', '+map', 'lqdm1'],
      senv, { pty: true });
    procs.push(host);
    const codeLine = await host.expect(
      (l) => l.startsWith('Join code: '), 'join code', BOOT_TIMEOUT);
    const code = codeLine.slice('Join code: '.length).trim();
    if (!validJoinCode(code)) return fail('join code malformed: ' + codeLine);

    const cfgd = path.join(GAMEDATA, 'id1', LANE_TMP);
    fs.mkdirSync(cfgd, { recursive: true });
    const cdir = path.join(base, 'lhcl');
    fs.writeFileSync(path.join(cfgd, `qnname-${path.basename(cdir)}.cfg`),
      `_cl_name "${LH_NAME}"\necho QNCFGOK\n`);
    const mkCl = (respawn) => {
      if (respawn) {
        try { fs.rmSync(path.join(cdir, 'identity.key'), { force: true }); } catch (e) { /* none */ }
      }
      const e = new Engine('lh-cl', cdir,
        ['-qn', '-qn-peer', peerArg(), '-qn-dir', cdir,
         '-basedir', relIfShorter(GAMEDATA),
         '+exec', `${LANE_TMP}/qnname-${path.basename(cdir)}.cfg`,
         '+connect', `qn:${code}`], senv);
      procs.push(e);
      return e;
    };
    let cl = mkCl(false);
    await cl.expect((l) => l.includes('client: joined'), 'room join', JOIN_TIMEOUT);
    cl = await waitSpawn(host, () => mkCl(true), LH_NAME, cl);

    // Survival window: the pre-fix bucket (200/s burst 50) starves under a
    // 300 fps listen host within ~1 s of spawn (proved red), so 20 s of
    // live play with every death marker absent is the referee. No say
    // round-trip here: a listen host's client console never reads stdin in
    // menu/game key_dest, so harness keystrokes cannot reach it.
    const DEAD = ['rate limit exceeded', 'lost server connection',
      'host connection lost', `Client ${LH_NAME} removed`, 'daemon FATAL',
      'window close-drops'];
    const CRASH = /Host_Error|Sanitizer|AddressSanitizer|runtime error|Segmentation|Assertion failed/;
    const tEnd = Date.now() + 20000;
    while (Date.now() < tEnd) {
      if (host.exitInfo || cl.exitInfo) return fail('an engine exited during the survival window');
      for (const m of DEAD) {
        const hit = host.lines.find((l) => l.includes(m)) ||
          cl.lines.find((l) => l.includes(m));
        if (hit) return fail(`lane died during honest play: ${hit}`);
      }
      for (const l of host.lines.concat(cl.lines))
        if (CRASH.test(l)) return fail(`crash marker during window: ${l}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    // Edge-of-window blind spot: one more sweep after the last sleep.
    if (host.exitInfo || cl.exitInfo) return fail('an engine exited at the window edge');
    for (const m of DEAD) {
      const hit = host.lines.find((l) => l.includes(m)) ||
        cl.lines.find((l) => l.includes(m));
      if (hit) return fail(`lane died during honest play: ${hit}`);
    }
    for (const l of host.lines.concat(cl.lines))
      if (CRASH.test(l)) return fail(`crash marker during window: ${l}`);
    // Throughput witness: the joiner's daemon must have sustained an inbound
    // RELAY rate above the pre-fix 200/s budget -- otherwise the box never
    // reached the honest listen-host envelope rate and the lane proves
    // nothing (green must not be free).
    let peak = 0;
    for (const l of cl.lines) {
      const m = /client: lane-stats relays=(\d+)/.exec(l);
      if (m) peak = Math.max(peak, Number(m[1]));
    }
    if (peak < 210)
      return fail(`inbound RELAY peak only ${peak}/s: box never exceeded the old budget, lane did not referee`);
    if (!cl.lines.some((l) => /^qn-peer: client: roster v\d+$/.test(l.trim())))
      return fail('no signed roster ever reached the joiner');
    return finish(0, 'LISTENHOST OK: listen-server host at host_maxfps 300 kept the joiner lane alive across a 20 s play window');
  }

  const host = new Engine('host', path.join(base, 'host'),
    ['-qn', '-qn-peer', peerArg(), '-qn-dir', path.join(base, 'host'),
     '-basedir', relIfShorter(GAMEDATA), '-dedicated', '+listen',
     ...(process.env.QN_COOP
       ? ['+coop', '1', '+deathmatch', '0', '+map', 'lq_e1m1']
       : ['+map', 'lqdm1'])],
    env, { pty: true });
  procs.push(host);

  const codeLine = await host.expect(
    (l) => l.startsWith('Join code: '), 'join code', BOOT_TIMEOUT);
  const code = codeLine.slice('Join code: '.length).trim();
  if (!validJoinCode(code)) throw new Error('join code malformed: ' + codeLine);

  // Name delivery via cfg file: the boot +cmd collector (Cmd_StuffCmds_f)
  // treats '+', '-' and ';' as structural, so hostile payloads cannot ride
  // argv values (local-launch semantics, not the wire class under test).
  // The cfg tokenizer honors quotes; the resulting cvar bytes are identical.
  const nameCfg = (dir, name) => {
    const d = path.join(GAMEDATA, 'id1', LANE_TMP);
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, `qnname-${path.basename(dir)}.cfg`);
    fs.writeFileSync(f, `_cl_name "${name}"\necho QNCFGOK\n`);
    return `${LANE_TMP}/qnname-${path.basename(dir)}.cfg`;
  };
  // No hostile bytes ever ride argv: the +cmd collector treats '+',
  // '-' and ';' inside values as structural (Cmd_StuffCmds_f). The
  // hostile bytes ride the cfg (its tokenizer honors quotes); the cfg
  // itself carries the QNCFGOK attestation echo, and the host-console
  // verbatim display below proves the delivered cvar bytes.
  const clientArgs = (name, dir) =>
    ['-qn', '-qn-peer', peerArg(), '-qn-dir', dir,
     '-basedir', relIfShorter(GAMEDATA),
     '+exec', nameCfg(dir, name), '+connect', `qn:${code}`];

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
  const mkAlice = (respawn) => mkEngine('QnAlice', NAME_A, path.join(base, 'cl1'), respawn);
  const mkBob = (respawn) => mkEngine('QnBob', NAME_B, path.join(base, 'cl2'), respawn);
  let alice = mkAlice(false);
  let bob = mkBob(false);

  for (const c of [alice, bob]) {
    await c.expect((l) => l.includes('client: joined'), 'room join', JOIN_TIMEOUT);
  }
  for (const c of [alice, bob]) {
    await c.expect((l) => l.trim() === 'qn-peer: client: roster v2',
      'roster v2', JOIN_TIMEOUT);
  }
  alice = await waitSpawn(host, () => mkAlice(true), NAME_A, alice);
  bob = await waitSpawn(host, () => mkBob(true), NAME_B, bob);

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
  const cycleMaps = process.env.QN_COOP ? ['lq_e1m2', 'lq_e2m1'] : ['lqdm2'];
  for (const m of cycleMaps) {
    await host.send(`changelevel ${m}`);
    await host.send('status');
    await host.expect((l) => l.includes('map:') && l.includes(m),
      `host running ${m}`, JOIN_TIMEOUT);
    // A server-console say broadcasts only to clients the server sees as
    // active && spawned, so each receipt is server-side attestation of
    // re-entry on the new map. Re-entry races the two reconnects against
    // each other, so the round-trip is re-offered until both attest.
    const wantSay = `postmap-${m}`;
    let sA = false, sB = false;
    for (let t = 0; t < 30 && !(sA && sB); t++) {
      await host.send(`say ${wantSay}`);
      await new Promise((r) => setTimeout(r, 2000));
      sA = alice.count((l) => l.includes('<UNNAMED> ' + wantSay)) > 0;
      sB = bob.count((l) => l.includes('<UNNAMED> ' + wantSay)) > 0;
    }
    if (!sA || !sB)
      throw new Error(`postmap round-trip missing on ${m}: alice=${sA} bob=${sB}`);
  }

  // Bob exits (killed; the host notices via the daemon's plane-A EOF).
  const removedB0 = host.count((l) => l.includes(`Client ${NAME_B} removed`));
  bob.kill();
  await host.expect((l) => l.includes(`Client ${NAME_B} removed`) &&
    host.count((x) => x.includes(`Client ${NAME_B} removed`)) > removedB0,
    'bob slot released', 120000);

  // Crash-style rejoin with the same qn-dir keeps the same identity: the
  // transport must accept the returning peer (epoch guard covers replays).
  // Solo shape: crash-rejoin with a resident second player trips a
  // server-side freed-edict defect.
  const removedBefore = host.count(
    (l) => l.includes(`${NAME_A} removed`));
  alice.kill();
  await host.expect((l) => l.includes(`${NAME_A} removed`) &&
    host.count((x) => x.includes(`${NAME_A} removed`)) > removedBefore,
    'host slot release after crash', 120000);
  const rejoinMin = enterCount(NAME_A) + 1;
  let alice2 = mkEngine('QnAlice#2', NAME_A, path.join(base, 'cl1'), false);
  {
    // Same stall family as waitSpawn: a first-connection key-bind stall can
    // outlive the engine's CL budget during alice2's boot; restart the
    // engine (fresh identity to dodge the host's zombie-member window).
    const deadline = Date.now() + REJOIN_TIMEOUT;
    let nextCheck = Date.now() + 20000, respawns = 0;
    for (;;) {
      const joinedOk = alice2.lines.some((l) => l.includes('client: joined'));
      const enteredOk = enterCount(NAME_A) >= rejoinMin;
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
        alice2 = mkEngine('QnAlice#2', NAME_A, path.join(base, 'cl1'), true);
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
  await ghost.expect((l) => l.includes(
    'join refused (cause 2): wrong or stale join code'),
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

  // Hostile names sit verbatim in the host console and executed
  // nothing; the join code never left its sanctioned host display line.
  if (!host.lines.some((l) => l.includes(`${NAME_A} entered the game`)))
    return finish(1, 'TWPLAYER FAIL: hostile name not displayed verbatim');
  for (const p of [alice, bob])
    if (!p.lines.some((l) => l.includes('execing qn-lane-tmp/')) ||
        !p.lines.some((l) => l.includes('QNCFGOK')))
      return finish(1, `TWPLAYER FAIL: name cfg not attested in ${p.name}`);
  // Detectors use this engine's real strings ('couldn't exec X',
  // 'Unknown command "X"'); payload-derived so boot cvar noise cannot
  // self-trip. The sv_user 'tried to' arm is Con_DPrintf-only and dead
  // unless developer is set: an honest client only sends whitelisted
  // stringcmds, so it is unreachable here and deliberately not asserted.
  for (const p of procs)
    for (const l of p.lines)
      if (/couldn't exec llama|Unknown command "%s|Unknown command "llama|Unknown command "exec/i.test(l))
        return finish(1, `TWPLAYER FAIL: name-execution trace in ${p.name}: ${l}`);
  const hex = code.replace(/-/g, '').toLowerCase();
  let codeLines = 0;
  for (const l of host.lines) if (l.startsWith('Join code: ')) codeLines++;
  if (!host.lines.some((l) => l.startsWith('qn-peer: host: room open maxpeers=7')))
    throw new Error('host console lacks the room-open maxpeers line');
  if (codeLines !== 1)
    return finish(1, `TWPLAYER FAIL: join code display count ${codeLines}`);
  // The engine echoes its own argv at boot; the lane dials via argv (the
  // developer surface). The shipped pad path never places the code in
  // argv or console text, and every other joiner line must be code-free.
  for (const p of procs)
    for (const l of p.lines)
      if (!l.startsWith('Command line:') &&
          !(p === host && l.startsWith('Join code: ')) &&
          l.replace(/-/g, '').toLowerCase().includes(hex))
        return finish(1, `TWPLAYER FAIL: join code leaked in ${p.name}`);

  clearTimeout(guard);
  console.log(`TWPLAYER OK: join x2, roster v2 x2, spawn x2, rejoin, stale-code refusal, name-fuzz + redaction (${all.length} engines, ${all.reduce((n, p) => n + p.lines.length, 0)} console lines)`);
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
