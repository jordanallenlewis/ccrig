# Claude Code status line + profile switcher

A small toolkit for [Claude Code](https://claude.com/claude-code):

1. **A status line** that turns the bar at the bottom of your terminal into a command center: active profile, model, reasoning effort, context-window usage, git state, billing path, and your plan's rate-limit windows.
2. **A profile switcher** for running multiple Claude accounts side by side.

Everything the status line shows is read from the JSON Claude Code already hands it on stdin, so there are no network calls, no API token, and no keychain reads. It's a single Node file with zero dependencies (Node ships with Claude Code), and your settings live in a separate config file so updates never overwrite them.

```
👤 work │ 📂 my-project │ ★ Opus 4.8 [1m] │ ⚡high │ ctx ████░░░░░░ 42% │ 🌿 main ●3 ↑1 │ 💳 sub
session █████░░░ 63% ↺8:53a │ weekly ███████░ 88% ↺7/22 6:53a
```

The bars are color-coded (green, then yellow, then red) and the line wraps to your terminal width. Preview it with sample data before installing anything: `node statusline.js --demo`.

## Install

Clone the repo, then run the installer. It points Claude Code at this copy, so `git pull` updates the tool.

```bash
git clone https://gitlab.com/jordanallenlewis/claude-code-statusline.git
cd claude-code-statusline
./install.sh
```

To configure it by hand, add this to `~/.claude/settings.json` (use an absolute node path if `node` isn't on the status line's PATH):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/statusline.js\"",
    "refreshInterval": 2
  }
}
```

Restart Claude Code once. After that, edits apply live. Works on macOS, Linux, and Windows.

## What the status line shows

- **👤 profile**: the active Claude profile, when you run more than one (see below). Hidden if you only have one.
- **📂 folder**: the current project, as a repo-relative path.
- **★ model**: the model, with a `[1m]` tag on a 1M-context model.
- **⚡ effort**: reasoning effort (low through max).
- **flags**: `fast` when Fast mode is on, `no-think` when extended thinking is off.
- **ctx**: a context-window bar. Green under 50%, yellow under 70%, red above.
- **🌿 git**: branch, uncommitted count, unpushed `↑` and unpulled `↓` vs upstream.
- **💳 billing**: `sub` for a Claude.ai subscription, `api` for pay-per-token. Claude Code sends rate-limit data only to subscribers, which is how this is detected.
- **session / weekly**: 5-hour and 7-day plan-usage bars, each with its reset time (a clock time today, dated when it's days out).
- **cost / session name**: session spend and the session's title. Off by default.

## Customize

Run the interactive editor:

```bash
node statusline.js --config
```

It shows a live preview, lets you toggle any segment, and writes your choices to `statusline.config.json` next to the script. You can also hand-edit that file (copy `statusline.config.example.json` to start) to change colors, thresholds, segment order, reset style, and profile labels. Your config is a separate file, so updating `statusline.js` never wipes it.

## Multiple Claude accounts

A profile is an isolated `CLAUDE_CONFIG_DIR` with its own login, settings, and history. The default profile is `~/.claude`, and a named profile lives in `~/.claude-<name>`. Source the helper from your shell:

```bash
# in ~/.zshrc or ~/.bashrc
source /path/to/claude-code-statusline/claude-profiles.sh
```

Then:

```bash
claude-profile new work         # create a profile
claude-profile use work         # switch this shell to it, then run `claude`
claude-profile run work         # or launch claude with it in one shot
claude-profile list             # list profiles (* = current)
claude-profile current          # show the active one
```

The status line's `👤` badge shows which profile is active, so you always know which account you're in.

## Staying responsive

Claude Code refreshes the status line after each message (debounced at 300ms) and, with `refreshInterval` set, on a timer too. The installer sets `refreshInterval: 2`, so time-based segments like reset countdowns stay current even while a session is idle. Git state is cached briefly (`gitCacheMs`, default 2500ms) so a large repository doesn't slow down every render.

## Credit

The idea came from Hannah Stulberg's guide **"Claude Code for Everything: Your Status Line Is Empty (Let's Fix That)"**: https://hannahstulberg.substack.com/p/claude-code-for-everything-your-status-line-is-empty. The command-center concept, the context-bar thresholds, the folder / model / git / usage segments, and the portable Node-script approach come from there. A comment on that article (by AstroHan) noted that the plan-usage numbers are already in the status line's stdin, which is what let this version drop the API call.

### What's different from the article

- **No network.** The article reads plan usage from the `/api/oauth/usage` endpoint with a keychain token. This reads `rate_limits`, `context_window`, `effort`, and the mode flags from the stdin Claude Code already sends. No token, no keychain, no rate-limit calls, always fresh.
- Line-wrapping that tracks a live terminal resize, and a brief git cache for large repos.
- Extra segments: active profile, reasoning effort, fast / no-think flags, unpushed / unpulled commits, billing path, and date-aware reset times.
- External config with an interactive editor, so nothing is hardcoded and updates don't clobber your settings.
- A companion profile switcher for running multiple Claude accounts.

## Contributing

Contributions are welcome and anyone can send one. See [CONTRIBUTING.md](CONTRIBUTING.md). Every change lands through a merge request that a maintainer approves. Changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## License

MIT © Jordan Allen Lewis. [jordanallenlewis.com](https://jordanallenlewis.com)
