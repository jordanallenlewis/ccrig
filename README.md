# Claude Code Better Status Line

Claude Code Better Status Line is a small toolkit for [Claude Code](https://claude.com/claude-code):

1. **A status line** that turns the bar at the bottom of your terminal into a command center: active profile, model, reasoning effort, context-window usage, git state, billing path, and your plan's rate-limit windows.
2. **A profile switcher** for running multiple Claude accounts side by side.

Everything the status line shows is read from the JSON Claude Code already hands it on stdin, so there are no network calls, no API token, and no keychain reads. It's a single Node file with zero dependencies (Node ships with Claude Code), and your settings live in a separate config file so updates never overwrite them.

```
👤 work │ 📂 my-project │ ★ Opus 4.8 [1m] │ ⚡high │ ctx ████░░░░░░ 42% │ 🌿 main ●3 ↑1 │ 💳 sub
session █████░░░ 63% ↺8:53a │ weekly ███████░ 88% ↺7/22 6:53a
```

The bars are color-coded (green, then yellow, then red) and the line wraps to your terminal width. Once you have the file (download or clone below), you can preview it with sample data before wiring anything: `node statusline.js --demo`.

> If it earns a spot in your terminal, please **star the project** on GitLab. It is free and it is the whole ask, and a star is how the next person finds it.

## Install

One line on macOS / Linux:

```bash
mkdir -p ~/.claude && curl -fsSL https://gitlab.com/jordanallenlewis/claude-code-statusline/-/raw/main/statusline.js -o ~/.claude/statusline.js && node ~/.claude/statusline.js --install
```

One line on Windows (PowerShell):

```powershell
mkdir -Force $HOME\.claude | Out-Null; iwr https://gitlab.com/jordanallenlewis/claude-code-statusline/-/raw/main/statusline.js -OutFile $HOME\.claude\statusline.js; node $HOME\.claude\statusline.js --install
```

The installer wires your `~/.claude/settings.json` (or the active `CLAUDE_CONFIG_DIR` profile, if you run several: re-run it per profile), backing the file up first. It uses the exact node binary it was run with and is safe to re-run. If `node` isn't on your PATH, run the same commands with an absolute path to any Node 18+ binary. Restart Claude Code once; after that, edits apply live. Run `node statusline.js --help` for the full flag list.

Prefer a clone? It keeps you on `git pull` updates and includes the profile switcher:

```bash
git clone https://gitlab.com/jordanallenlewis/claude-code-statusline.git
cd claude-code-statusline
./install.sh        # or: node statusline.js --install
```

To wire it by hand instead, add this to `~/.claude/settings.json` (use an absolute node path if `node` isn't on the status line's PATH):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/statusline.js\"",
    "refreshInterval": 2
  }
}
```

If anything looks wrong, `node statusline.js --doctor` diagnoses the usual suspects (unwired settings, a node path broken by a version manager upgrade, invalid config). `node statusline.js --uninstall` removes it cleanly.

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
- **⚠ near-limit hint**: once session or weekly usage crosses the warn threshold (90% by default), the bar turns bold red and a hint shows that your work is auto-saved and how to pick it back up (`claude --continue`).
- **resume tickets**: at critical usage (98% by default) it also saves `resume-tickets/<session>.md` in your Claude config dir, holding the project path and the exact `claude --resume <session-id>` command. Claude Code already saves the transcript continuously, so nothing is lost at a limit; the ticket is for days later, after a weekly reset, when `claude --continue` would resume the wrong (a newer) session. Turn off with `"resumeTickets": false`.
- **[CAVEMAN]**: the mode badge for the third-party caveman plugin, shown only if you use that plugin; everyone else never sees it.
- **cost / session name**: session spend and the session's title. Off by default.

## Customize

Three ways, easiest first.

**From a Claude Code session** (installed by `--install`): run `/statusline-config`. It opens an interactive menu right in the CLI (pick display mode, toggle a segment, reset style, thresholds, and so on), applies your choice, shows a fresh preview, and asks if you want to change anything else. You can also just say what you want ("switch to minimal", "turn off billing"). `node statusline.js --options` prints the option list in a terminal.

**Interactive terminal editor:**

```bash
node statusline.js --config
```

It shows a live preview, lets you toggle any segment, cycle the mode (`m`), and writes your choices to `statusline.config.json` next to the script.

**By hand:** copy `statusline.config.example.json` to `statusline.config.json` and edit colors, thresholds, segment order, reset style, and profile labels. Your config is a separate file, so updating `statusline.js` never wipes it.

## Display modes

Three densities, switchable in one command (applies live in a couple of seconds):

```bash
node statusline.js --mode minimal    # quiet: profile, folder, model, context, git
node statusline.js --mode normal     # the default set of segments
node statusline.js --mode expanded   # everything with data, including cost and session name
```

The near-limit warning always shows through, even in minimal mode. In the `--config` editor, press `m` to cycle modes with a live preview. `normal` respects your per-segment toggles; `minimal` and `expanded` override them.

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
claude-profile remove work      # delete a profile (asks first; won't touch the default)
```

The status line's `👤` badge shows which profile is active, so you always know which account you're in.

## Staying responsive

Claude Code refreshes the status line after each message (debounced at 300ms) and, since Claude Code 2.1.97, `refreshInterval` re-runs it on a timer too (see the [status line docs](https://code.claude.com/docs/en/statusline)). The installer sets `refreshInterval: 2`, so time-based segments like reset countdowns stay current even while a session is idle; on an older Claude Code the key is ignored harmlessly. Git state is cached briefly (`gitCacheMs`, default 2500ms) so a large repository doesn't slow down every render.

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
