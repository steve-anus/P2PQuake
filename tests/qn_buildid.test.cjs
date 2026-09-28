#!/usr/bin/env node
'use strict';
/* Build-identity contract (spec §3.4a): the wire closure is audited,
 * deterministic, and stays inside the join-lane charset on every branch.
 * Platform-local translation files (*_win.*) must never enter the hash. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const run = (target) => execFileSync('make', ['-s', target],
  { cwd: ROOT, encoding: 'utf8' }).trim();

const REQUIRED = [
  'src/vendor/quakespasm/Quake/net_qn.c',
  'src/protocol/qn_protocol.md',
  'src/peer/qn-peer.cjs', 'src/peer/qn_planeb.cjs', 'src/peer/qn_room.cjs',
  'src/peer/qn_envelope.cjs', 'src/peer/qn_frame.cjs', 'src/peer/qn-relay.cjs',
  'src/peer/qn-relayauto-patch.cjs', 'src/peer/qn_lobby.cjs',
  'src/peer/qn_lobbyd.cjs',
  'src/driver/qn_transport.c', 'src/driver/qn_transport.h',
  'src/driver/qn_frame.c', 'src/driver/qn_frame.h',
  'src/driver/qn_causes.c', 'src/driver/qn_causes.h',
  'src/driver/qn_scmd.c', 'src/driver/qn_scmd.h',
  'src/driver/qn_pad.c', 'src/driver/qn_pad.h',
  'src/driver/qn_stext.c', 'src/driver/qn_stext.h',
  'src/driver/qn_maps.c', 'src/driver/qn_maps.h',
  'src/driver/qn_spawn.c', 'src/driver/qn_spawn.h',
];

test('wire closure: audited membership, no platform-local files', () => {
  const wire = run('print-wire').split(/\s+/).filter(Boolean);
  assert.ok(wire.some((f) => f.startsWith('qn-patches/') &&
    f.endsWith('.patch')), 'patch series must be hashed');
  for (const f of REQUIRED) assert.ok(wire.includes(f), 'missing ' + f);
  for (const f of wire) {
    assert.ok(!/_win\.[ch]$/.test(f), 'platform-local file in closure: ' + f);
    assert.ok(f !== 'src/driver/qn_buildid.h', 'generated header in closure');
    assert.ok(fs.existsSync(path.join(ROOT, f)), 'listed but absent: ' + f);
  }
  assert.deepStrictEqual(wire, [...new Set(wire)].sort(),
    'closure must be sorted and duplicate-free (deterministic hash)');
});

test('buildid: stable, version-derived, join-shape-safe', () => {
  const version = fs.readFileSync(path.join(ROOT, 'VERSION'),
    'utf8').trim();
  const id = run('print-buildid');
  assert.match(id, new RegExp('^' + version.replace(/\./g, '\\.') +
    'p[0-9a-f]{16}(-dirty)?$'));
  assert.strictEqual(run('print-buildid'), id);
  assert.match(id, /^[A-Za-z0-9._+-]{1,64}$/);
});
