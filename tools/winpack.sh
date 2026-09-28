#!/bin/sh
# Stage and zip the Windows package: p2pquake-<VERSION>-win-x64.zip
# Layout: quakespasm.exe, runtime/node.exe, peer/, node_modules/, id1/,
#         gamedata.sha256, VERSION, README.md
set -eu
cd "$(dirname "$0")/.."
NODE_VER=$(grep -m1 '^NODE_VERSION=' tools/setup-nodejs.sh | cut -d= -f2)
VER=$(cat VERSION)
WINBUILD="${WINBUILD:-$PWD/winbuild}"
OUT="bin/winpack"
PKG="$OUT/p2pquake-${VER}-win-x64"
rm -rf "$PKG"; mkdir -p "$PKG/runtime" "$PKG/peer" "$PKG/id1"
echo "==> engine"
cp src/vendor/quakespasm/Quake/quakespasm.exe "$PKG/quakespasm.exe"
echo "==> node runtime v$NODE_VER (win-x64, SHASUMS256-verified)"
NZ="node-v${NODE_VER}-win-x64.zip"
( cd "$OUT" && { [ -f "$NZ" ] || { curl -fLO "https://nodejs.org/dist/v${NODE_VER}/${NZ}" && curl -fLO "https://nodejs.org/dist/v${NODE_VER}/SHASUMS256.txt"; }; }
  grep " ${NZ}\$" "$OUT/SHASUMS256.txt" | ( cd "$OUT" && sha256sum -c - ) )
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
( cd "$OUT" && rm -f "p2pquake-${VER}-win-x64.zip" && python3 -m zipfile -c "p2pquake-${VER}-win-x64.zip" "p2pquake-${VER}-win-x64" )
echo "packaged: $OUT/p2pquake-${VER}-win-x64.zip"
