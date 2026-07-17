# claude-profiles.sh — manage & switch Claude Code account profiles.
#
# Source this from your ~/.bashrc or ~/.zshrc:
#   source /path/to/claude-profiles.sh
#
# A "profile" is an isolated CLAUDE_CONFIG_DIR (its own login, settings, history),
# so you can run multiple Claude accounts side by side. The default profile is
# ~/.claude; a named profile "<name>" lives in ~/.claude-<name>. The companion
# status line shows a 👤 badge for whichever profile is active.
#
# Works in bash and zsh.

_cc_profile_dir() {   # name -> dir
  case "$1" in
    ""|default) printf '%s/.claude' "$HOME" ;;
    *)          printf '%s/.claude-%s' "$HOME" "$1" ;;
  esac
}
_cc_profile_name() {  # dir -> name
  case "${1##*/}" in
    .claude)   printf 'default' ;;
    .claude-*) printf '%s' "${1##*/.claude-}" ;;
    *)         printf '%s' "${1##*/}" ;;
  esac
}

claude-profile() {
  local cmd="${1:-list}"; [ $# -gt 0 ] && shift
  case "$cmd" in
    list|ls)
      local cur="${CLAUDE_CONFIG_DIR:-$HOME/.claude}" d
      {
        [ -d "$HOME/.claude" ] && printf '%s\n' "$HOME/.claude"
        find "$HOME" -maxdepth 1 -type d -name '.claude-*' 2>/dev/null | sort
      } | while IFS= read -r d; do
        if [ "$d" = "$cur" ]; then printf '  \033[32m* %s\033[0m\n' "$(_cc_profile_name "$d")"
        else printf '    %s\n' "$(_cc_profile_name "$d")"; fi
      done
      ;;
    use|switch)
      [ -z "$1" ] && { echo "usage: claude-profile use <name>"; return 1; }
      local dir; dir="$(_cc_profile_dir "$1")"
      [ -d "$dir" ] || { echo "profile '$1' not found. create it:  claude-profile new $1"; return 1; }
      export CLAUDE_CONFIG_DIR="$dir"
      echo "✅ Claude profile → $1   ($dir)"
      echo "   run 'claude' to start it in this shell."
      ;;
    run)
      [ -z "$1" ] && { echo "usage: claude-profile run <name> [claude args]"; return 1; }
      local name="$1"; shift; local dir; dir="$(_cc_profile_dir "$name")"
      [ -d "$dir" ] || { echo "profile '$name' not found. create it:  claude-profile new $name"; return 1; }
      CLAUDE_CONFIG_DIR="$dir" claude "$@"
      ;;
    new|create)
      [ -z "$1" ] && { echo "usage: claude-profile new <name>"; return 1; }
      local dir; dir="$(_cc_profile_dir "$1")"
      [ -d "$dir" ] && { echo "profile '$1' already exists ($dir)"; return 1; }
      mkdir -p "$dir" && echo "✅ created profile '$1'.  Start it:  claude-profile use $1 && claude   (then /login)"
      ;;
    current|who)
      local cur="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
      printf '%s   (%s)\n' "$(_cc_profile_name "$cur")" "$cur"
      ;;
    remove|rm)
      [ -z "$1" ] && { echo "usage: claude-profile remove <name>"; return 1; }
      [ "$1" = "default" ] && { echo "refusing to remove the default profile (~/.claude)"; return 1; }
      local dir; dir="$(_cc_profile_dir "$1")"
      [ -d "$dir" ] || { echo "profile '$1' not found"; return 1; }
      printf "remove profile '%s' and ALL its data (%s)? [y/N] " "$1" "$dir"
      local ans; read -r ans
      case "$ans" in [yY]*) rm -rf "$dir" && echo "removed '$1'";; *) echo "cancelled";; esac
      ;;
    -h|--help|help)
      cat <<'EOF'
claude-profile — manage Claude Code account profiles (isolated CLAUDE_CONFIG_DIR)

  claude-profile list                list profiles (* = current)
  claude-profile use <name>          switch this shell to a profile, then run `claude`
  claude-profile run <name> [args]   launch claude with a profile (one-off)
  claude-profile new <name>          create a new profile (then `claude` + /login)
  claude-profile current             show the active profile
  claude-profile remove <name>       delete a profile (asks first)

The default profile is ~/.claude; "<name>" lives in ~/.claude-<name>.
EOF
      ;;
    *) echo "unknown command '$cmd' — try: claude-profile help"; return 1 ;;
  esac
}
