#!/usr/bin/env bash
# Installer for the Claude Code status line.
# Points your Claude Code settings.json at this repo's statusline.js (so `git pull`
# updates the tool), and turns on a refresh timer. Safe to re-run.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SL="$DIR/statusline.js"
CFG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CFG_DIR/settings.json"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "!! node was not found on your PATH. Claude Code ships with Node, so this is unusual." >&2
  echo "   Install Node or edit the command in $SETTINGS to an absolute node path afterward." >&2
fi
# Prefer an absolute node path (the status line's PATH can be minimal).
if [ -n "$NODE" ]; then CMD="\"$NODE\" \"$SL\""; else CMD="node \"$SL\""; fi

mkdir -p "$CFG_DIR"

# Merge the statusLine block into settings.json without clobbering other settings.
node -e '
  const fs = require("fs");
  const [file, cmd] = process.argv.slice(1);
  let j = {};
  try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  j.statusLine = { type: "command", command: cmd, refreshInterval: 2 };
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
' "$SETTINGS" "$CMD"

echo "✅ status line installed → $SETTINGS"
echo
echo "   preview:    node \"$SL\" --demo"
echo "   customize:  node \"$SL\" --config"
echo "   multiple accounts:  add this to your ~/.zshrc or ~/.bashrc:"
echo "                 source \"$DIR/claude-profiles.sh\""
echo
echo "Restart Claude Code once to load the status line (edits apply live after that)."
