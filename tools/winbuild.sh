#!/bin/sh
# Fetch + verify the cross toolchain inputs for make win64.
# --fetch downloads to $WINBUILD and records sha256 sidecars.
set -eu
cd "$(dirname "$0")/.."
WINBUILD="${WINBUILD:-$PWD/winbuild}"
LLVM_REL=20260922
LLVM_ASSET="llvm-mingw-${LLVM_REL}-ucrt-ubuntu-22.04-x86_64.tar.xz"
SDL_VER=2.32.4
SDL_ASSET="SDL2-devel-${SDL_VER}-mingw.tar.gz"
usage() { echo "usage: $0 --fetch" >&2; exit 2; }
[ "${1:-}" = "--fetch" ] || usage
mkdir -p "$WINBUILD/dl"
cd "$WINBUILD/dl"
[ -f "$LLVM_ASSET" ] || curl -fLO "https://github.com/mstorsjo/llvm-mingw/releases/download/${LLVM_REL}/${LLVM_ASSET}"
[ -f "$SDL_ASSET" ] || curl -fLO "https://github.com/libsdl-org/SDL/releases/download/release-${SDL_VER}/${SDL_ASSET}"
for f in "$LLVM_ASSET" "$SDL_ASSET"; do
  if [ -f "$f.sha256" ]; then sha256sum -c "$f.sha256"
  else sha256sum "$f" > "$f.sha256"; echo "recorded $f.sha256 (first fetch - verify against the release page)"; fi
done
echo "toolchain archives present under $WINBUILD/dl with digest sidecars"
