#!/bin/sh
# Run a self-operated DHT bootstrap node for an isolated match network.
# Thin wrapper over the hyperdht CLI shipped in the pinned dependency, so a
# friend group can run its own network instead of relying on the public
# commons nodes (the node argument list then points at this machine).
#
# Usage:  tools/bootstrap-node.sh [--port 49737] [--host <public-ip>] [args...]
# The port must be reachable (UDP). Keep at least one such node running
# persistently for an isolated network to stay operational.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIN="$DIR/../src/peer/node_modules/.bin/hyperdht"
[ -x "$BIN" ] || { echo "run 'make peer' first (missing $BIN)" >&2; exit 1; }
exec "$BIN" --bootstrap "$@"
