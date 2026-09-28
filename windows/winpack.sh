#!/bin/sh
# Stage and zip the Windows package: p2pquake-<VERSION>-win-x64.zip
# Layout: quakespasm.exe, runtime/node.exe, peer/, node_modules/, id1/,
#         gamedata.sha256, VERSION, README.md
set -eu
cd "$(dirname "$0")/../.."
NODE_VER=$(grep -m1 '^NODE_VERSION=' tools/setup-nodejs.sh | cut -d= -f2)
NODE_NUM="${NODE_VER#v}"
VER=$(cat VERSION)
WINBUILD="${WINBUILD:-$PWD/winbuild}"
OUT="bin/winpack"
PKG="$OUT/p2pquake-${VER}-win-x64"
rm -rf "$PKG"; mkdir -p "$PKG/runtime" "$PKG/peer" "$PKG/id1"
echo "==> engine"
cp src/vendor/quakespasm/Quake/quakespasm.exe "$PKG/quakespasm.exe"
echo "==> node runtime v$NODE_NUM (win-x64, SHASUMS256-verified)"
NZ="node-v${NODE_NUM}-win-x64.zip"
( cd "$OUT" && { [ -f "$NZ" ] || { curl -fLO "https://nodejs.org/dist/v${NODE_NUM}/${NZ}" && curl -fLO "https://nodejs.org/dist/v${NODE_NUM}/SHASUMS256.txt"; }; } && grep " ${NZ}\$" SHASUMS256.txt | sha256sum -c - )
python3 - "$OUT/$NZ" "$PKG/runtime" <<'PY'
import sys, zipfile, os
zf = zipfile.ZipFile(sys.argv[1]); dest = sys.argv[2]
root = 'node-v%s-win-x64/' % os.environ.get('QN_NODE_VER','')
for n in ('node.exe',):
    src = [i for i in zf.namelist() if i.lower().endswith('/' + n)][0]
    open(os.path.join(dest, n), 'wb').write(zf.read(src))
PY
echo "==> peer tree"
cp src/peer/*.cjs "$PKG/peer/"
cp -a node_modules "$PKG/node_modules"
find "$PKG/node_modules" -name "*.node" | while read -r f; do
  case "$f" in
    *prebuilds*) d=$(echo "$f" | sed 's|prebuilds/.*|prebuilds/|')
      [ -d "$d/win32-x64" ] || { echo "native module without win32-x64 prebuild: $f" >&2; exit 1; };;
  esac
done
echo "==> gamedata (byte-exact, manifest-verified)"
cp -a gamedata/id1/. "$PKG/id1/"
cp gamedata.sha256 "$PKG/gamedata.sha256"
( cd "$PKG/id1" && sha256sum -c ../gamedata.sha256 >/dev/null )
cp VERSION "$PKG/VERSION"; cp README.md "$PKG/README.md"
ZIP="p2pquake-${VER}-win-x64.zip"
( cd "$OUT" && rm -f "$ZIP" "$ZIP.sig" && python3 -m zipfile -c "$ZIP" "p2pquake-${VER}-win-x64" )
echo "==> checksums"
( cd "$OUT" && sha256sum "$ZIP" > sha256sums.txt )
if [ "${1:-}" = "--dry-run" ]; then
  KEYDIR=$(mktemp -d)
  ssh-keygen -q -t ed25519 -N '' -f "$KEYDIR/signkey" -C qn-dryrun
  KEY="$KEYDIR/signkey"; PUB="$KEYDIR/signkey.pub"; IDENTITY=qn-dryrun
else
  [ -n "${QN_SIGN_KEY:-}" ] \
    || { echo "winpack.sh: set QN_SIGN_KEY to the ssh signing key (or use --dry-run)" >&2; exit 1; }
  [ -n "${QN_SIGN_KEY_PUB:-}" ] \
    || { echo "winpack.sh: set QN_SIGN_KEY_PUB for verification" >&2; exit 1; }
  KEY="$QN_SIGN_KEY"; PUB="$QN_SIGN_KEY_PUB"
  IDENTITY="${QN_SIGN_ID:-$(sed -E 's/^[^ ]+ [^ ]+ //' "$PUB" 2>/dev/null | head -n1)}"
fi
case "$IDENTITY" in
  ''|*' '*) echo "winpack.sh: signing identity must be one token — set QN_SIGN_ID" >&2; exit 1 ;;
esac
echo "==> sign + verify round-trip"
( cd "$OUT" && ssh-keygen -Y sign -f "$KEY" -n file "$ZIP" >/dev/null \
  && printf '%s %s\n' "$IDENTITY" "$(cat "$PUB")" > allowed_signers \
  && ssh-keygen -Y verify -f allowed_signers -I "$IDENTITY" -n file \
       -s "$ZIP.sig" < "$ZIP" )
if [ "${1:-}" = "--dry-run" ]; then
  echo "==> DRY RUN: signed + verified with an ephemeral key (not for distribution)"
  rm -rf "$KEYDIR"
else
  echo "winpack.sh: $ZIP signed as $IDENTITY ($(ssh-keygen -lf "$PUB" | awk '{print $2}'))"
fi
echo "packaged: $OUT/$ZIP"
