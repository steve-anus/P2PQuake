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
| `0003-host_cmd-path-traversal-filter.patch` | rejects `..`, absolute paths and drive prefixes in map/save names accepted by server-influenced console commands |

The vendored engine is otherwise upstream code (URL and commit recorded in
`ENGINE.upstream`) and is only ever modified in: `Quake/net_bsd.c`,
`Quake/main_sdl.c`, `Quake/net_main.c`, `Quake/host.c`, `Quake/cl_parse.c`,
`Quake/host_cmd.c`, `Quake/Makefile`. Anything else upstream must stay
untouched so updates stay cheap and reviews stay small.

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
