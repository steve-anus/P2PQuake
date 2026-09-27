#!/usr/bin/env bash
# Regenerate one qn-patches entry from the vendored working tree: stage the
# pinned upstream bytes, apply every other patch in the series, then diff
# the named Quake files against the live tree. The patch must then re-apply
# cleanly: run `make engine-verify` before committing.
#
# Usage: tools/regen-patch.sh qn-patches/NNNN-name.patch [file ...]
# With no file list, members come from the existing patch's +++ headers
# (re-generation); on creation pass the Quake-basename members explicitly.
set -euo pipefail
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT="$DIR/.."
CACHE="${QN_ENGINE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/p2pquake/qs-engine}"

patch_rel="${1:?usage: regen-patch.sh qn-patches/NNNN-name.patch [file ...]}"
case "$patch_rel" in qn-patches/*.patch) ;; *) echo "not a qn-patches path: $patch_rel" >&2; exit 1;; esac
out="$ROOT/$patch_rel"
base="$(basename "$patch_rel")"

shift
files=("$@")
if [ "${#files[@]}" -eq 0 ]; then
  [ -f "$out" ] || { echo "no member list and no existing $patch_rel" >&2; exit 1; }
  mapfile -t files < <(sed -n 's|^+++ b/Quake/||p' "$out")
fi
[ "${#files[@]}" -gt 0 ] || { echo "empty member list" >&2; exit 1; }

W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
Q="$W/src/vendor/quakespasm"; mkdir -p "$Q"
(cd "$Q" && git -C "$CACHE" archive "$(sed -n 2p "$ROOT/ENGINE.upstream")" \
  | tar -x --exclude=MacOSX --exclude=Windows --exclude=Linux)

later_overlap=0
seen_target=0
for p in "$ROOT"/qn-patches/00*.patch; do
  b="$(basename "$p")"
  if [ "$b" = "$base" ]; then seen_target=1; continue; fi
  if [ "$seen_target" = 1 ]; then
    for f in "${files[@]}"; do
      grep -q "^+++ b/Quake/$f\$" "$p" && { echo "later patch $b touches $f — regenerate it, not $base (shared members)" >&2; later_overlap=1; };
    done
    continue
  fi
  (cd "$Q" && patch -p1 -s -i "$p") || { echo "base series broken at $p" >&2; exit 1; }
done
[ "$later_overlap" = 0 ] || exit 1

tmp="$W/out.patch"; : > "$tmp"
for f in "${files[@]}"; do
  [ -f "$Q/Quake/$f" ] || { echo "no such vendored file: $f" >&2; exit 1; }
  rc=0
  diff -u --label "a/Quake/$f" --label "b/Quake/$f" \
    "$Q/Quake/$f" "$ROOT/src/vendor/quakespasm/Quake/$f" >> "$tmp" || rc=$?
  [ "$rc" -le 1 ] || { echo "diff failed for $f (rc $rc)" >&2; exit 1; }
done
[ "$(grep -c '^+++ ' "$tmp")" = "${#files[@]}" ] \
  || { echo "member count mismatch" >&2; exit 1; }
mv "$tmp" "$out"
echo "wrote $patch_rel (${#files[@]} members)"
