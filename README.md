# CCRig

[![npm version](https://img.shields.io/npm/v/ccrig.svg)](https://www.npmjs.com/package/ccrig)
[![license: MIT](https://img.shields.io/npm/l/ccrig.svg)](LICENSE)

A status line and usage-limit guardian for [Claude Code](https://claude.com/claude-code). One Node file, zero dependencies. The render makes no network calls: everything comes from the JSON Claude Code already hands the status line. (The only network anywhere is an optional once-a-day update check; set `"updateCheck": false` to turn it off.)

```
👤 work │ 📂 my-project │ ★ Opus 4.8 [1m] │ ⚡high │ ctx ████░░░░░░ 42% │ 🌿 main ●3 ↑1 │ 💳 sub
session █████░░░ 63% ↺8:53a │ weekly ███████░ 88% ↺7/22 6:53a
```

Preview it with sample data before installing: `npx ccrig --demo` (add `--cols 80` to size a screenshot).

## Install

```bash
npm install -g ccrig
ccrig init
```

`ccrig init` wires the status line into every Claude profile you have, backing up each `settings.json` first. Restart Claude Code once and the bar is live. Update later with `npm install -g ccrig@latest`, and run `ccrig --doctor` if anything looks off.

No npm? Grab the single file (Node 18+, which Claude Code ships):

```bash
mkdir -p ~/.claude && curl -fsSL https://raw.githubusercontent.com/jordanallenlewis/ccrig/main/statusline.js -o ~/.claude/statusline.js && node ~/.claude/statusline.js --install
```

Then run the `ccrig ...` commands below as `node ~/.claude/statusline.js ...`.

## What the status line shows

- **Profile**: the active Claude account, when you run more than one
- **Folder, model, effort**: with a `[1m]` tag on 1M-context models, plus `fast` / `no-think` flags
- **Context window**: a color-coded bar (green, yellow, red)
- **Git**: branch, uncommitted count, unpushed/unpulled vs upstream
- **Billing**: `sub` (Claude.ai subscription) or `api` (pay-per-token)
- **Session / weekly usage**: your plan's 5-hour and 7-day windows, each with its reset time
- **Forecast**: when you will hit the wall, projected from your recent burn rate
- **Near-limit warning**: as usage climbs the bar turns red and names the resume command; approaching the wall it saves a resume ticket with the exact `claude --resume <session-id>` line

Running subagents, an update badge, cost, and session name appear when relevant.

## The Guardian (opt-in)

The status line tells you a limit is coming; the guardian acts on it. As you approach a limit it checkpoints your work state (todos, last request, git HEAD), and with auto-resume on, a small detached watcher waits out the reset (surviving laptop sleep) and relaunches the exact session with `claude --resume <id> -p`, continuing at the next step instead of redoing finished work. It also brings keep-working (a Stop hook that keeps the session going while todos remain, with loop guards), cross-profile failover, and compaction-proof checkpoints.

```bash
ccrig --install-guardian          # checkpoint + desktop notify at limits
ccrig --install-guardian --auto   # same, plus hands-free auto-resume
```

Restart Claude Code once so the hooks load. What it honestly can and cannot do: auto-resume needs a Claude.ai Pro/Max plan (Claude Code sends rate-limit data only to subscribers) and a machine that is awake at reset time. It cannot reach into your open terminal, so it launches a fresh headless run and reconciles via the git snapshot; nothing is lost, because the transcript is continuous. (If an auto-resume fires while the old terminal is still parked at the limit, close that one rather than typing into it, or the two will fork the same session.) If usage recovers on its own before the reset, because you upgraded your plan or bought extra usage, the guardian notices and stands down. The headless relaunch cannot answer permission prompts; if one blocks it you can set `"autopilotBypassPermissions": true`, off by default because it is a real skip-permission-checks step. It applies only to the guardian's own unattended relaunch, never your interactive session. Nothing runs as a hidden daemon: `ccrig --status` lists armed watchers and `ccrig --disarm` stops them.

## Configure

```bash
ccrig --config          # interactive editor with live preview
ccrig --mode minimal    # display density: minimal | normal | expanded
```

Or copy `statusline.config.example.json` to `statusline.config.json` next to the script and edit by hand; `ccrig --options` lists every setting. Config is a separate file, so updates never touch it. Inside a Claude Code session, `/ccrig:config` opens the same menu, and `--autopilot` (off | notify | resume) and `--keep-working` (on | off) set the guardian's behavior.

Running several accounts or many parallel sessions? `ccrig --sessions` lists recent sessions across every profile with the command to resume each, `ccrig --board` shows all live sessions at a glance (opt-in), and the bundled `claude-profiles.sh` adds a `claude-profile` switcher for your shell.

## Commands

`ccrig --help` prints the full list; the ones worth knowing:

| Command | Does |
|---|---|
| `ccrig init` (`--install`) | wire the status line into every profile (`--this-profile` for just the active one) |
| `--install-guardian` (`--auto`) | add the guardian; `--auto` also turns on hands-free auto-resume |
| `--uninstall` / `--uninstall-guardian` | remove the status line and guardian, or only the guardian |
| `--doctor` | diagnose a broken or missing setup |
| `--mode` / `--config` / `--options` | display density, interactive editor, list every setting |
| `--autopilot` / `--keep-working` | limit behavior and keep-working, from the shell |
| `--sessions` / `--board` / `--status` / `--disarm` | list sessions, watch live ones, list or stop armed watchers |
| `--update` / `--check-update` / `--whatsnew` / `--dismiss-update` / `--force` | update from npm or in place, check now, show what changed, hide or repair |
| `--demo` / `--selftest` / `--version` | sample render, edge-case checks, version |
| `--purge` | delete local guardian state (checkpoints, tickets, cache) |

## Uninstall

```bash
ccrig --uninstall            # remove the status line + any guardian hooks (all profiles)
ccrig --uninstall-guardian   # remove only the guardian; keep the status line
ccrig --purge                # delete local guardian state
```

Your config and the settings backups stay put.

## License

MIT © Jordan Allen Lewis. The idea came from Hannah Stulberg's guide [_"Your Status Line Is Empty (Let's Fix That)"_](https://hannahstulberg.substack.com/p/claude-code-for-everything-your-status-line-is-empty). Contributions welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
