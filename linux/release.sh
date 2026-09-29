#!/bin/bash
# release.sh — assemble, verify, pack, and sign the portable Linux build.
#
# Builds the working tree (like windows/winpack.sh — tag what you bless), then
# assembles a self-contained directory:
#   p2pquake-<ver>/
#     quakespasm          engine binary (stripped; path-leak gate)
#     qn-peer             node launcher the engine execs via <exe-dir>/qn-peer
#     runtime/node        pinned interpreter (execveat target of packaged spawn)
#     src/peer/*.cjs      daemon (kept at depth 2: manifest path is
#                         __dirname/../../gamedata.sha256)
#     gamedata.sha256     verified byte-exact against id1/
#     id1/**              game assets (package root: quakespasm's basedir
#                         is the binary's own directory — zero flags needed)
#     node_modules/**     production deps only (npm prune --omit=dev)
#     LICENSE.md          shipped verbatim from the repo root
#     VERSION
# Output lands in dist/<ver>/ (zip + platform-named sha256sums file + .sig).
# Signing key comes from QN_SIGN_KEY (ssh-keygen -Y); --dry-run generates
# an ephemeral key and keeps the zip marked unsigned-for-distribution.
set -euo pipefail

usage() { echo "usage: release.sh [--dry-run]" >&2; exit 2; }

dryrun=0
for a in "$@"; do
  case "$a" in
    --dry-run) dryrun=1 ;;
    *) usage ;;
  esac
done

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"
TMPBASE=${TMPDIR:-/tmp}

command -v zip >/dev/null || { echo "linux/release.sh: zip missing" >&2; exit 1; }
command -v strip >/dev/null || { echo "linux/release.sh: strip missing" >&2; exit 1; }
command -v ssh-keygen >/dev/null || { echo "linux/release.sh: ssh-keygen missing" >&2; exit 1; }
command -v npm >/dev/null || { echo "linux/release.sh: npm missing" >&2; exit 1; }


NODE_VER=$(grep -m1 '^NODE_VERSION=' tools/setup-nodejs.sh | cut -d= -f2)
NODE_PIN=$(tools/setup-nodejs.sh --print-pin)
[ "${#NODE_PIN}" = 64 ] && [ -n "$NODE_VER" ] \
  || { echo "linux/release.sh: could not read the node pin from setup-nodejs.sh" >&2; exit 1; }

echo "==> battery: operator precondition — run 'make check' before this script"

echo "==> bootstrap-node lane (operator surface, minutes-heavy; release-only)"
make bootstrap-node

echo "==> engine-verify (pin + qn-patches series == tree)"
make engine-verify

echo "==> engine build"
make engine
ENGINE_BIN=src/vendor/quakespasm/Quake/quakespasm
[ -x "$ENGINE_BIN" ] || { echo "linux/release.sh: engine binary missing" >&2; exit 1; }

echo "==> runtime/node ($NODE_VER via pinned tarball; setup-nodejs.sh enforces the sha256)"
# The pin is the TARBALL hash (nodejs.org SHASUMS256); --force makes the
# installer always refetch-and-verify, never take a PATH-node shortcut.
if [ ! -x bin/node/bin/node ] || \
   [ "$(bin/node/bin/node --version 2>/dev/null)" != "$NODE_VER" ]; then
  tools/setup-nodejs.sh --force
fi
[ "$(bin/node/bin/node --version 2>/dev/null)" = "$NODE_VER" ] \
  || { echo "linux/release.sh: runtime node is not $NODE_VER" >&2; exit 1; }

