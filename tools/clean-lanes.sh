#!/bin/bash
# clean-lanes.sh — sweep lane scratch dirs abandoned by crashed or
# SIGKILLed runs (graceful exits self-clean via the test files' exit
# hooks). Deliberately paranoid: only directories that match this
# project's mkdtemp naming exactly, belong to the invoking user, and
# are older than an hour (so concurrent lanes are never touched).
set -u
WHO=$(id -un)
BASE="${TMPDIR:-/tmp}"

sweep_ere() { # <relative regex>
  find "$BASE" -maxdepth 1 -mindepth 1 -type d \
    -regextype posix-extended -regex "$1" \
    -user "$WHO" -mmin +60 \
    -exec rm -rf {} + 2>/dev/null || true
}

for re in \
  '.*/qntr-[A-Za-z0-9]{6}$' \
  '.*/qnlobbyd-[A-Za-z0-9]{6}$' \
  '.*/qndisc-[A-Za-z0-9]{6}$' \
  '.*/qnlobby-[A-Za-z0-9]{6}$' \
  '.*/qn2p-[A-Za-z0-9]{6}$' \
  '.*/qnvis-[A-Za-z0-9]{6}$' \
  '.*/qnvis-home-[A-Za-z0-9]{6}$' \
  '.*/qnpeer-test-[A-Za-z0-9]{6}$' \
  '.*/qnpt-st-[A-Za-z0-9]{6}$' \
  '.*/qnpt-root-[A-Za-z0-9]{6}$' \
  '.*/qnloop-[A-Za-z0-9]{6}$' \
  '.*/qnvis-probe-[A-Za-z0-9]{6}$' \
  '.*/qn-idn-[A-Za-z0-9]{6}$' \
  '.*/p2pquake-e2e-[A-Za-z0-9]{6}$' \
  '.*/qnpb-[A-Za-z0-9-]{1,20}$' \
  '.*/qnspawn[A-Za-z0-9]{6}$' \
  '.*/qn-node-[A-Za-z0-9]{6}$' \
  '.*/qndbg\.[A-Za-z0-9]{4}$' \
  '.*/qnrelease-[A-Za-z0-9]{6}$'
do
  sweep_ere "$re"
done
exit 0
