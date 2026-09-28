# P2PQuake

Serverless peer-to-peer Quake: a patched QuakeSpasm engine plus a Node
match peer that discovers peers over a DHT, authenticates sessions with
Noise, verifies game traffic with signed match envelopes, and falls back
to blind relays.

## Playing

1. Download the newest release for your platform from the project's releases page.
2. Unpack it somewhere you own - `/opt` is a fine choice on linux, any
   folder works on Windows. Everything the game needs is inside,
   including the peer runtime; nothing else has to be installed.
3. Open a terminal, cd into the unpacked folder and start the game:  

   - linux:

     ```
     ./quakespasm
     ```

   - Windows:

     ```
     quakespasm.exe
     ```


   Two things worth knowing: everyone playing together should use the
   **same release** (codes only work between matching versions), and if
   the host's map list comes up empty the unpack did not finish —
   extract the zip again.

### Optional: a desktop menu entry (linux)

The archive ships `p2pquake.desktop`, a launcher file that adds p2pquake
to your desktop's applications menu. It is purely optional — the game
runs from its folder either way. To get the menu entry, copy the file:

```
cp p2pquake.desktop ~/.local/share/applications/
```

It assumes the game is unpacked at `/opt/p2pquake`; if you put it
somewhere else, edit the `Exec=` and `Icon=` lines to point at your
folder.

## Building from source

Requirements:

- a C11 toolchain (`CC`, default `gcc`);
- SDL2, OpenGL and mpg123 development headers (Debian/Ubuntu:
  `libsdl2-dev libgl1-mesa-dev libmpg123-dev`);
- Node.js 24 for the peer and the test suite either on `PATH`, or
  fetch the pinned, hash-verified copy with `tools/setup-nodejs.sh`
  (installs repo-local under `bin/node/`; the tarball is checked against
  the nodejs.org SHA256 before use);
- npm, to install the peer's dependencies.

```
git clone https://github.com/steve-anus/P2PQuake.git
cd p2pquake
make                       # engine + peer dependencies (npm ci --ignore-scripts)
make check                 # the full test suite
```

`make engine` builds the vendored QuakeSpasm tree against SDL2 with the
mpg123 backend, embedding a build identity (the `VERSION` release
number plus a digest over the wire-critical source: the `qn-patches/`
series, the driver, the peer, the protocol spec) that the peer proves
before every join. Builds of the same release on linux and Windows carry
the identical identity, so the two platforms play together; anything
version-mismatched is refused at the join.
`make check` runs everything: the C protocol/unit suites, the scripted
multi-process play suites (loopback, two-player over a local DHT with
relay fallback, discovery, lobby browser, visibility, hostile adverts,
listen-host, maplist), and the fuzzer entry points. Individual suites
are Make targets too (`make loopback`, `make twoplayer`, `make relay`,
...). `make engine-verify` proves the vendored tree is exactly the
pinned upstream QuakeSpasm plus the ordered patch series (it needs a
local upstream clone; see `QN_ENGINE_CACHE` in the Makefile).

To run the game straight from the source tree (instead of a release
archive), the engine needs to know where the content and the peer live:

```
./src/vendor/quakespasm/Quake/quakespasm -basedir gamedata \
    -qn-peer "$PWD/src/peer/qn-peer.cjs"
```

### Cross-building the Windows binary (from linux)

The Windows engine is cross-compiled from a linux machine with
llvm-mingw; the result is a static PE32+ build that needs no extra
runtime DLLs and packages beside the same pinned node runtime
(win32-x64) the peer runs on:

```
windows/winbuild.sh --fetch   # llvm-mingw + SDL2 mingw-devel under $WINBUILD
make win64                  # cross-compile quakespasm.exe
windows/winpack.sh            # stage + zip the self-contained win-x64 archive
```

`WINBUILD` points at the toolchain directory (default: `winbuild/` in
the repo checkout, git-ignored). `winbuild.sh --fetch` is idempotent and
scripts every dependency, including the mpg123 static cross-build (source
tarball pinned to an exact sha256, GPG-checked against the maintainer key
published on mpg123.org). The Windows build ships WAV + MP3 streaming;
flac/vorbis/opus are not wired into the cross build yet.

## Releases & verification

Both platform archives are built from a tagged checkout:
`linux/release.sh <tag>` (which runs the full test suite and the
shipped-bytes checks itself before packaging) and `windows/winpack.sh`
after `make win64`. Each emits `sha256sums.txt` plus a detached
signature, and aborts the build if its own signature fails to verify
against the public key.

The repository is a single `main` branch; the code is shared. The two
platform directories hold only platform-specific tooling —
`linux/` (release packaging) and `windows/` (cross-build kit) — and the
Windows engine source twins in `src/driver/` compile away to nothing on
linux builds. The full `make check` suite is the gate for every release,
Windows code included.

Archives are named `p2pquake-<version>-<OS-x64>.zip` and ship with
`sha256sums.txt` and a detached SSH signature (`<zip>.sig`). The trust
anchor is `RELEASE-PUBKEY` at the root of this repository — read it from
a source you already trust, not from the same download as the archive:

```
sha256sum -c sha256sums.txt
printf 'p2pquake-releases %s\n' "$(cat RELEASE-PUBKEY)" > allowed_signers
ssh-keygen -Y verify -f allowed_signers -I p2pquake-releases -n file \
    -s p2pquake-<version>-<OS-x64>.zip.sig \
    < p2pquake-<version>-<OS-x64>.zip
```

Release binaries are **not code-signed**. On Windows the first run of
`quakespasm.exe` may draw a SmartScreen prompt for that reason;
confirming once is enough, and the commands above prove the bits you
downloaded are the bits that were published.

## Licenses

- Source code: GPL-3.0
- Bundled game content (LibreQuake): models/textures/sounds under
  BSD-3-Clause; `progs.dat`/quakec under GPL-2. See
  `gamedata/id1/docs/README-IMPORTANT-LICENCE-INFO` and the COPYING
  files beside it.

## QuakeSpasm license

The vendored engine (`src/vendor/quakespasm`) is QuakeSpasm, descended
from id Software's released Quake source and the FitzQuake lineage. It
is free software under the GNU General Public License, version 2. 
The full license text ships in the tree at `src/vendor/quakespasm/LICENSE.txt` 
and stays in force for all derivative works of the engine. 
Per-source-file notices carry the original copyrights:

```
Copyright (C) 1996-2001 Id Software, Inc.
Copyright (C) 2002-2005 John Fitzgibbons and others
Copyright (C) 2010-2014 QuakeSpasm developers
```
