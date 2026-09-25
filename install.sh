#!/usr/bin/env bash
# Installer for the Claude Code status line. Delegates to the cross-platform
# Node installer built into statusline.js (Node ships with Claude Code).
# Plain POSIX sh on purpose, so `sh install.sh` works on Debian/Ubuntu (dash) too.
set -eu
SRC="$0"
# run through a symlink: follow it to the real file, which sits next to statusline.js
while [ -L "$SRC" ]; do
  L="$(readlink "$SRC")"
  case "$L" in /*) SRC="$L" ;; *) SRC="$(dirname -- "$SRC")/$L" ;; esac
done
DIR="$(CDPATH='' cd -- "$(dirname -- "$SRC")" && pwd)"
exec node "$DIR/statusline.js" --install "$@"
