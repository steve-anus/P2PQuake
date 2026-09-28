#!/usr/bin/env node
'use strict';
/* Host-page inventory pin (spec 2 pools, host_cmd.c enumeration): the
 * client's map enumeration must surface campaign maps living inside the
 * base-dir paks, not just the disk-side deathmatch inventory. */
const { spawn } = require('./platform.cjs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ENGINE = process.env.QN_ENGINE ||
  path.join(ROOT, 'src', 'vendor', 'quakespasm', 'Quake', 'quakespasm');
const GAMEDATA = process.env.QN_GAMEDATA || path.join(ROOT, 'gamedata');

const lines = [];
let carry = '';
const absorb = (s) => s.on('data', (c) => {
  // chunks may split a line at any byte: carry the residue, never drop
  const parts = (carry + c.toString('utf8')).split(/\r?\n/);
  carry = parts.pop();
  for (const l of parts) lines.push(l);
});

const child = spawn('stdbuf', ['-oL', ENGINE, '-basedir', GAMEDATA, '+maps', '+quit'], {
  env: { ...process.env, SDL_VIDEODRIVER: 'offscreen', SDL_AUDIODRIVER: 'dummy' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
absorb(child.stdout);
absorb(child.stderr);

let done = false;
const timer = setTimeout(() => {
  try { child.kill('SIGKILL'); } catch (e) { /* gone */ }
  finish(1, 'MAPLIST FAIL: timeout waiting for the engine to list maps');
}, 60000);
function finish(rc, msg) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  if (msg) console.log(msg);
  process.exit(rc);
}

child.on('error', () => finish(1, 'MAPLIST FAIL: cannot spawn the engine'));

child.on('close', () => {
  if (carry) { lines.push(carry); carry = ''; }
  const want = ['start', 'lq_end', 'lq_e0m1', 'lq_e1m8',
    'lq_e2m7', 'lq_e3m7', 'lq_e4m8', 'lqdm1'];
  if (lines.some((l) => l.includes('no maps found')))
    return finish(1, 'MAPLIST FAIL: enumeration came back empty');
  const missing = want.filter((m) => !lines.some((l) => l.trim() === m));
  if (missing.length)
    return finish(1, 'MAPLIST FAIL: missing from the map list: ' + missing.join(', '));
  finish(0, 'MAPLIST OK: ' + want.length + ' required maps enumerated');
});
