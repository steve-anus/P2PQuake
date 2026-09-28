#!/bin/sh
# Source-tree launcher. The repo-local Node runtime also reaches the spawned
# peer's /usr/bin/env shebang; the engine itself never searches for the peer.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -x "$ROOT/bin/node/bin/node" ]; then
    PATH="$ROOT/bin/node/bin:$PATH"
    export PATH
fi
cd "$ROOT"
exec "$ROOT/src/vendor/quakespasm/Quake/quakespasm" \
    -basedir "$ROOT/gamedata" -qn-peer "$ROOT/src/peer/qn-peer.cjs" "$@"
