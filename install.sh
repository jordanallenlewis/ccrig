#!/usr/bin/env bash
# Installer for the Claude Code status line. Delegates to the cross-platform
# Node installer built into statusline.js (Node ships with Claude Code).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/statusline.js" --install "$@"
