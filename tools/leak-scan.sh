#!/usr/bin/env bash
# Fail if a release file carries the builder's identity: the home path or
# the account name, in any file, binaries included. Zips are unpacked
# first, so this checks the exact file that ships. The identity comes from
# the environment of whoever builds; nothing personal is written here.
#
# Usage: tools/leak-scan.sh <file.zip|directory> ...
set -euo pipefail
ME_USER="${USER:-$(id -un)}"
ME_HOME="${HOME:-}"
[ -n "$ME_USER" ] && [ -n "$ME_HOME" ] || { echo "leak-scan: cannot determine the builder identity" >&2; exit 1; }
[ "$#" -gt 0 ] || { echo "usage: tools/leak-scan.sh <file.zip|directory> ..." >&2; exit 2; }

W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
bad=0
for target in "$@"; do
  case "$target" in
    *.zip) dir="$W/$(basename "$target").d"; mkdir -p "$dir"
           python3 -I -m zipfile -e "$target" "$dir" ;;
    *) [ -d "$target" ] || { echo "leak-scan: not a zip or directory: $target" >&2; exit 2; }
       dir="$target" ;;
  esac
  files=$(find "$dir" -type f | wc -l)
  hits=$(grep -r -l -a -F -e "$ME_HOME" -e "$ME_USER" "$dir" || true)
  if [ -n "$hits" ]; then
    echo "leak-scan: $target carries the builder's home path or account name:" >&2
    printf '%s\n' "$hits" | sed "s|^$dir/|  |" >&2
    bad=1
  else
    echo "leak-scan: $target clean ($files files, 0 hits)"
  fi
done
exit "$bad"
