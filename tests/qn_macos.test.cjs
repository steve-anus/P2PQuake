'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Q = require('../src/peer/qn-peer.cjs');
const ROOT = path.resolve(__dirname, '..');
const onlyMac = { skip: process.platform !== 'darwin' && 'Darwin process primitives' };

test('macOS: spawned peer attests inherited engine bytes and closes its image fd', onlyMac, () => {
  const exe = path.join(ROOT, 'bin/fake-engine');
  const r = spawnSync(exe, [], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, QN_FAKE_ENGINE_NODE: process.execPath,
      QN_FAKE_ENGINE_SCRIPT: path.join(__dirname, 'fixtures/macos-image.cjs') } });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  const image = fs.readFileSync(exe);
  assert.equal(got.buildId, Q.extractBuildId(image).toString());
  assert.equal(got.binarySha, crypto.createHash('sha256').update(image).digest('hex'));
  assert.equal(got.platform, `darwin-${process.arch}`);
  assert.equal(got.closed, true);
});

test('macOS: absent engine fd and untrusted image-path argument fail closed', onlyMac, () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/macos-image.cjs')],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.signal, null, r.stderr);
  assert.equal(r.status, 1, r.stderr);
  assert.throws(() => Q.computeIdentity({ gamedataPath: path.join(ROOT, 'gamedata.sha256'),
    gamedir: 'id1', selfImage: process.execPath }), /windows-only/);
});

test('macOS: instance hygiene retains unprovable process liveness', onlyMac, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qnpt-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = path.join(root, 'aaaaaaaa'); fs.mkdirSync(current);
  Q.writeInstanceMeta(current, path.join(root, 'live', 'qn.sock'));
  const meta = JSON.parse(fs.readFileSync(path.join(current, 'instance.json'), 'utf8'));
  assert.equal(meta.sockDir, path.join(root, 'live'));
  assert.equal(meta.pid, undefined, 'no invented Linux kernel liveness triple');
  const old = path.join(root, 'bbbbbbbb'); fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, 'instance.json'), JSON.stringify({ sockDir: path.join(root, 'gone'),
    pid: 2000000000, boot: '0', bootId: 'unknown' }));
  const when = new Date(Date.now() - 200 * 24 * 3600 * 1000);
  fs.utimesSync(old, when, when);
  assert.deepEqual(Q.reapStaleInstances(root, current, Date.now()), []);
  assert.ok(fs.existsSync(old));
});
