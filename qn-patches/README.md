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

To add a fix: edit the engine file (hook points only), build and test,
commit the engine change, then export the per-file diff against the
pre-patch baseline as the next number and verify it applies cleanly to a
pristine copy of the pinned engine:

    git diff <engine-sync-commit> -- src/vendor/quakespasm/Quake/<file> \
      | sed '2s|a/.*/a/Quake/<file>|;3s|b/.*/b/Quake/<file>|' > qn-patches/NNNN-name.patch
