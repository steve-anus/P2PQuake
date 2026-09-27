# p2pquake

Serverless peer-to-peer Quake: a patched QuakeSpasm engine plus a Node
match peer that discovers peers over a DHT, authenticates sessions with
Noise, verifies game traffic with signed match envelopes, and falls back
to blind relays.

## Playing

1. Download the newest release, `p2pquake-<version>-linux-x64.zip`, from
   the project's releases page.
2. Unpack it (under /opt). Everything the game needs is inside.
3. Open a terminal, cd into the unpacked folder and start the game:  

   ```
   ./quakespasm
   ```  

   Two things worth knowing: everyone playing together should use the
   **same release** (codes only work between matching versions), and if
   the host's map list comes up empty the unpack did not finish —
   extract the zip again.

### Optional: a desktop menu entry

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
mpg123 backend, embedding a build identity (commit + digest of the
`qn-patches/` series) that the peer proves before every join.
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

## Releases & verification

Archives are named `p2pquake-<version>-linux-x64.zip` and ship with
`sha256sums.txt` and a detached SSH signature:

```
sha256sum -c sha256sums.txt
printf '<identity> <your-trusted-pubkey-line>\n' > allowed_signers
ssh-keygen -Y verify -f allowed_signers -I <identity> -n file \
    -s p2pquake-<version>-linux-x64.zip.sig \
    < p2pquake-<version>-linux-x64.zip
```

Release binaries are **not code-signed**.

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
