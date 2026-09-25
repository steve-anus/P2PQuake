#!/usr/bin/env node
'use strict';
/* qn_loopback.cjs — the real-engine loopback test for the QN landriver.
 *
 * Boots the vendored QuakeSpasm binary as a dedicated server with -qn,
 * pointing -qn-peer at tests/fake_peer_qn.cjs — a scripted stand-in for
 * qn-peer on Plane A. Everything the test asserts travels through real
 * engine code: the spawn module hands the token on stdin, the transport
 * gate admits the AUTH, net_qn frames HOST_UP and answers HOST_READY
 * (whose join code must reach the console in the display form the spec
 * mandates), and the scripted remote player drives the datagram layer,
 * the server, and the game progs themselves through a full connect,
 * signon, and chat round trip.
 *
 * Run through `make loopback` (also part of `make check`). */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ENGINE = process.env.QN_ENGINE ||
  path.join(ROOT, 'src', 'vendor', 'quakespasm', 'Quake', 'quakespasm');
const FAKE = path.join(__dirname, 'fake_peer_qn.cjs');
const GAMEDATA = process.env.QN_GAMEDATA || path.join(ROOT, 'gamedata');

/* The scripted player's host: the fake peer mints the join code; this
 * file computes the expected display form with its own base32
 * implementation, so the engine-side encoder is checked against an
 * independent oracle, not a shared helper. */
const CODE = Buffer.from([0x73, 0x79, 0x71, 0x7e, 0x76, 0x74, 0x72, 0x70, 0x6f, 0x6d]);
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function expectedJoinCode(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5)
    out += CROCK[parseInt(bits.slice(i, i + 5), 2)];
  return out.slice(0, 4) + '-' + out.slice(4, 8) + '-' +
         out.slice(8, 12) + '-' + out.slice(12, 16);
}

const want = [
  ['standby',        (l) => l === 'QN: p2pquake landriver standby'],
  ['spawned',        (l) => l === 'QN: daemon spawned, awaiting auth'],
  ['authenticated',  (l) => l === 'QN: daemon authenticated'],
  ['join-code',      (l) => l === 'Join code: ' + expectedJoinCode(CODE)],
  ['peer-token',     (l) => l === 'LBSTEP token ok'],
  ['peer-plane-a',   (l) => l === 'LBSTEP plane-a-connected ok'],
  ['peer-host-up',   (l) => l === 'LBSTEP host-up ok'],
  ['peer-host-rdy',  (l) => l === 'LBSTEP host-ready ok'],
  ['peer-accept',    (l) => l === 'LBSTEP ccrep-accept ok'],
  ['peer-serverinfo',(l) => l === 'LBSTEP serverinfo ok'],
  ['peer-signon2',   (l) => l === 'LBSTEP signon2 ok'],
  ['peer-signon3',   (l) => l === 'LBSTEP signon3 ok'],
  ['peer-chat-echo', (l) => l === 'LBSTEP chat-echo ok'],
  ['stext-drop',     (l) => l === 'QN: stufftext dropped (not allowlisted)'],
  ['stext-allow',    (l) => l === 'QN: stufftext allowlisted'],
  ['peer-done',      (l) => l === 'LBSTEP done ok'],
];
if (process.env.QN_FUZZ) {
  const rounds = parseInt(process.env.QN_FUZZ_ROUNDS || '60', 10);
  want.push(['fuzz-start', (l) => l === 'LBSTEP fuzz-start ok']);
  want.push(['fuzz-done', (l) => l === `LBSTEP fuzz-done-${rounds} ok`]);
  want.push(['srvinfo-probe', (l) => l === 'LBSTEP srvinfo-probe ok']);
  want.push(['playerinfo-probe', (l) => l === 'LBSTEP playerinfo-probe ok']);
}
if (process.env.QN_REFUSE) {
  const refuseCause = parseInt(process.env.QN_REFUSE, 10);
  const JOIN_TEXT = {
    1: 'update p2pquake',
    2: 'wrong or stale join code',
    3: 'match is full',
    4: 'match no longer accepting',
    5: 'already playing',
    6: 'slow down and retry',
    7: 'game files or engine build differ from the host',
  };
  want.push(['join-refused', (l) => l.includes(
    `join refused (cause ${refuseCause}): ` +
    (JOIN_TEXT[refuseCause] ?? 'host refused the join'))]);
}
if (process.env.QN_FATAL) {
  const fatalCause = parseInt(process.env.QN_FATAL_CAUSE || '4', 10);
  const FATAL_TEXT = {
    0: 'peer left',
    1: 'session key rejected',
    2: 'internal service error',
    3: 'local service closed the session',
    4: 'connection to host lost',
    5: 'host signature rejected',
    6: 'suspected interference; session reset',
  };
  want.push(['daemon-fatal', (l) => l.includes(
    `daemon FATAL (cause ${fatalCause}): ` +
    (FATAL_TEXT[fatalCause] ?? 'session ended unexpectedly'))]);
}
if (process.env.QN_REDIAL_CHURN)
  want.push(['churn-done', (l) => l === 'LBSTEP churn-done ok']);
