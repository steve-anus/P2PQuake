#!/usr/bin/env bash
# Run tests/qn_netbench.cjs under a set of link profiles. Each run gets a
# private network namespace (unprivileged: unshare -rn) whose loopback
# carries netem delay and loss, so the testnet, both daemons and the relay
# all see the same impaired link. Profiles are "one-way-delay-ms loss-%".
#
# Usage: tools/netbench.sh [--relay] [profile ...]
#   tools/netbench.sh "0 0" "25 0" "25 1" "25 3"
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TC=$(command -v tc || echo /usr/sbin/tc)
NODE=${NODE:-node}
relay=0
if [ "${1:-}" = "--relay" ]; then relay=1; shift; fi
[ "$#" -gt 0 ] || set -- "0 0" "25 0" "25 1" "25 3" "25 5"
[ -x "$ROOT/bin/fake-engine" ] || { echo "missing bin/fake-engine (make fake-engine)" >&2; exit 1; }

for prof in "$@"; do
  read -r delay loss <<<"$prof"
  [[ "$delay" =~ ^[0-9]+$ && "$loss" =~ ^[0-9]+(\.[0-9]+)?$ ]] \
    || { echo "bad profile: $prof" >&2; exit 1; }
  label="delay=${delay}ms loss=${loss}%"
  QN_BENCH_LABEL="$label" QN_BENCH_RELAY="$relay" \
    unshare -rn "$BASH" -c '
      set -e
      ip link set lo up
      if [ "$2" != 0 ] || [ "$3" != 0 ]; then
        "$1" qdisc add dev lo root netem delay "${2}ms" loss "${3}%"
      fi
      exec "$4" "$5"
    ' netbench "$TC" "$delay" "$loss" "$NODE" "$ROOT/tests/qn_netbench.cjs"
done
