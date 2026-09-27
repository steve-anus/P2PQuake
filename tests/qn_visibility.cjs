#!/usr/bin/env node
'use strict';
/* tests/qn_visibility.cjs — host-page visibility edges (engine side).
 * Real dedicated engine (pty-wrapped so the console takes scripted
 * commands, the qn_twoplayer idiom) + real qn-peer daemon on a hyperdht
 * testnet. Phase A proves closed-by-default: a hosted room with no
 * visibility command never announces. Phase B drives the pump's live
 * edges: public announces, private withdraws, public announces again —
 * no match restart anywhere, one host lane throughout. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const createTestnet = require('hyperdht/testnet');

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

function runPhase(name, boot, script, bootstrap, extraBanned) {
  const killList = banned.concat(extraBanned || []);
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qnvis-'));
    const args = ['-qn', '-qn-peer', PEER, '-qn-dir', dir,
      '-basedir', GAMEDATA, '-dedicated',
      '+listen', '+map', 'lqdm1', ...boot];
    const child = spawn('stdbuf', ['-i0', 'script', '-qef',
      '-O', path.join(dir, 'console.txt'), '-c',
      [ENGINE, ...args].map(shq).join(' ')], {
      detached: true,
      env: { ...process.env, QN_DHT_BOOTSTRAP: bootstrap,
             SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
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
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
      resolve(fail || (why === 'ok' ? null : `${name}: ${why}`));
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
        const cur = script[step];
        if (cur && cur.expect.test(t)) {
          step++;
          if (cur.then) setTimeout(() => send(cur.then), 200);
          if (step === script.length) { completed = true; setTimeout(() => finish('ok'), 400); }
        }
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('exit', () => finish(completed ? 'ok' : `exit at ${step}/${script.length}`));
  });
}

async function main() {
  if (!fs.existsSync(ENGINE)) { console.error('no engine binary (make engine)'); process.exit(1); }
  const tnet = await createTestnet(3);
  const bootstrap = tnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(',');
  console.log('VISIBILITY: bootstrap=' + bootstrap);

  const scriptA = [
    { expect: /Join code: [0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/, then: 'quit' },
  ];
  /* absence is asserted, not inferred: a stray advertisement fails A
   * outright, so the default-private claim has its own referee */
  const a = await runPhase('private-by-default', [], scriptA, bootstrap,
    [['stray-advert', /lobby: announced/]]);
  if (a) { console.error('VISIBILITY FAIL A: ' + a); process.exit(1); }
  console.log('VISIBILITY: A ok (private by default)');

  const scriptB = [
    { expect: /lobby: announced/, then: 'qn_status' },
    { expect: /visibility public/, then: 'qn_visibility 0' },
    { expect: /lobby: withdrawn/, then: 'qn_visibility 1' },
    { expect: /lobby: announced/, then: 'quit' },
  ];
  const b = await runPhase('live-edges', ['+qn_visibility', '1'], scriptB, bootstrap);
  if (b) { console.error('VISIBILITY FAIL B: ' + b); process.exit(1); }

  if (typeof tnet.destroy === 'function') { try { await tnet.destroy(); } catch { /* gone */ } }
  console.log('VISIBILITY OK: private-by-default + live announce/withdraw/announce edges');
  process.exit(0);
}

main().catch((e) => { console.error('VISIBILITY crash: ' + (e && e.stack || e)); process.exit(1); });
