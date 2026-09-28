#!/usr/bin/env node
'use strict';
/* tests/qn_visibility.cjs — host-page visibility edges + state placement.
 * Real dedicated engine (pty-wrapped so the console takes scripted
 * commands, the qn_twoplayer idiom) + real qn-peer daemon on a hyperdht
 * testnet.
 *  A: closed-by-default — a hosted room with no visibility command never
 *     announces; state lands under -qn-statedir/<tag>, never the socket dir.
 *  B: live pump edges — public announces, private withdraws, public
 *     announces again; no match restart, one host lane throughout.
 *  C: default state root (HOME set, XDG_STATE_HOME cleared) is
 *     $HOME/.p2pquake with one instance dir whose name equals the
 *     daemon-side FNV-1a of the socket dir — the engine's C hash and the
 *     daemon's JS hash must agree on the same input.
 *  D: reuse — a second engine on the same HOME finds the identical
 *     identity.key bytes (no re-generation).
 *  E: fallback — with neither HOME nor XDG_STATE_HOME usable, state
 *     collapses into the socket dir (documented exotic-env behavior). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('./platform.cjs');
const createTestnet = require('hyperdht/testnet');
const { qnFnv1aHex, defaultStateDir } = require('../src/peer/qn-peer.cjs');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'src', 'vendor', 'quakespasm', 'Quake', 'quakespasm');
const PEER = path.join(ROOT, 'src', 'peer', 'qn-peer.cjs');
const GAMEDATA = process.env.QN_GAMEDATA || path.join(ROOT, 'gamedata');
const BUDGET = 45000;

const banned = [
  ['peer-fatal', /^\s*\[?qn-peer.*FATAL/i],
  ['asan', /AddressSanitizer|LeakSanitizer|heap-buffer-overflow/],
  ['fatal-hosterr', /Host Error|Host_Error|Sys_Error/],
];

const shq = (s) => (/[ \t]/.test(s) ? "'" + s.replace(/'/g, "'\\''") + "'" : s);
// The engine reconstitutes argv into com_cmdline[CMDLINE_LENGTH=256] for
// stuffcmds and TRUNCATES the tail silently — keep launch strings short
// (cwd is the repo root under make check, so relative paths resolve).
const relIfShorter = (p) => {
  const r = path.relative(process.cwd(), p);
  return r && r.length < p.length && !r.startsWith('..') ? r : p;
};

const JOINCODE = /Join code: ([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})/;

function runPhase(name, boot, script, bootstrap, extraBanned, opts = {}) {
  const killList = banned.concat(extraBanned || []);
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qnvis-'));
    const dirArgs = opts.dirArgs === false ? []
      : ['-qn-dir', dir,
         '-qn-statedir', opts.statedirOverride ?? path.join(dir, 'state')];
    /* the engine requires an absolute -qn-peer (exec_ok_path); only the
     * script -c program word and -basedir ride relative. */
    const args = ['-qn', '-qn-peer', PEER, ...dirArgs,
      '-basedir', relIfShorter(GAMEDATA), '-dedicated',
      '+listen', '+map', 'lqdm1', ...boot];
    const wantEcho = [relIfShorter(ENGINE), ...args].join(' ');
    if (wantEcho.length >= 256)
    { resolve(`${name}: launch too long for com_cmdline (${wantEcho.length})`); return; }
    const child = spawn('stdbuf', ['-i0', 'script', '-qef',
      '-O', path.join(dir, 'console.txt'), '-c',
      [relIfShorter(ENGINE), ...args].map(shq).join(' ')], {
      detached: true,
      env: { ...process.env, QN_DHT_BOOTSTRAP: bootstrap,
             SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy',
             ...(opts.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let fail = null;
    let step = 0;
    let done = false;
    let completed = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      clearTimeout(hard);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      if (!opts.keep) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
      resolve(fail || (why === 'ok' ? null : `${name}: ${why}`));
    };
    const complete = () => {
      try { if (opts.onComplete) opts.onComplete(dir); finish('ok'); }
      catch (e) { finish('assert: ' + e.message); }
    };
    const hard = setTimeout(() => finish(`budget at ${step}/${script.length}`), BUDGET);
    const send = (line) => {
      try { child.stdin.write(line + '\r\n'); } catch { /* dying */ }
    };
    const feed = (chunk) => {
      for (const l of chunk.toString('utf8').split(/\r?\n/)) {
        const t = l.trim();
        if (!t) continue;
        for (const [nm, f] of killList) {
          if (f.test(t)) { fail = `banned ${nm}: ${t}`; finish(fail); return; }
        }
        if (t.startsWith('Command line: ') &&
            t.slice('Command line: '.length).length !== wantEcho.length)
        {
          fail = `cmdline truncated in engine echo (com_cmdline cap)`;
          finish(fail);
          return;
        }
        const cur = script[step];
        if (cur && cur.expect.test(t)) {
          step++;
          if (cur.then) setTimeout(() => send(cur.then), 200);
          if (step === script.length) { completed = true; setTimeout(complete, 400); }
        }
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('exit', () => { if (completed) complete(); else finish(`exit at ${step}/${script.length}`); });
  });
}

const modeOf = (f) => fs.statSync(f).mode & 0o777;
const posture = (d, what) => {
  const st = fs.statSync(d);
  assert.strictEqual(st.mode & 0o777, 0o700, what + ' must be exactly 0700: ' + d);
  assert.strictEqual(st.uid, process.getuid(), what + ' must be ours: ' + d);
};
const walkNames = (d) => {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    out.push(e.name);
    if (e.isDirectory()) out.push(...walkNames(path.join(d, e.name)));
  }
  return out;
};

async function main() {
  if (!fs.existsSync(ENGINE)) { console.error('no engine binary (make engine)'); process.exit(1); }
  const tnet = await createTestnet(3);
  const bootstrap = tnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(',');
  console.log('VISIBILITY: bootstrap=' + bootstrap);

  const quitOn = (re) => [{ expect: re, then: 'quit' }];

  /* A: default-private is asserted by banning the advertisement line, and
   * state separation by direct file observation */
  const a = await runPhase('private-by-default', [], quitOn(JOINCODE), bootstrap,
    [['stray-advert', /lobby: announced/]],
    { onComplete: (dir) => {
        const tag = qnFnv1aHex(dir);
        const idf = path.join(dir, 'state', tag, 'identity.key');
        assert.ok(fs.existsSync(idf), 'identity.key under statedir/instance: ' + idf);
        assert.strictEqual(modeOf(idf) & 0o077, 0, 'identity.key not world-accessible');
        const sd = fs.readdirSync(dir);
        assert.ok(sd.includes('engine.sock'), 'socket in socket dir');
        assert.ok(!sd.includes('identity.key'), 'identity never in the socket dir');
        posture(path.join(dir, 'state'), 'state root');
        posture(path.join(dir, 'state', tag), 'state instance dir');
      } });
  if (a) { console.error('VISIBILITY FAIL A: ' + a); process.exit(1); }
  console.log('VISIBILITY: A ok (private by default, state separated)');

  const scriptB = [
    { expect: /lobby: announced/, then: 'qn_status' },
    { expect: /visibility public/, then: 'qn_visibility 0' },
    { expect: /lobby: withdrawn/, then: 'qn_visibility 1' },
    { expect: /lobby: announced/, then: 'quit' },
  ];
  const b = await runPhase('live-edges', ['+qn_visibility', '1'], scriptB, bootstrap);
  if (b) { console.error('VISIBILITY FAIL B: ' + b); process.exit(1); }
  console.log('VISIBILITY: B ok (announce/withdraw/announce live)');

  /* C+D: shared throwaway HOME, no -qn-dir/-qn-statedir: engine must land
   * state at $HOME/.p2pquake/<fnv(socketdir)> */
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qnvis-home-'));
  const rt = path.join(home, 'rt');
  /* the engine's dir prep is single-level mkdir (XDG convention: the
   * runtime dir base exists already), so stage it like a real session */
  fs.mkdirSync(rt, { mode: 0o700 });
  const env = { HOME: home, XDG_STATE_HOME: '', XDG_RUNTIME_DIR: rt };
  const sockDir = path.join(rt, 'p2pquake');
  const tag = qnFnv1aHex(sockDir);
  let seedBytes = null;
  const c = await runPhase('default-root', [], quitOn(JOINCODE), bootstrap, [],
    { dirArgs: false, env, onComplete: () => {
        const root = path.join(home, '.p2pquake');
        const ents = fs.readdirSync(root);
        assert.deepStrictEqual(ents, [tag], 'exactly the engine-derived instance dir (tag from C hash must equal JS hash: ' + tag + ')');
        const idf = path.join(root, tag, 'identity.key');
        assert.ok(fs.existsSync(idf), 'identity.key in default state root');
        assert.strictEqual(modeOf(idf) & 0o077, 0, 'identity.key 0600 posture');
        seedBytes = fs.readFileSync(idf);
        posture(root, 'default state root');
        posture(path.join(root, tag), 'default instance dir');
        for (const n of walkNames(sockDir))
          assert.ok(n !== 'identity.key' && !n.startsWith('epoch-'),
            'no daemon state under the socket dir, found ' + n);
        const savedHome = process.env.HOME, savedXdg = process.env.XDG_STATE_HOME;
        try {
          process.env.HOME = home; process.env.XDG_STATE_HOME = '';
          assert.strictEqual(defaultStateDir(path.join(sockDir, 'engine.sock')),
            path.join(root, tag), 'manual daemon default lands on the engine dir');
          process.env.HOME = '';
          assert.strictEqual(defaultStateDir(path.join(sockDir, 'engine.sock')),
            path.join(sockDir, tag), 'no-HOME manual default mirrors the engine collapse');
        } finally {
          process.env.HOME = savedHome; process.env.XDG_STATE_HOME = savedXdg;
        }
      } });
  if (c) { console.error('VISIBILITY FAIL C: ' + c); process.exit(1); }
  console.log('VISIBILITY: C ok (default root ~/.p2pquake, C/JS instance tag agree)');

  const d = await runPhase('identity-reuse', [], quitOn(JOINCODE), bootstrap, [],
    { dirArgs: false, env, onComplete: () => {
        const idf = path.join(home, '.p2pquake', tag, 'identity.key');
        assert.deepStrictEqual(fs.readFileSync(idf), seedBytes, 'identity reused across runs, not regenerated');
      } });
  if (d) { console.error('VISIBILITY FAIL D: ' + d); process.exit(1); }
  console.log('VISIBILITY: D ok (identity persisted across runs)');

  /* E: no usable HOME → state collapses into the socket dir */
  const e = await runPhase('no-home-fallback', [], quitOn(JOINCODE), bootstrap, [],
    { dirArgs: false, env: { ...env, HOME: '' }, onComplete: () => {
        const ents = fs.readdirSync(sockDir);
        assert.ok(ents.includes('engine.sock'), 'socket present');
        assert.ok(ents.some((x) => /^[0-9a-f]{8}$/.test(x)), 'instance dir inside socket dir');
        assert.ok(fs.existsSync(path.join(sockDir, tag, 'identity.key')), 'fallback identity in socket dir');
        posture(sockDir, 'collapsed state root (socket dir)');
        posture(path.join(sockDir, tag), 'collapsed instance dir');
      } });
  if (e) { console.error('VISIBILITY FAIL E: ' + e); process.exit(1); }
  console.log('VISIBILITY: E ok (exotic-env fallback documented)');

  /* F/G: refuse paths on bad -qn-statedir values (the gate that keeps a
   * doomed root from ever being created or truncated into --dir) */
  /* an explicit too-long -qn-statedir cannot be launched at all (the
   * engine's own 256-byte command-line cap drops the trailing +cmds the
   * refusal needs), so the gate is tested through its env sibling —
   * same too-long refusal, reachable path */
  const longRoot = '/tmp/' + 'x'.repeat(248);
  const f = await runPhase('long-statedir-refused', [],
    [{ expect: /QN: state directory too long/, then: 'quit' }], bootstrap, [],
    { dirArgs: false,
      env: { HOME: home, XDG_STATE_HOME: longRoot,
             XDG_RUNTIME_DIR: path.join(home, 'rt') } });
  if (f) { console.error('VISIBILITY FAIL F: ' + f); process.exit(1); }
  console.log('VISIBILITY: F ok (too-long statedir refused, uncreated)');

  const g = await runPhase('relative-statedir-refused', [],
    [{ expect: /QN: state directory must be an absolute path/, then: 'quit' }],
    bootstrap, [], { statedirOverride: 'relative/state' });
  if (g) { console.error('VISIBILITY FAIL G: ' + g); process.exit(1); }
  console.log('VISIBILITY: G ok (relative statedir refused)');
  assert.ok(!fs.existsSync(longRoot), 'F left no stray directory');

  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* gone */ }
  if (typeof tnet.destroy === 'function') { try { await tnet.destroy(); } catch { /* gone */ } }
  console.log('VISIBILITY OK: seven phases — private default, live edges, state placement, refusals');
  process.exit(0);
}

main().catch((e) => { console.error('VISIBILITY crash: ' + (e && e.stack || e)); process.exit(1); });
