#!/usr/bin/env bash
# Manual engine maintenance, pin-first. Fetches upstream QuakeSpasm, shows
# what changed between the recorded pin and the candidate, and only then
# syncs the vendored copy and records the new pin. Review the printed
# commits/diffstat before answering yes.
#
# Each file we change (one qn-patches/<file>.patch per file) is merged three
# ways: old upstream as the base, our vendored file, new upstream. Clean
# merges refresh their patches; conflicts are left as conflict markers in
# the vendored file, listed, and the script exits 1 without refreshing any
# patch. Resolve them, then run tools/regen-patch.sh and make engine-verify.
#
# Usage: tools/update-engine.sh <commit-sha|tag|latest>
set -euo pipefail
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT="$DIR/.."
PINFILE="$ROOT/ENGINE.upstream"
VENDOR="$ROOT/src/vendor/quakespasm"
REMOTE=https://github.com/sezero/quakespasm
CACHE=${QN_ENGINE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/p2pquake/qs-engine}
SKIP=(--exclude=MacOSX --exclude=Windows --exclude=Linux)
BUILD_OUT=(-x '*.o' -x '*.d' -x quakespasm -x quakespasm.exe -x build-w64 -x build-macos -x history.txt)

[ -f "$PINFILE" ] || { echo "missing $PINFILE (line 2 holds the pinned commit)" >&2; exit 1; }
CUR=$(sed -n 2p "$PINFILE")
[ -d "$CACHE/.git" ] || { mkdir -p "$(dirname "$CACHE")"; git clone --quiet "$REMOTE" "$CACHE"; }
git -C "$CACHE" fetch --quiet origin master

CAND="${1:?usage: update-engine.sh <commit-sha|tag|latest>}"
[ "$CAND" = latest ] && CAND=origin/master
REF=$(git -C "$CACHE" rev-parse --verify "$CAND^{commit}")

W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$W/old" "$W/new"
git -C "$CACHE" archive "$CUR" | tar -x -C "$W/old" "${SKIP[@]}"
git -C "$CACHE" archive "$REF" | tar -x -C "$W/new" "${SKIP[@]}"

# The vendored tree must be exactly pin + patches, or local edits that never
# reached a patch would be lost by the sync.
cp -a "$W/old" "$W/check"
for p in "$ROOT"/qn-patches/*.patch; do
  [ -e "$p" ] || continue
  (cd "$W/check" && patch -p1 -s -i "$p") || { echo "STOP: $(basename "$p") does not apply to the current pin" >&2; exit 1; }
done
diff -r -q "${BUILD_OUT[@]}" "$W/check" "$VENDOR" \
  || { echo "STOP: the vendored tree differs from pin + patches; run tools/regen-patch.sh first" >&2; exit 1; }

echo "current pin: $CUR"
echo "candidate:   $REF"
echo "-- new commits --"
git -C "$CACHE" log --oneline "$CUR..$REF" || true
echo "-- diffstat --"
git -C "$CACHE" diff --stat "$CUR..$REF" || true
printf 'sync vendored copy to candidate? [y/N] '
read -r ans
[ "$ans" = y ] || { echo "aborted, pin unchanged"; exit 0; }

conflicts=()
for p in "$ROOT"/qn-patches/*.patch; do
  [ -e "$p" ] || continue
  f=$(basename "$p" .patch)
  [ -f "$W/new/Quake/$f" ] || { echo "STOP: upstream removed Quake/$f, which we patch; nothing changed" >&2; exit 1; }
  cp "$VENDOR/Quake/$f" "$W/merged-$f"
  rc=0
  git merge-file -L ours -L "upstream $CUR" -L "upstream $REF" \
    "$W/merged-$f" "$W/old/Quake/$f" "$W/new/Quake/$f" || rc=$?
  [ "$rc" -ge 0 ] || { echo "STOP: merge of Quake/$f failed" >&2; exit 1; }
  [ "$rc" -eq 0 ] || conflicts+=("Quake/$f")
  cp "$W/merged-$f" "$W/new/Quake/$f"
done

rm -rf "$VENDOR"
mkdir -p "$VENDOR"
cp -a "$W/new/." "$VENDOR/"
printf '%s\n%s\n' "$REMOTE" "$REF" > "$PINFILE"
echo "pinned and synced: $REF"

if [ "${#conflicts[@]}" -gt 0 ]; then
  echo "CONFLICTS (markers left in place, patches not refreshed):" >&2
  printf '  %s\n' "${conflicts[@]}" >&2
  exit 1
fi
"$DIR/regen-patch.sh"
echo "next: make engine-verify && make check"
