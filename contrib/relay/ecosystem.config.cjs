'use strict';

const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '../..');

module.exports = { apps: [{
  name: 'p2pquake-relay',
  cwd: root,
  script: path.join(root, 'src/peer/qn-relay.cjs'),
  interpreter: path.join(root, 'bin/node/bin/node'),
  instances: 1,
  exec_mode: 'fork',
  autorestart: true,
  restart_delay: 5000,
  min_uptime: 30000,
  max_restarts: 1000000, // retry after a prolonged network outage at boot
  max_memory_restart: '256M',
  kill_timeout: 12000,
  time: true,
  env: {
    NODE_ENV: 'production',
    QN_DHT_BOOTSTRAP: 'node1.hyperdht.org:49737,node2.hyperdht.org:49737,node3.hyperdht.org:49737',
    QN_RELAY_PORT: process.env.QN_RELAY_PORT || '49737',
    QN_RELAY_STATE: path.join(os.homedir(), '.p2pquake-relay/relay.seed')
  }
}] };
