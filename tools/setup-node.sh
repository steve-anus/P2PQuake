#!/bin/bash
# setup-node.sh — repo-local Node bootstrap for source builders.
# Fetches the pinned official Node 24 tarball into bin/node/ after hash
# verification; never writes outside the repo tree or $TMPBASE, never
# touches a system or user toolchain.
set -euo pipefail

NODE_VERSION=v24.21.0
NODE_ARCH=linux-x64
NODE_TARBALL="node-${NODE_VERSION}-${NODE_ARCH}.tar.xz"
NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
DIST_URL=https://nodejs.org/dist/${NODE_VERSION}

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="$REPO_ROOT/bin/node"
TMPBASE=${TMPDIR:-/tmp}

force=0
[ "${1:-}" = "--force" ] && force=1
[ $# -gt 1 ] && { echo "usage: setup-node.sh [--force]" >&2; exit 2; }

if [ -x "$DEST/bin/node" ] && [ "$force" -ne 1 ]; then
  echo "bin/node exists; refusing (pass --force to reinstall)" >&2
  exit 1
fi

if [ "$force" -ne 1 ] && command -v node >/dev/null 2>&1; then
  have=$(node --version)
  if [ "$have" != "${have#v24.}" ]; then
    echo "node $have on PATH; nothing to fetch"
    exit 0
  fi
fi

for tool in curl sha256sum tar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool" >&2; exit 1; }
done

WORK=$(mktemp -d "$TMPBASE/qn-node-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

curl -fsS --retry 2 --max-time 120 -o "$WORK/$NODE_TARBALL" "$DIST_URL/$NODE_TARBALL"
curl -fsS --retry 2 --max-time 60 -o "$WORK/SHASUMS256.txt" "$DIST_URL/SHASUMS256.txt"

line=$(grep -F "  $NODE_TARBALL" "$WORK/SHASUMS256.txt" || true)
[ -n "$line" ] || { echo "tarball absent from SHASUMS256.txt" >&2; exit 1; }
published=${line%% *}
got=$(sha256sum "$WORK/$NODE_TARBALL" | cut -d' ' -f1)
if [ "$got" != "$published" ] || [ "$got" != "$NODE_SHA256" ]; then
  echo "hash mismatch: got $got, SHASUMS says $published, pin $NODE_SHA256" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
tar -xJf "$WORK/$NODE_TARBALL" -C "$DEST" --strip-components=1
[ -x "$DEST/bin/node" ] || { echo "extract produced no bin/node" >&2; exit 1; }
echo "installed $("$DEST/bin/node" --version) at $DEST/bin/node"
