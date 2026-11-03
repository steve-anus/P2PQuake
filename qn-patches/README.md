# qn-patches

Changes to upstream files inside the vendored engine tree
(`src/vendor/quakespasm`). There is exactly one patch per changed upstream
file, `<file>.patch`, holding the whole difference between the pinned
upstream file (URL and commit in `ENGINE.upstream`) and the vendored one.
Patches never depend on each other, so the set only grows when a new
upstream file has to change.

Code that is entirely ours (the landriver `net_qn.c`/`net_qn.h`, the
p2pquake menus `qn_menu.c`/`qn_menu.h`, and the Plane A, spawn, map-pool
and allowlist modules) lives in `src/driver/` as ordinary source; the
engine makefiles find it through `vpath` and `-I`. Keep engine edits to
the hooks that connect upstream code to it.

## Working with the patches

- Change a vendored file, rebuild (`make engine`), run the checks, then
  refresh its patch with `tools/regen-patch.sh <file>` (no argument
  refreshes every file) and prove the set with `make engine-verify`: it
  applies every patch to pristine pin bytes, diffs the result against the
  tree, and builds it.
- Engine updates: `tools/update-engine.sh <commit|tag|latest>` merges each
  changed file three ways (old upstream, our version, new upstream). Clean
  merges are applied and their patches refreshed; a real conflict stops the
  update with conflict markers left in that file for a manual resolution.

## What each patch changes

| patch | changes |
|---|---|
| `cl_main.c.patch` | the connect debug line never prints a `qn:` address (join codes are bearer secrets) |
| `cl_parse.c.patch` | rejects negative or out-of-range wire-supplied model, sound and viewentity indices (and NULL precache entries) with a disconnect; turns four remote-triggerable `Sys_Error` exits into `Host_Error` disconnects; game-stream `svc_stufftext` reaches the console only through the allowlist predicate (`src/driver/qn_stext.c`) |
| `common.c.patch` | `MSG_ReadFloat` is bounds-checked like its sibling readers; `LongSwap` composes its bytes in the unsigned domain (no signed-shift overflow) |
| `gl_vidsdl.c.patch` | macOS: native Metal context, frame and gamma hooks (implementation in `macos/`); other platforms unchanged |
| `host.c.patch` | host init raises the client-slot allocation floor to the engine ceiling so the Host page can reach the per-mode player limits |
| `host_cmd.c.patch` | map/save/view names from server-influenced commands refuse `..`, absolute paths and drive prefixes; embeds the build identity marker `QNBID:<id>` and prints it at startup; map listing includes `.bsp` files inside the base-dir paks; registers the `qn_status` and `qn_visibility` console commands |
| `in_sdl.c.patch` | macOS: SDL2 relative-mouse handling for the Metal renderer |
| `main_sdl.c.patch` | calls `QN_Pump` once per frame from both host loops (daemon spawn, auth watchdog, frame dispatch); macOS command-line entry |
| `Makefile.patch` | builds the driver modules from `src/driver` into the engine (`vpath`, `-I. -I$(QNDIR)`), links the stufftext/admin-verb allowlists and map pools, and offers the optional macOS make hook |
| `Makefile.w64.patch` | the win64 cross-build: `net_bsd.o net_udp.o` plus the driver objects (with the Windows twins and winsock startup), the `QNDIR` vpath and include, OBJDIR staging, static SDL2/mpg123 link flags |
| `menu.c.patch` | the Multiplayer page: the lobby browser panel (room/map/mode/players, up to 16 players), the Host game / Join by code / Setup buttons, the Setup name row filtered at the write site, legacy LAN pages reachable only by the `menu_lanconfig` / `menu_serverlist` console commands |
| `menu.h.patch` | the menu state list: drops the IPX-era network chooser state, adds the Host and Join pages |
| `net_bsd.c.patch` | registers the p2pquake landriver in `net_landrivers[]` after UDP |
| `net_defs.h.patch` | `net_landriver_t` gains `datagram_max` (a landriver's datagram ceiling) and the poll-fd hook the join lane uses |
| `net_dgrm.c.patch` | chunks reliable DATA by the landriver's advertised datagram ceiling; drops packets whose declared length disagrees with the bytes delivered; bounds reassembly to the receive buffer; yields during the connect spin; never echoes host-supplied reject text for a `qn:` dial |
| `net_loop.c.patch` | loopback host-cache copies of the host name and map are bounded (`q_strlcpy`) |
| `net_main.c.patch` | the `hostname` cvar is archived to `config.cfg`, so the room title persists across launches |
| `net_udp.c.patch` | `qn:` names are never handed to the DNS resolver (a join code must not leave the machine); Windows: winsock2 includes, `ioctlsocket` and the winsock error table and resolver diagnostics (`_WIN32`-gated), plus `char *` casts on `recvfrom`/`sendto` that are no-ops elsewhere |
| `quakedef.h.patch` | macOS: the Metal renderer hook declarations |
| `sv_phys.c.patch` | `SV_Physics` re-reads the entity cap each iteration instead of looping on a stale count |
| `sv_user.c.patch` | `clc_stringcmd` dispatch through an exact-first-token allowlist (`src/driver/qn_scmd.c`) instead of upstream's prefix chain, which admitted admin and cheat verbs from any client |
