#!/usr/bin/env python3
"""PTY bridge for macOS tests whose parent stdin is a Node pipe, not a tty.

All descendants stay in the caller's process group so its existing group
cleanup reaches the engine and peer as well as this bridge.
"""
import errno
import os
import pty
import selectors
import subprocess
import sys
import termios

master, slave = pty.openpty()
attrs = termios.tcgetattr(slave)
attrs[3] &= ~termios.ECHO
termios.tcsetattr(slave, termios.TCSANOW, attrs)
child = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave,
                         close_fds=True)
os.close(slave)
selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ)
selector.register(sys.stdin.fileno(), selectors.EVENT_READ)
with open(sys.argv[1], 'wb', buffering=0) as log:
    while selector.get_map():
        for key, _ in selector.select(timeout=0.1):
            try:
                data = os.read(key.fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b''
            if not data:
                selector.unregister(key.fd)
                if key.fd == master:
                    selector.close()
                    break
                continue
            if key.fd == master:
                log.write(data)
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            else:
                os.write(master, data)
        if child.poll() is not None and not selector.get_map():
            break
os.close(master)
status = child.wait()
sys.exit(status if status >= 0 else 128 - status)
