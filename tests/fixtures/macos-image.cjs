'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { computeIdentity } = require('../../src/peer/qn-peer.cjs');
const identity = computeIdentity({
  gamedataPath: path.resolve(__dirname, '../../gamedata.sha256'), gamedir: 'id1',
});
let closed = false;
try { fs.fstatSync(3); } catch (e) { closed = e.code === 'EBADF'; }
process.stdout.write(JSON.stringify({ buildId: identity.buildId.toString(),
  binarySha: identity.binarySha.toString('hex'), platform: identity.platform.toString(), closed }));
