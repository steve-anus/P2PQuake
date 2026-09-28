#!/bin/sh
# Run a self-operated DHT bootstrap node for an isolated match network.
# Thin wrapper over the hyperdht CLI shipped in the pinned dependency, so a
# friend group can run its own network instead of relying on the public
# commons nodes (the node argument list then points at this machine).
#
# Usage:  tools/bootstrap-node.sh --port 49737 --host <public-ip> [args...]
# --host is the IPv4 address friends can reach you at (the CLI requires
# it: the node announces that address). Args pass through to the CLI.
# The port must be reachable (UDP). Keep at least one such node running
# persistently for an isolated network to stay operational.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIN=
for CAND in "$DIR/../node_modules/.bin/hyperdht" \
              "$DIR/../src/peer/node_modules/.bin/hyperdht"; do
  [ -x "$CAND" ] && { BIN="$CAND"; break; }
done
[ -n "$BIN" ] || { echo "run 'make peer' first (missing hyperdht .bin)" >&2; exit 1; }
# The CLI decides bootstrap mode from the token AFTER --bootstrap (it must
# start with `--`, hyperdht bin.js isBootstrap). A non-flag first argument
# here would silently boot a plain public-DHT node instead: fail loud.
if [ "$#" -gt 0 ]; then
  case "$1" in
    --*) ;;
    *) echo "args must be CLI flags, e.g. --port 49737 --host <public-ip>" >&2; exit 1 ;;
  esac
fi
exec "$BIN" --bootstrap "$@"
