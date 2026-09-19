#!/bin/sh
# Manual engine maintenance, pin-first. Fetches upstream QuakeSpasm, shows
# what changed between the currently recorded pin and the candidate, and
# only then syncs the vendored copy and records the new pin. Review the
# printed commits/diffstat before answering yes.
#
# Usage: tools/update-engine.sh <commit-sha|tag|latest>
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT="$DIR/.."
PINFILE="$ROOT/ENGINE.upstream"
REMOTE=https://github.com/sezero/quakespasm
CACHE=${QN_ENGINE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/p2pquake/qs-engine}

[ -f "$PINFILE" ] || { echo "missing $PINFILE (line 2 holds the pinned commit)" >&2; exit 1; }
CUR=$(sed -n 2p "$PINFILE")
[ -d "$CACHE/.git" ] || { mkdir -p "$(dirname "$CACHE")"; git clone --quiet "$REMOTE" "$CACHE"; }
git -C "$CACHE" fetch --quiet origin master

CAND="${1:?usage: update-engine.sh <commit-sha|tag|latest>}"
[ "$CAND" = latest ] && CAND=origin/master
REF=$(git -C "$CACHE" rev-parse --verify "$CAND^{commit}")

echo "current pin: $CUR"
echo "candidate:   $REF"
echo "-- new commits --"
git -C "$CACHE" log --oneline "$CUR..$REF" || true
echo "-- diffstat --"
git -C "$CACHE" diff --stat "$CUR..$REF" || true
printf 'sync vendored copy to candidate? [y/N] '
read -r ans
[ "$ans" = y ] || { echo "aborted, pin unchanged"; exit 0; }

git -C "$CACHE" checkout -q "$REF"
rm -rf "$ROOT/src/vendor/quakespasm"
mkdir -p "$ROOT/src/vendor/quakespasm"
# The vendored tree is Linux-only: other platforms' prebuilt binaries and
# IDE files never participate in a build here. Quake/, docs, LICENSE and
# Misc/ (which holds the quakespasm.pak sources) are kept.
tar -C "$CACHE" --exclude=./.git --exclude=./MacOSX --exclude=./Windows \
    --exclude=./Linux -cf - . \
  | tar -C "$ROOT/src/vendor/quakespasm" -xf -

# Re-apply our engine-side fixes (security clamps etc) as ordered patches.
# A patch that fails to apply is STOP: upstream moved under a fix; read the
# failing hunk, rebase or retire the patch — never skip silently.
if compgen -G "$ROOT/qn-patches/*.patch" >/dev/null; then
  for p in "$ROOT"/qn-patches/*.patch; do
    echo "applying $(basename "$p")"
    (cd "$ROOT/src/vendor/quakespasm" && patch -p1 --dry-run -i "$p" >/dev/null) \
      || { echo "PATCH FAILED: $p does not apply to $REF — STOP, resolve manually" >&2; exit 1; }
    (cd "$ROOT/src/vendor/quakespasm" && patch -p1 -i "$p")
  done
fi

printf '%s\n%s\n' "$REMOTE" "$REF" > "$PINFILE"
echo "pinned and synced: $REF"
