'use strict';
// Keep the same engine tests on BSD/macOS: GNU stdbuf/script are not
// installed there, and graphical Metal clients require SDL's Cocoa driver.
const cp = require('node:child_process');
const path = require('node:path');
function spawn(command, args, options = {}) {
  if (process.platform !== 'darwin' || command !== 'stdbuf')
    return cp.spawn(command, args, options);
  args = [...args];
  args.shift(); // -oL / -i0: the native engine flushes console lines itself
  command = args.shift();
  if (command === 'script') {
    const output = args[args.indexOf('-O') + 1];
    const shellCommand = args[args.indexOf('-c') + 1];
    command = 'python3';
    args = [path.join(__dirname, 'pty-launch.py'), output, '/bin/sh', '-c', shellCommand];
  }
  const env = { ...options.env, QN_METAL_HEADLESS: '1' };
  if (env.SDL_VIDEODRIVER === 'offscreen') env.SDL_VIDEODRIVER = 'cocoa';
  return cp.spawn(command, args, { ...options, env });
}
module.exports = { spawn };
