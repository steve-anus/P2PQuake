#!/bin/sh
# Fetch, verify and arrange the cross toolchain inputs for make win64.
# --fetch downloads to $WINBUILD, checks digests and builds the static
# cross mpg123. Idempotent: stages skip what is already in place.
set -eu
cd "$(dirname "$0")/.."
WINBUILD="${WINBUILD:-$PWD/winbuild}"
LLVM_REL=20260922
LLVM_DIR="llvm-mingw-${LLVM_REL}-ucrt-ubuntu-22.04-x86_64"
LLVM_ASSET="${LLVM_DIR}.tar.xz"
SDL_VER=2.32.4
SDL_ASSET="SDL2-devel-${SDL_VER}-mingw.tar.gz"
MPG_VER=1.33.7
MPG_ASSET="mpg123-${MPG_VER}.tar.bz2"
# Release tarball verified against the maintainer GPG signature
# (fingerprint published on mpg123.org/download.shtml) and identical
# bytes on mpg123.org and its SourceForge files section.
MPG_SHA256=31d0e35a4ca567ec9b5ebda6c3062bb4435d6d3eacd6ef0d95cadd7854dc03ee
usage() { echo "usage: $0 --fetch" >&2; exit 2; }
[ "${1:-}" = "--fetch" ] || usage
mkdir -p "$WINBUILD/dl"
cd "$WINBUILD/dl"
[ -f "$LLVM_ASSET" ] || curl -fLO "https://github.com/mstorsjo/llvm-mingw/releases/download/${LLVM_REL}/${LLVM_ASSET}"
[ -f "$SDL_ASSET" ] || curl -fLO "https://github.com/libsdl-org/SDL/releases/download/release-${SDL_VER}/${SDL_ASSET}"
[ -f "$MPG_ASSET" ] || curl -fLO "https://www.mpg123.org/download/${MPG_ASSET}"
echo "${MPG_SHA256}  ${MPG_ASSET}" > "$MPG_ASSET.expected"
for f in "$LLVM_ASSET" "$SDL_ASSET"; do
  if [ -f "$f.sha256" ]; then sha256sum -c "$f.sha256"
  else sha256sum "$f" > "$f.sha256"; echo "recorded $f.sha256 (first fetch - verify against the release page)"; fi
done
sha256sum -c "$MPG_ASSET.expected"
cd "$WINBUILD"
[ -d llvm-mingw ] || { tar -xf "dl/$LLVM_ASSET"; mv "$LLVM_DIR" llvm-mingw; }
[ -d "SDL2-$SDL_VER" ] || tar -xf "dl/$SDL_ASSET"
if [ ! -f mpg123-out/lib/libmpg123.a ]; then
  rm -rf "mpg123-$MPG_VER"
  tar -xf "dl/$MPG_ASSET"
  PATH="$WINBUILD/llvm-mingw/bin:$PATH" \
    sh -c "cd mpg123-$MPG_VER && ./configure \
      --host=x86_64-w64-mingw32 --enable-static --disable-shared \
      --with-pic --disable-programs --disable-network \
      --disable-modules --with-audio=win32,dummy \
      --prefix=$WINBUILD/mpg123-out && make -j\$(nproc) && make install"
  rm -rf "mpg123-$MPG_VER"
  echo "mpg123 $MPG_VER static cross build installed to $WINBUILD/mpg123-out"
fi
echo "toolchain ready under $WINBUILD (llvm-mingw, SDL2-$SDL_VER, mpg123-out)"
