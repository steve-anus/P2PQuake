#!/usr/bin/env bash
# Regenerate the per-file engine patches from the vendored working tree.
# Each upstream file we change has exactly one patch, qn-patches/<file>.patch,
# holding the whole difference between the pinned upstream file and the
# vendored one, so patches never depend on each other. A file that matches
# upstream again loses its patch. Run `make engine-verify` afterwards.
#
# Usage: tools/regen-patch.sh [Quake-file ...]
# With no file list, every tracked Quake/ file is compared with the pin.
set -euo pipefail
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT="$DIR/.."
CACHE="${QN_ENGINE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/p2pquake/qs-engine}"
VENDOR="$ROOT/src/vendor/quakespasm"
PIN=$(sed -n 2p "$ROOT/ENGINE.upstream")
[ -d "$CACHE/.git" ] || { echo "no engine cache at $CACHE (tools/update-engine.sh clones it)" >&2; exit 1; }

W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
git -C "$CACHE" archive "$PIN" Quake | tar -x -C "$W"

files=("$@")
if [ "${#files[@]}" -eq 0 ]; then
  while IFS= read -r f; do files+=("${f#Quake/}"); done < <(
    git -C "$VENDOR" ls-files Quake | grep -v '/.*/' || true)
fi

wrote=0; dropped=0
for f in "${files[@]}"; do
  case "$f" in */*|'') echo "not a Quake/ basename: $f" >&2; exit 1;; esac
  live="$VENDOR/Quake/$f"; base="$W/Quake/$f"; out="$ROOT/qn-patches/$f.patch"
  [ -f "$live" ] || { echo "no such vendored file: Quake/$f" >&2; exit 1; }
  [ -f "$base" ] || { echo "Quake/$f is not an upstream file (own files live in src/driver)" >&2; exit 1; }
  rc=0
  diff -u --label "a/Quake/$f" --label "b/Quake/$f" "$base" "$live" > "$W/out.patch" || rc=$?
  case "$rc" in
    0) if [ -f "$out" ]; then rm -f "$out"; dropped=$((dropped + 1)); fi ;;
    1) if ! cmp -s "$W/out.patch" "$out" 2>/dev/null; then mv "$W/out.patch" "$out"; wrote=$((wrote + 1)); fi ;;
    *) echo "diff failed for Quake/$f (rc $rc)" >&2; exit 1 ;;
  esac
done
echo "regen-patch: $wrote written, $dropped removed"
