#!/usr/bin/env node
'use strict';
/* Scripted lane: engine-side public-lobby browser integrity. The
 * engine runs dedicated with tests/fake_daemon_lobby.cjs as its -qn-peer;
 * the fake streams honest and hostile LOBBY_LIST runs while the engine,
 * under the QN_LOBBY_DUMP=1 lab knob, prints QNLOBBY swap markers. The
 * lane asserts: honest field truth, the roster-grade mask on control
 * bytes, silent drops (oversize, bad width), an interrupted run that
 * never swaps, a poisoned over-cap run, and recovery afterwards.
 * Run: node tests/qn_lobbybrowser.cjs (after `make engine`).
 * Exit 0 = LOBBYBROWSER OK. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ENGINE = process.env.QN_ENGINE ||
  path.join(ROOT, 'src', 'vendor', 'quakespasm', 'Quake', 'quakespasm');
const FAKE = path.join(__dirname, 'fake_daemon_lobby.cjs');
const GAMEDATA = process.env.QN_GAMEDATA || path.join(ROOT, 'gamedata');
const BUDGET_MS = 45000;

let assertions = 0;
const children = [];
function die(why) {
  console.log('LOBBYBROWSER FAIL ' + why);
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  process.exit(1);
}
const ok = (fn, why) => {
  try { fn(); assertions++; } catch (e) { die(why + ' :: ' + e.message); }
};

async function waitFor(pred, what, ms = 25000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  die('timeout waiting for ' + what);
}

async function main() {
  const hard = setTimeout(() => die('budget exhausted'), BUDGET_MS);
  if (!fs.existsSync(ENGINE)) die('missing engine (' + ENGINE + ')');
  if (!fs.existsSync(FAKE)) die('missing fake daemon (' + FAKE + ')');
  if (!(fs.statSync(FAKE).mode & 0o100)) die('fake daemon must be executable (mode *75)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qnlobby-'));

  const child = spawn('stdbuf', ['-oL', ENGINE,
    '-qn', '-qn-peer', FAKE, '-qn-dir', dir,
    '-basedir', GAMEDATA, '-dedicated',
    '+listen', '+map', 'lqdm1',
  ], {
    env: { ...process.env, QN_LOBBY_DUMP: '1',
      SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const out = [], err = [];
  child.stdout.on('data', (c) => out.push(c.toString()));
  child.stderr.on('data', (c) => err.push(c.toString()));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null)
      die('engine exited code ' + code + ' :: ' + out.join('').slice(-400));
  });
  const outText = () => out.join('');
  const errText = () => err.join('');

  await waitFor(() => errText().includes('script complete ok'), 'fake script completion');
  await new Promise((r) => setTimeout(r, 800));                 // let the last swap flush
  const text = outText();

  ok(() => assert.equal((text.match(/^QNLOBBY n=/gm) || []).length, 4,
    'swaps:\n' + text.slice(-1500)), 'exactly four swaps (runs 4 and 5 must never swap)');
  ok(() => assert.ok(text.includes('QNLOBBY n=1') &&
    text.includes('title=Alpha Room map=lqdm1 mode=1 players=3/8 mine=0'),
    'honest run fields'), 'run1 honest fields');
  ok(() => assert.ok(text.includes('QNLOBBY n=2') &&
    text.includes('title=Beta Room map=lq_e1m1 mode=1 players=3/4 mine=0'),
    'two-row snapshot'), 'run2 second row');
  ok(() => assert.ok(text.includes('title=Bad.Name. map=evil map! mode=1'),
    'control bytes must become dots'), 'roster-grade mask on remote bytes');
  ok(() => assert.ok(/QNLOBBY n=0\b/.test(text),
    'all-bad snapshot swaps to empty'), 'run3 empty swap');
  ok(() => assert.ok(text.includes('title=Recovered'),
    'view recovers after interrupted and poisoned runs'), 'run6 recovery');
  const i1 = text.indexOf('title=Alpha Room');
  const i2 = text.indexOf('title=Beta Room');
  const i0 = text.indexOf('QNLOBBY n=0');
  const i6 = text.indexOf('title=Recovered');
  ok(() => assert.ok(i1 >= 0 && i1 < i2 && i2 < i0 && i0 < i6,
    'marker order ' + [i1, i2, i0, i6]), 'swap markers arrive in run order');
  ok(() => assert.ok(!/F0\b|BadWidth|Oversize/.test(text),
    'dropped adverts must never print'), 'silent drops stay silent');
  ok(() => assert.ok(!text.includes('FATAL'), 'no fatal teardown'), 'engine unharmed');
  ok(() => assert.equal(child.exitCode, null), 'engine still running');

  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  clearTimeout(hard);
  console.log(`LOBBYBROWSER OK: ${assertions} assertions`);
  process.exit(0);
}

main().catch((e) => die('crash: ' + (e && e.stack || e)));