STAGE=$(mktemp -d "$TMPBASE/qnrelease-XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
ver=$(cat VERSION)
PKG="$STAGE/p2pquake-$ver"
mkdir -p "$PKG"/{id1,src/peer,runtime,node_modules}

echo "==> gamedata (byte-exact, manifest-verified)"
# id1 sits directly at the package root: the engine's basedir is the binary's
# own directory, so ./quakespasm needs no flags. The manifest keeps its
# package-root home (the daemon resolves it at __dirname/../../).
cp -a gamedata/id1/. "$PKG/id1/"
rm -f "$PKG/id1/config.cfg"
rm -rf "$PKG"/id1/qn-lane-tmp*
cp gamedata.sha256 "$PKG/gamedata.sha256"
(cd "$PKG/id1" && sha256sum -c ../gamedata.sha256 >/dev/null) \
  || { echo "linux/release.sh: gamedata failed the manifest check" >&2; exit 1; }

echo "==> peer daemon"
cp src/peer/*.cjs "$PKG/src/peer/"
cp package.json package-lock.json "$PKG/"
if [ -d node_modules ]; then
  cp -a node_modules "$PKG/node_modules.tmp"
  rm -rf "$PKG/node_modules"
  mv "$PKG/node_modules.tmp" "$PKG/node_modules"
  (cd "$PKG" && npm prune --omit=dev --no-audit --no-fund >/dev/null)
else
  (cd "$PKG" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
fi
[ -d "$PKG/node_modules/hyperdht" ] \
  || { echo "linux/release.sh: production node_modules missing hyperdht" >&2; exit 1; }

echo "==> engine binary + launcher + runtime"
[ -f LICENSE.md ] || { echo "linux/release.sh: LICENSE.md missing" >&2; exit 1; }
cp LICENSE.md "$PKG/LICENSE.md"
[ -f README.md ] || { echo "linux/release.sh: README.md missing" >&2; exit 1; }
cp README.md "$PKG/README.md"
[ -f p2pquake.desktop ] || { echo "linux/release.sh: p2pquake.desktop missing" >&2; exit 1; }
cp p2pquake.desktop "$PKG/p2pquake.desktop"
cp "$ENGINE_BIN" "$PKG/quakespasm"
strip --strip-debug "$PKG/quakespasm" 2>/dev/null || strip "$PKG/quakespasm"
chmod 0755 "$PKG/quakespasm"
if strings "$PKG/quakespasm" | grep -qE "/home/|/Users/|/root/"; then
  echo "linux/release.sh: engine binary leaks the build home path" >&2
  exit 1
fi
# Shipped-bytes hygiene (conventions: absence proven, all artifacts): our
# build paths are gone by construction, so any personal identity reaching
# the package is the finding. Generic /home/ scans would false-positive on
# vendor strings (node's own /home/iojs), hence targeted personal scan.
ME_USER="${USER:-$(id -un)}"; ME_HOME="$HOME"
[ -n "$ME_USER" ] && [ -n "$ME_HOME" ] \
  || { echo "linux/release.sh: cannot determine identity for the leak scan" >&2; exit 1; }
if grep -rlI -e "$ME_HOME" -e "/home/$ME_USER" -e "/Users/$ME_USER" -e "/root/$ME_USER" "$PKG"; then
  echo "linux/release.sh: shipped text leaks a personal home path (listed above)" >&2
  exit 1
fi
if strings "$PKG/runtime/node" | grep -qE "$ME_HOME|/home/$ME_USER|/Users/$ME_USER|/root/$ME_USER"; then
  echo "linux/release.sh: shipped runtime leaks a personal home path" >&2
  exit 1
fi
printf '#!/usr/bin/env node\n// Engine-execed daemon launcher (packaged layout).\n// require() alone never runs main(): the module guard checks require.main,\n// which is this launcher. cliMain() is the single CLI bootstrap.\nrequire("./src/peer/qn-peer.cjs").cliMain();\n' > "$PKG/qn-peer"
chmod 0755 "$PKG/qn-peer"
cp bin/node/bin/node "$PKG/runtime/node"
chmod 0755 "$PKG/runtime/node"
cp VERSION "$PKG/VERSION"

echo "==> package + hashes"
DIST="dist/$ver"
mkdir -p "$DIST"
ZIP="p2pquake-$ver-linux-x64.zip"
rm -f "$DIST/$ZIP" "$DIST/$ZIP.sig" "$DIST/sha256sums-linux-x64.txt"
(cd "$STAGE" && zip -qrX "$REPO_ROOT/$DIST/$ZIP" "p2pquake-$ver")
(cd "$DIST" && sha256sum "$ZIP" > sha256sums-linux-x64.txt)

verify_zip() {
  local pub="$1" identity="$2" allowed="$STAGE/allowed_signers"
  case "$(head -1 "$pub")" in
    "ssh-"*|"ecdsa-"*|"sk-"*) printf '%s %s\n' "$identity" "$(cat "$pub")" > "$allowed" ;;
    *) cp "$pub" "$allowed" ;;
  esac
  (cd "$DIST" && ssh-keygen -Y verify -f "$allowed" -I "$identity" -n file \
    -s "$ZIP.sig" < "$ZIP") \
    || { echo "linux/release.sh: signature verification FAILED" >&2; exit 1; }
}

if [ "$dryrun" = 1 ]; then
  KEY="$STAGE/signkey"
  ssh-keygen -q -t ed25519 -N "" -f "$KEY" -C "qn-dryrun" >/dev/null
  (cd "$DIST" && ssh-keygen -Y sign -f "$KEY" -n file "$ZIP" >/dev/null)
  verify_zip "$KEY.pub" "qn-dryrun"
  echo "==> DRY RUN: signed + verified with an ephemeral key (not for distribution)"
else
  [ -n "${QN_SIGN_KEY:-}" ] \
    || { echo "linux/release.sh: set QN_SIGN_KEY to the ssh signing key (or use --dry-run)" >&2; exit 1; }
  [ -n "${QN_SIGN_KEY_PUB:-}" ] \
    || { echo "linux/release.sh: set QN_SIGN_KEY_PUB for verification" >&2; exit 1; }
  case "$QN_SIGN_KEY" in "~/"*) QN_SIGN_KEY="$HOME/${QN_SIGN_KEY#\~/}";; esac
  case "$QN_SIGN_KEY_PUB" in "~/"*) QN_SIGN_KEY_PUB="$HOME/${QN_SIGN_KEY_PUB#\~/}";; esac
  case "$QN_SIGN_KEY" in /*) ;; *) QN_SIGN_KEY="$REPO_ROOT/$QN_SIGN_KEY" ;; esac
  case "$QN_SIGN_KEY_PUB" in /*) ;; *) QN_SIGN_KEY_PUB="$REPO_ROOT/$QN_SIGN_KEY_PUB" ;; esac
  IDENTITY="${QN_SIGN_ID:-$(sed -E 's/^[^ ]+ [^ ]+ //' "$QN_SIGN_KEY_PUB" 2>/dev/null | head -n1)}"
  case "$IDENTITY" in
    ''|*' '*) echo "linux/release.sh: signing identity must be one token — set QN_SIGN_ID" >&2; exit 1 ;;
  esac
  (cd "$DIST" && ssh-keygen -Y sign -f "$QN_SIGN_KEY" -n file "$ZIP")
  verify_zip "$QN_SIGN_KEY_PUB" "$IDENTITY"
  echo "linux/release.sh: signature verifies against $QN_SIGN_KEY_PUB as $IDENTITY"
fi

echo "linux/release.sh: OK — dist/$ver/$ZIP (+ .sig, sha256sums-linux-x64.txt)"
