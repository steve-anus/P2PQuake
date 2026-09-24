# qn-patches

Fixes applied inside the vendored engine tree (`src/vendor/quakespasm`).
The tree in git already has them applied; these files exist so
`tools/update-engine.sh` can re-apply them automatically after each engine
sync. A patch that fails to apply there is a STOP condition — read the
failing hunk, rebase or retire the patch, never skip it.

| file | what it does |
|---|---|
| `0001-cl-parse-index-clamps.patch` | rejects negative/out-of-range wire-supplied model, sound and viewentity indices (and NULL precache entries) with a disconnect instead of memory unsafety |
| `0002-cl-parse-parse-exits-disconnect.patch` | turns four remote-triggerable `Sys_Error` process exits in the server-message parser into recoverable `Host_Error` disconnects |
| `0003-host_cmd-path-traversal-filter.patch` | rejects `..`, absolute paths and drive prefixes (and argless calls) in map/save/view names accepted by server-influenced console commands |
| `0004-common-msg-read-float-bounds.patch` | bounds-checks `MSG_ReadFloat` against the message size like its sibling readers, flagging a bad read instead of reading past the message |
| `0005-sv-phys-entity-cap.patch` | upstream's entity-cap fix: `SV_Physics` re-reads the cap each iteration instead of looping on a stale count |
| `0006-net-qn-landriver.patch` | new files `Quake/net_qn.c` / `Quake/net_qn.h`: the p2pquake landriver -- virtual socket table and address model for the local qn-peer transport; absent unless `-qn` is on the command line, standby (all data-plane ops refuse) until the Plane A lifecycle hooks report an authenticated daemon. Cosmetic note: while registered, the datagram layer prints its resolve-failure line once per landriver, so an unresolvable name shows one extra `Could not resolve` line than UDP-only builds |
| `0007-net-bsd-qn-registration.patch` | registers the QN landriver in `net_landrivers[]` after UDP |
| `0008-makefile-qn-object.patch` | adds `net_qn.o` and the shared driver modules `qn_transport.o` / `qn_frame.o` / `qn_spawn.o` to the engine's net objects, with a `vpath` and include flag for the project's `src/driver` directory |
| `0009-main-sdl-qn-pump.patch` | calls `QN_Pump` once per frame from both host loops in `main_sdl.c`: drives the landriver's Plane A session -- on-demand daemon spawn, auth watchdog, frame dispatch, and the host/client lane framing |
| `0010-net-dgrm-datagram-limits.patch` | the datagram layer's size contract: chunks reliable DATA messages by the landriver's advertised datagram ceiling instead of the compile-time maximum (zero leaves behaviour unchanged — over the p2p lane every datagram must arrive whole inside one relay body); drops a received packet whose declared length disagrees with the bytes actually delivered; refuses a reassembly build-up past the receive buffer |
| `0011-net-defs-datagram-max.patch` | adds the `datagram_max` field to `net_landriver_t` that a landriver may advertise and the datagram layer honours (the p2p landriver does; UDP leaves it zero for the compile-time default) |
| `0012-common-longswap-unsigned-shift.patch` | `LongSwap` composes its bytes in the unsigned domain: `(int)b1 << 24` overflows signed int for `b1 >= 128` — undefined behaviour, surfaced by `-fsanitize=undefined` on the net paths |
| `0013-client-lane-join.patch` | the join lane: QN_PollFd in the landriver table plus the datagram layer's connect-spin yield (with the advertised `datagram_max` and the `qn:` name left intact through `Strip_Port`); the landriver's host-lane lifecycle (transient `!sv.active` windows no longer retire the lane or re-mint the room code), reconnect re-arm that re-sends the join only after a played match, and per-slot peer identity so server output reaches exactly its own player (the datagram layer acknowledges any DATA chunk, so fan-out must never be a room broadcast) |
| `0014-stufftext-allowlist.patch` | the spec 6.4 remote-console gate: game-stream `svc_stufftext` and Plane A `STUFFTEXT` frames dispatch to the console only through the derived allowlist predicate (`src/driver/qn_stext.c`), which the vendored Makefile links from the driver directory |
| `0015-engine-build-id-marker.patch` | embeds the source-level build identity as the magic-framed marker `QNBID:<QN_BUILD_ID>` (value from the Makefile-generated `src/driver/qn_buildid.h`) and prints it at startup: the join lane's comparable `build_id` is proven from the parent image the daemon reads (spec 3.4a) |

The vendored engine is otherwise upstream code (URL and commit recorded in
`ENGINE.upstream`) and is only ever modified in: `Quake/net_bsd.c`,
`Quake/main_sdl.c`, `Quake/net_main.c`, `Quake/host.c`, `Quake/cl_parse.c`,
`Quake/host_cmd.c`, `Quake/common.c` (message-reader bounds; byte-swap composition in the unsigned domain),
`Quake/sv_phys.c` (upstream's entity-cap fix), `Quake/net_dgrm.c` (reliable DATA chunking via the advertised ceiling only), `Quake/net_defs.h` (the `datagram_max` field only), `Quake/Makefile`.
Anything else upstream must stay untouched so updates stay cheap and
reviews stay small. `make engine-verify` checks this claim mechanically:
it replays the series onto pristine pin bytes and diffs against the tree.

To add a fix: edit one of those files, rebuild (`make engine DEBUG=1`), run
the checks (`make check`), commit. Then export the change as the next
numbered patch here and prove it re-creates the tree from untouched sources.
The patch's file headers must read `a/Quake/<file>` / `b/Quake/<file>`
(the update tool applies with `-p1` from `src/vendor/quakespasm`):

    CACHE=${QN_ENGINE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/p2pquake/qs-engine}   # upstream clone kept by tools/update-engine.sh
    pristine=$(mktemp -d)
    git -C "$CACHE" archive "$(sed -n 2p ENGINE.upstream)" Quake/<file> | tar -x -C "$pristine"
    diff -u "$pristine"/Quake/<file> src/vendor/quakespasm/Quake/<file> \
      | sed '1s|.*|--- a/Quake/<file>|;2s|.*|+++ b/Quake/<file>|' > qn-patches/NNNN-name.patch
    patch -p1 -d "$pristine" --dry-run -i "$PWD"/qn-patches/NNNN-name.patch  # must apply clean
