# Claude Code status line

A single-file, zero-dependency status line for [Claude Code](https://claude.com/claude-code). It turns the bar at the bottom of your terminal into a command center: model, reasoning effort, context-window usage, git state, and your plan's rate-limit windows. Everything is read straight from the JSON Claude Code already hands the status line, so there are no network calls, no API token, and no keychain reads.

```
📂 my-project │ ★ Opus 4.8 [1m] │ ⚡high │ ctx ████░░░░░░ 42% │ 🌿 main ●7 ↑2 │ [CAVEMAN]
session █████░░░ 63% ↺8:53a │ weekly ███████░ 88% ↺7/22 6:53a
```

The bars are color-coded (green, then yellow, then red). Preview it with sample data before you install anything: `node statusline.js --demo`.

## What it shows

- 👤 the active Claude profile, color-coded, shown only when you actually run more than one profile (`CLAUDE_CONFIG_DIR`); hidden otherwise
- 📂 the current project, as a repo-relative path
- ★ the model, with a `[1m]` tag on a 1M-context model
- ⚡ reasoning effort (low through max)
- `fast` / `no-think` flags, shown only when the inference mode is notable
- a context-window bar: green under 50%, yellow under 70%, red above
- 🌿 git: branch, uncommitted count, unpushed `↑` and unpulled `↓` vs upstream
- session (5-hour) and weekly (7-day) plan-usage bars, each with its reset time
- it wraps to your terminal width, and re-wraps live as you resize the window

## Install

1. Save `statusline.js` somewhere. `~/.claude/statusline.js` is a natural home.
2. Add this to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/statusline.js\""
  }
}
```

If `node` isn't on the PATH the status line runs in, use an absolute node path (the output of `which node`, or `where node` on Windows).

3. Restart Claude Code once. After that, edits to the file apply live within a couple of seconds.

Works on macOS, Linux, and Windows. Node ships with Claude Code, so there's nothing else to install.

## Customize

Open the `CONFIG` block at the top of `statusline.js`. You can toggle any segment on or off, tune the color thresholds, switch reset times between a clock time and a countdown, and change colors (256-color codes). A session-cost segment and a session-name segment are in there too, off by default.

Running two Claude Code profiles (a separate `CLAUDE_CONFIG_DIR`)? Point both `settings.json` files at this one script. It resolves everything per profile, so one file serves both.

## Commands

These run only when you invoke the file by hand. Claude Code always calls it with JSON on stdin and no arguments.

```
node statusline.js --demo [--cols N]   # preview with sample data at a few widths
node statusline.js --selftest          # sanity-check rendering on edge inputs
node statusline.js --help
```

## Credit

The idea came from Hannah Stulberg's guide **"Claude Code for Everything: Your Status Line Is Empty (Let's Fix That)"**: https://hannahstulberg.substack.com/p/claude-code-for-everything-your-status-line-is-empty. The command-center concept, the context-bar thresholds, the folder / model / git / usage segments, and the portable "write it as a Node script" approach all come from there. A comment on that article (by AstroHan) noted that the plan-usage numbers are already in the status line's stdin, which is what let this version drop the API call.

### What's different from the article

- **No network.** The article reads plan usage from the `/api/oauth/usage` endpoint with a keychain token, cached on a timer. This reads `rate_limits`, `context_window`, `effort`, and the mode flags from the stdin Claude Code already sends. No token, no keychain, no rate-limit calls, always fresh.
- Dynamic wrapping that tracks a live terminal resize.
- Extra segments: reasoning effort, fast / no-think flags, unpushed and unpulled commits, date-aware reset times.
- One script serves multiple Claude Code profiles via `CLAUDE_CONFIG_DIR`.
- A config block, a single git call per render, and `--demo` / `--selftest` modes.

## License

MIT © Jordan Allen Lewis. [jordanallenlewis.com](https://jordanallenlewis.com)
