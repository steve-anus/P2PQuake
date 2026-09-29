# Blind relay with PM2 on Linux

The relay forwards encrypted peer traffic when peers cannot connect directly.
It sees addresses, timing and sizes, but not game contents. It is neither a
Quake game server nor a replacement for DHT discovery. Clients still need
compatible builds and a working connection to the DHT.

Use a dedicated unprivileged account. Install this repository at `~/app`, with
the pinned Node 24 runtime at `~/app/bin/node` and dependencies from the lockfile.
No game assets, renderer or engine build are needed:

```sh
cd ~/app
bash tools/setup-nodejs.sh --force
export PATH="$HOME/app/bin/node/bin:$PATH"
npm ci --omit=dev --ignore-scripts
npm install --prefix "$HOME/process-manager" --save-exact --omit=dev --ignore-scripts pm2@7.0.4
export PM2_HOME="$HOME/.pm2"
alias pm2="$HOME/process-manager/node_modules/.bin/pm2"
```

Choose an unused reachable UDP port. The default is 49737; on shared servers
check existing listeners first. The service fails if its configured port is
busy, rather than silently choosing another port. Do not replace another
application's listener or firewall policy. Public DHT bootstrap addresses are
included in the ecosystem file; private networks must supply their own.

```sh
QN_RELAY_PORT=49737 pm2 start ~/app/contrib/relay/ecosystem.config.cjs
pm2 install pm2-logrotate@3.0.0
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
pm2 save
```

`RELAY-READY` in the application log publishes the public key clients use.
The private 32-byte `~/.p2pquake-relay/relay.seed` must remain mode 0600.
Back it up securely: losing it changes the public key after restart. Run one
relay instance per seed, never PM2 cluster mode. The relay is public to anyone
who knows its key; its session/pair limits do not impose a bandwidth quota.

To start after logout and reboot, an administrator enables lingering for this
account once (`loginctl enable-linger <relay-user>`). As the relay user:

```sh
mkdir -p ~/.config/systemd/user
cp ~/app/contrib/relay/pm2-relay.service ~/.config/systemd/user/
systemctl --user daemon-reload
pm2 kill
systemctl --user enable --now pm2-relay.service
systemctl --user status pm2-relay.service
pm2 list
```

The stop/start above affects only this dedicated account's PM2 instance and
tests the same `pm2 resurrect` path used at boot. No server reboot is needed.
The user service limits the entire PM2 group to 512 MiB and half a CPU core;
PM2 also restarts the relay when its memory exceeds 256 MiB. Adjust these
limits for measured capacity. Log rotation is scoped to this user's PM2 logs.
After changing application settings, use `pm2 save` again.

Both players can launch with the published public key:

```sh
QN_RELAY_THROUGH=<64-hex-public-key> ./macos/run.sh
```

The same environment variable applies to Linux/Windows launchers. Normally
direct connections remain preferred. Add `QN_RELAY_ONLY=1` on both ends to
verify relay traffic; remove it for normal fallback operation. Confirm
`RELAY-STATS` shows active pairs and opened streams during that test. A relay
can help connection failures, but does not improve rendering FPS and may add
latency compared with a working direct path.
