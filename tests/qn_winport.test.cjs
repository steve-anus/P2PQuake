#!/usr/bin/env node
'use strict';
/* Windows-port pins that run on any OS: the pipe-name identity contract
 * between the engine (net_qn.c) and the daemon (qn-peer.cjs), and the
 * platform split of the mode-bit gates (Windows leans on the per-user
 * profile ACL, not on st.mode). The kernel seams themselves are proved
 * by the cross-compile and the owner's on-machine smoke sheet. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const peer = require('../src/peer/qn-peer.cjs');

function withPlatform(value, fn) {
  const saved = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try { return fn(); }
  finally {
    if (saved) Object.defineProperty(process, 'platform', saved);
    else delete process.platform;
  }
}

const PIPE = '\\\\.\\pipe\\p2pquake-';

test('win: defaultStateDir reuses the tag embedded by the engine', () => {
  const sockDir = 'C:/Users/dev/AppData/Local/p2pquake';
  const tag = peer.qnFnv1aHex(sockDir);          // what the engine hashes in
  assert.match(tag, /^[0-9a-f]{8}$/);
  const saved = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = 'C:\\QNdev\\AppData\\Local';
  try {
    const dir = withPlatform('win32', () => peer.defaultStateDir(PIPE + tag));
    assert.ok(dir.endsWith(path.sep + 'p2pquake' + path.sep + tag) &&
              dir.startsWith('C:'), 'dir=' + dir);
  } finally {
    if (saved === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved;
  }
});

test('win: malformed pipe names refuse the default state dir outright', () => {
  const saved = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = 'C:\\QNdev\\AppData\\Local';
  const bad = [
    PIPE + 'deadbeefG',            // non-hex tag
    PIPE + 'deadbee',              // short tag
    PIPE + 'deadbeef00',           // long tag
    '\\\\.\\pipe\\other-1a2b3c4d', // foreign namespace
    'C:\\QNdev\\p.sock',      // not a pipe at all
  ];
  for (const uds of bad) {
    const r = withPlatform('win32', () => peer.defaultStateDir(uds));
    assert.strictEqual(r, null, 'must refuse ' + uds);
  }
  if (saved === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = saved;
});

test('win: missing or relative LOCALAPPDATA refuses, never guesses', () => {
  const saved = process.env.LOCALAPPDATA;
  for (const la of [undefined, 'relative/path', '']) {
    if (la === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = la;
    const r = withPlatform('win32', () =>
      peer.defaultStateDir(PIPE + '1a2b3c4d'));
    assert.strictEqual(r, null, 'must refuse LOCALAPPDATA=' + String(la));
  }
  if (saved === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = saved;
});

test('win: identity gate skips the posix mode bits, keeps the shape checks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-win-id-'));
  try {
    const keyPath = path.join(dir, 'identity.key');
    fs.writeFileSync(keyPath, 'ab'.repeat(32) + '\n');
    fs.chmodSync(keyPath, 0o644);               // group-readable by posix lights
    fs.chmodSync(dir, 0o755);
    let threw = null;
    withPlatform('linux', () => {
      try { peer.ensureIdentity(dir); } catch (e) { threw = e; }
    });
    assert.ok(threw && /group\/other-accessible/.test(threw.message),
      'posix posture must still refuse world-readable state');
    threw = null;
    let id;
    withPlatform('win32', () => {
      try { id = peer.ensureIdentity(dir); } catch (e) { threw = e; }
    });
    assert.strictEqual(threw, null, 'win must not judge ACLs by mode bits');
    assert.ok(id && id.pub && id.pub.length === 32);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unix: defaultStateDir is untouched by the win branch', () => {
  const savedXdg = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = '/tmp/qn-xdg-pin';
  try {
    const dir = withPlatform('linux', () =>
      peer.defaultStateDir('/tmp/qn-xdg-pin/engine.sock'));
    assert.strictEqual(dir, path.join('/tmp/qn-xdg-pin', 'p2pquake',
      peer.qnFnv1aHex('/tmp/qn-xdg-pin')));
  } finally {
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdg;
  }
});

test('win: computeIdentity attests the engine image from --self-image', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-win-id2-'));
  try {
    const gd = path.join(dir, 'gamedata.sha256');
    fs.writeFileSync(gd, 'deadbeef  id1/pak0.pak\n');
    const img = path.join(dir, 'engine.exe');
    fs.writeFileSync(img, Buffer.concat([
      Buffer.from('QNBID:winpin.1\0', 'latin1'), Buffer.from('junk')]));
    const saved = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = 'C:\\QNdev\\AppData\\Local';
    let id = null, threw = null;
    withPlatform('win32', () => {
      try {
        id = peer.computeIdentity({ gamedataPath: gd, gamedir: 'id1',
          selfImage: img });
      } catch (e) { threw = e; }
    });
    if (saved === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved;
    assert.strictEqual(threw, null, String(threw));
    assert.strictEqual(id.buildId.toString('utf8'), 'winpin.1');
    assert.strictEqual(id.binarySha.length, 32);
    assert.strictEqual(id.platform.toString('latin1'), 'win32-x64');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('win: markerless or unnamed parent image refuses the join outright', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-win-id3-'));
  try {
    const gd = path.join(dir, 'gamedata.sha256');
    fs.writeFileSync(gd, 'x');
    const noMark = path.join(dir, 'no.exe');
    fs.writeFileSync(noMark, Buffer.from('nothing here'));
    const call = (fn) => { let t = null; withPlatform('win32', () => {
      try { fn(); } catch (e) { t = e; } }); return t; };
    assert.ok(call(() => peer.computeIdentity({ gamedataPath: gd,
      gamedir: 'id1', selfImage: noMark })), 'markerless must refuse');
    assert.ok(call(() => peer.computeIdentity({ gamedataPath: gd,
      gamedir: 'id1' })), 'missing --self-image must refuse');
    let t = null; withPlatform('linux', () => {
      try { peer.computeIdentity({ gamedataPath: gd, gamedir: 'id1',
        selfImage: noMark }); } catch (e) { t = e; } });
    assert.ok(t && /windows-only/.test(t.message),
      'posix must refuse --self-image, never read it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