const banned = [
  ['forged-packet', (l) => l.includes('Forged packet received')],
  ['read-error',    (l) => l.includes('Read error')],
  ['sv-badread',    (l) => l.includes('SV_ReadClientMessage: badread')],
  ['peer-fail',     (l) => l.startsWith('LBSTEP FAIL')],
  ['peer-fatal',    (l) => /^\s*\[?qn-peer.*FATAL/i.test(l)],
  ['asan',          (l) => l.includes('AddressSanitizer') || l.includes('LeakSanitizer') || l.includes('global-buffer-overflow') || l.includes('heap-buffer-overflow')],
  ['ubsan',         (l) => l.includes('runtime error:')],
  ['fatal-hosterr', (l) => /Host Error|Host_Error|Sys_Error/.test(l)],
];

function main() {
  if (!fs.existsSync(ENGINE)) {
    console.error(`qn_loopback: no engine binary at ${ENGINE} (run "make engine")`);
    return Promise.resolve(1);
  }
  if (!fs.statSync(FAKE).mode.toString(8).endsWith('5')) {
    console.error(`qn_loopback: ${FAKE} must be executable (mode *75)`);
    return Promise.resolve(1);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qnloop-'));
  /* stdbuf -oL: the engine's stdout is block-buffered when piped; without
   * the line-flush its console lines would never reach this capture. */
  const child = spawn('stdbuf', ['-oL', ENGINE,
    '-qn', '-qn-peer', FAKE, '-qn-dir', dir,
    '-basedir', GAMEDATA, '-dedicated',
    '+listen', '+map', 'lqdm1',
  ], {
    env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const lines = [];
  const seen = new Map();      /* want-name -> count */
  let bannedHit = null;
  let doneResolve = null;
  const done = new Promise((r) => { doneResolve = r; });

  const handleLine = (raw) => {
    const l = raw.trim();
    if (!l) return;
    lines.push(l);
    for (const [name, f] of banned) {
      if (f(l)) { bannedHit = [name, l]; doneResolve(1); return; }
    }
    for (const [name, f] of want) {
      if (f(l)) { seen.set(name, (seen.get(name) || 0) + 1); break; }
    }
    const terminal = process.env.QN_FUZZ ? 'fuzz-done'
      : process.env.QN_FATAL ? 'daemon-fatal'
      : process.env.QN_REDIAL_CHURN ? 'churn-done' : 'peer-done';
    if (seen.get(terminal) && !child.killed) {
      /* everything arrived; give the engine a beat to settle, then win */
      setTimeout(() => doneResolve(0), 300);
    }
  };
  /* chunks may split a line at any byte: carry the residue, never drop
   * a marker because it straddled two reads */
  let partial = '';
  const onData = (chunk) => {
    const parts = (partial + chunk.toString('utf8')).split(/\r?\n/);
    partial = parts.pop();
    for (const raw of parts) handleLine(raw);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('close', () => {
    if (partial) { handleLine(partial); partial = ''; }
  });

  const fuzzing = !!process.env.QN_FUZZ;
  /* churn cycles each have to cross the datagram layer's 2.0 s
   * replacement window (only genuine crash replacements are counted),
   * so the run budget scales with the requested cycle count */
  const churnCycles = process.env.QN_REDIAL_CHURN ?
    Math.max(1, parseInt(process.env.QN_REDIAL_CHURN, 10)) : 0;
  /* worst-case paced cycle (crash-consume send + reply send, each up
   * to the 3.2 s tick phase) bounds near 7 s: budget above it so the
   * test flakes on engine timing, not on counting arithmetic */
  const budgetMs = fuzzing ? 120000 :
    churnCycles ? churnCycles * 7000 + 30000 : 45000;
  const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} },
                            budgetMs);
  const hardTimer = setTimeout(() => { doneResolve(2); }, budgetMs + 5000);

  return done.then((code) => {
    clearTimeout(hardTimer);
    try { child.kill('SIGTERM'); } catch {}
    return new Promise((res) => setTimeout(res, 900)).then(() => {
      try { child.kill('SIGKILL'); } catch {}
      clearTimeout(killer);
      const missing = want.map(([n]) => n).filter((n) => !seen.get(n));
      /* churn and FATAL modes re-run boot/honest markers by design
       * (fresh accepted sessions / supervisor respawn cycles): the
       * duplicate gate covers the single-boot flows only */
      const dupeCheck = want.filter(([n]) =>
        !(process.env.QN_REDIAL_CHURN) && !(process.env.QN_FATAL) &&
        !(process.env.QN_REFUSE));
      const dupes = dupeCheck.map(([n]) => n).filter((n) => (seen.get(n) || 0) > 1);
      let rc = code;
      if (rc === 0 && missing.length) { rc = 1; }
      if (rc === 0 && dupes.length) { rc = 1; }
      /* orphan check: the scripted peer must not outlive the session */
      const pg = spawnSync('pgrep', ['-f', 'fake_peer_qn.cjs --uds'],
                           { encoding: 'utf8' });
      const orphans = (pg.stdout || '').trim();
      if (rc === 0 && orphans) { rc = 1; }
      console.log(`qn_loopback: ${lines.length} console lines observed ` +
        (process.env.QN_REDIAL_CHURN ? `(mode churn, target ` +
          process.env.QN_REDIAL_CHURN + `)` :
         process.env.QN_FATAL ? `(mode fatal)` :
         process.env.QN_FUZZ ? `(mode fuzz)` : `(mode plain)`));
      if (missing.length) console.log('  MISSING: ' + missing.join(', '));
      if (dupes.length) console.log('  DUPLICATED: ' + dupes.join(', '));
      if (bannedHit) console.log('  BANNED LINE: [' + bannedHit[0] + '] ' + bannedHit[1]);
      if (orphans && rc) console.log('  ORPHAN fake peer pids: ' + orphans.replace(/\n/g, ' '));
      if (rc === 0) {
        console.log(`LOOPBACK OK: ${want.length} assertions, ${seen.size} markers seen`);
        fs.rmSync(dir, { recursive: true, force: true });
      } else {
        console.log('  --- observed lines ---');
        for (const l of lines) console.log('  | ' + l);
      }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      return rc;
    });
  });
}

main().then((code) => process.exit(code)).catch(() => process.exit(1));
