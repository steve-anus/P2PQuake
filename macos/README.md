# macOS / Metal

This is a native Metal source build of P2PQuake. SDL2 provides the Cocoa
window, input and audio; the renderer uses Metal command buffers and shaders.
It includes no OpenGL context or OpenGL framework link. SDL's OpenGL header
supplies only the types/constants used by the existing scene code.

## Build and run

Requirements: a Metal-capable Mac, macOS 11 or newer, Xcode command-line tools,
Python 3, and native SDL2/mpg123 development libraries. Node 24 is required by
the peer. The pinned Node bootstrap supports both Darwin arm64 and x64.

```sh
brew install sdl2 mpg123 pkgconf
tools/setup-nodejs.sh
export PATH="$PWD/bin/node/bin:$PATH"
make -j"$(sysctl -n hw.logicalcpu)"
macos/run.sh
```

Run these commands from the repository root. `macos/run.sh` accepts normal
engine arguments, for example `macos/run.sh -window -width 1280 -height 720`.
Keep the checkout and its dependencies in a directory you control.

The binary is `src/vendor/quakespasm/Quake/quakespasm`; objects are isolated
under `Quake/build-macos/`. The deployment target defaults to the build
machine's macOS major version because Homebrew libraries may require a recent
OS. To target an older OS, supply matching dependency builds and
`MACOSX_DEPLOYMENT_TARGET=11.0` (or newer). Clean before changing architecture,
deployment target, compiler or debug flags. No universal binary, dependency
bundling, code signing, notarization or `.app` packaging is provided yet.

Validated locally on Apple M5 Max, macOS 26.6.1, SDL 2.32.6. Intel Macs and
older macOS releases still need validation; macOS 11 is an intended API floor,
not a claim of testing every supported device.

## Rendering and performance

`qn_metal.m` implements the fixed-function operations used by the pinned
QuakeSpasm scene renderer. `shaders.metal` is embedded at build time and
compiled by Metal at startup. The engine's existing fixed-function fallback
draws the scene: world/lightmaps, alias models, sprites, water, sky, fog,
stencil shadows, HUD and menus. Native GPU passes implement gamma/contrast
and framebuffer copies. Screenshot readback preserves Quake's bottom-origin
pixel convention.

Adjacent primitives are batched while render state remains compatible.
Triangle strips, fans and quads are converted to independent triangles so
batches never connect unrelated surfaces. Dynamic vertex data is uploaded in
large buffers reused after GPU completion; up to three command buffers can be in flight, avoiding a CPU
wait for every rendered frame. Texture updates remain ordered with draws on
the same command queue. These optimizations are confined to Metal; they do
not accelerate the Windows or Linux OpenGL renderer.

The initial renderer does not support MSAA (`vid_fsaa` reports 0), GLSL/VBO
paths, multitexturing or generated water mipmaps. It uses the engine's
fallbacks for those capabilities. It implements the operations this engine
uses, not a general OpenGL compatibility layer.

To inspect rendering costs:

```sh
QN_METAL_PROFILE=1 macos/run.sh -window -width 960 -height 600
```

Every 120 frames it reports renderer CPU time, drawable wait, command-queue
wait, GPU time and draw count. Renderer CPU time excludes game/network
simulation; the timings overlap and should not be summed into frame time.
For a repeatable view, load a map and run `timerefresh` from the console.
Window presentation and display refresh can limit that measurement.

`host_maxfps 300` is accepted, but the engine warns that rates above 72 alter
physics. This port keeps the upstream default. Increasing the cap is not a
fix for uneven frame times. A slow hosting client can also delay its listen
server simulation; the local 300 FPS stress test exercises sustained traffic,
not real-world network conditions or a guarantee of 300 presented FPS.

## Validation

```sh
make metal-check                         # real GPU pixel checks + Metal validation
make check                               # C sanitizers, Node and multiplayer suites
QN_ENGINE_CACHE=/path/to/quakespasm make engine-verify
```

`metal-check` needs a logged-in graphical session and a Metal device. It
checks coordinates, depth, blending, alpha rejection, matrices, scissoring,
texture upload, framebuffer copies, fog, stencil and primitive batching.

The engine integration tests select Cocoa and `QN_METAL_HEADLESS=1` on macOS:
they render to real Metal textures in a hidden window, without waiting for
display presentation. This also prevents the engine's background-window
throttle from invalidating the upstream 300 FPS listen-host traffic gate.
The gate itself is unchanged. Python's PTY bridge replaces GNU `script` for
interactive console tests. `TMPDIR=/tmp` in make keeps Unix socket names
within Darwin's shorter path limit.

On the validation machine, Apple Clang 17 and LLVM 20 AddressSanitizer runtimes
hang during initialization, before `main` (a related
[LLVM report](https://github.com/llvm/llvm-project/issues/200447) reproduces an
ASan startup hang on macOS 26.4). To run the suite with UBSan on an affected
toolchain, use:

```sh
make check CHECK_SANITIZERS=undefined
```

This override does not constitute an ASan pass; ASan remains the default.

## Peer portability

Darwin uses Unix sockets with `getpeereid`, close-on-exec/nonblocking flags,
and `posix_spawn` instead of Linux's `accept4`, `/proc` and `execveat`.
The engine passes an opened copy of its image at descriptor 3. The peer
hashes it, checks its embedded build marker, and closes the descriptor before
network setup. A launch without that regular-file descriptor fails closed.

Darwin has no fd-based exec equivalent. The launcher validates the executable
and compares the named file's device/inode immediately before spawning its
absolute path, but this is not atomic against path replacement. The engine
image is resolved at spawn time, not pinned through Linux's `/proc` interface.
Keep the installation stable while playing. These differences are explicit
in `src/driver/qn_os_macos.c`; the Linux execution path remains intact.

Wire encodings and rate limits are unchanged. Cross-platform peers still need
matching source build identities and content. Installing this source change
on only one participant changes the identity and prevents joining an older
build; build all participants from the same revision. Live cross-OS play is
not covered by testing two local Mac clients.
