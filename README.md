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

`ccrig init` wires the status line **and the guardian** into every Claude profile you have, backing up each `settings.json` first. Restart Claude Code once and the bar is live. Update later with `npm install -g ccrig@latest` (or set `"autoUpdate": true` and CCRig installs new releases itself, in the background), and run `ccrig --doctor` if anything looks off. Want just the bar? `ccrig init --no-guardian`.

No npm? Grab the single file. It needs Node 18 or newer on your PATH (the native Claude Code installer does not include Node). It goes in its own folder, so it never overwrites a `~/.claude/statusline.js` of your own.

macOS / Linux:

```bash
mkdir -p ~/.claude/ccrig && curl -fsSL https://github.com/jordanallenlewis/ccrig/releases/latest/download/statusline.js -o ~/.claude/ccrig/statusline.js && node ~/.claude/ccrig/statusline.js --install
```

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\ccrig" | Out-Null; Invoke-WebRequest https://github.com/jordanallenlewis/ccrig/releases/latest/download/statusline.js -OutFile "$env:USERPROFILE\.claude\ccrig\statusline.js"; node "$env:USERPROFILE\.claude\ccrig\statusline.js" --install
```

Then run the `ccrig ...` commands below as `node ~/.claude/ccrig/statusline.js ...` (in PowerShell, `node "$env:USERPROFILE\.claude\ccrig\statusline.js" ...`).

## Or install it as a Claude Code mod

Claude Code can load mods: plugins whose code runs inside Claude Code and draws in its interface. CCRig ships as one. Install it with `/plugin` in the CLI or the Desktop app, with no npm and no `settings.json` edits:

```
/plugin marketplace add jordanallenlewis/ccrig
/plugin install ccrig@ccrig
```

Run `/reload-plugins` (or restart) and you get:

- **The bar above the prompt.** CCRig draws in the band above the prompt input, wrapped to its width. Already wired the status line with `ccrig init`? Then the band stays empty until a usage window passes your warn line, and then shows the alert, the resume command and a Copy button.
- **Usage on the spinner.** `Thinking · session 63%…` while Claude works.
- **A toast before the wall.** Claude Code pushes usage to the mod as it moves, so the toast lands when a window crosses warn (90%) or critical (95%), with no polling.
- **`/ccrig` with no Claude turn.** It answers at once, even mid-turn: `/ccrig` for a one-line summary, `/ccrig usage` for a pane with the bars, reset times and the pace forecast, `/ccrig board` for the session board, and `mode`, `autopilot`, `keep-working`, `status`, `sessions` and `doctor` as in the CLI.
- **The guardian, from the mod.** Checkpoints, resume tickets, keep-working and the board lamps run from the mod's hooks, so nothing is written to `settings.json`. Each hook `ccrig init` already wired is left to it, so none runs twice.
- **Resume in place.** With `"autopilot": "resume"` and the terminal still open, the session continues on its own at the reset, in the same window, where you can watch it and answer any prompt. Close the terminal first and the detached watcher takes over as before.

The band (`auto`, `always`, `alerts`, `off`), the spinner readout and the toasts are the ccrig rows in `/config`, and a change there applies at once. Everything else (segments, mode, thresholds, autopilot) lives in the same `~/.ccrig/statusline.config.json` the npm install reads, so `/ccrig mode minimal` changes both.

**Which install?** For the bar under the prompt, the shell CLI and the detached auto-resume watcher, use npm (`ccrig init`); add the mod for the toasts, the spinner readout, the panes and an immediate `/ccrig`. For no npm and no `settings.json` edits, use the mod alone. Both together never double up: `ccrig --doctor` shows whether the mod is active.

**Updates** come through Claude Code: `/plugin update ccrig@ccrig` installs the latest release tag (the marketplace never serves unreleased work from `main`). The mod's copy of `statusline.js` never updates itself.

It needs Claude Code 2.1.287 or newer, and Node 18 or newer on your PATH for the full bar and the guardian. Without Node, and in the Desktop app (where a mod may not start processes), the band draws a native line from Claude Code's own figures: model, context, the usage windows and cost. A `claude -p` or SDK run gets the guardian's hooks and nothing else: no drawing, no toasts, no checkpoint written from a render. Anthropic is turning mods on in stages; if `/plugin` reports that hooks modules are turned off, your account does not have them yet, and the npm install above works as before. A mod runs with your permissions, so `claude plugin validate .claude-plugin/plugin.json` on a clone lists every event it hooks and every call it makes before you install it; [SECURITY.md](SECURITY.md) says what each one is for.

The band is shared, so you can build on it. A mod of your own that lists `ccrig` under `dependencies` runs first, gets CCRig's drawing from `next(e)` in a `ui.render` hook for `AbovePrompt`, and can add a line of its own under it. Or describe the line to Claude in a session ("add my open pull request count under the CCRig bar") and it writes the mod for you.

## What the status line shows

- **Profile**: the active Claude account, when you run more than one
- **Folder, model, effort**: with a `[1m]` tag on 1M-context models, plus `fast` / `no-think` flags
- **Context window**: a color-coded bar (green, yellow, red)
- **Git**: branch, uncommitted count, unpushed/unpulled vs upstream
- **Billing**: `sub` (Claude.ai subscription) or `api` (pay-per-token)
- **Session / weekly usage**: your plan's 5-hour and 7-day windows, each with its reset time
- **Forecast**: when you will hit the wall, projected from your recent burn rate
- **Near-limit warning**: as usage climbs the bar turns red and names the resume command; approaching the wall it saves a resume ticket with the exact `claude --resume <session-id>` line

Running subagents and an update badge appear when relevant; cost and the session name show in `expanded` mode or when you turn them on.

## The Guardian (on by default)

The status line tells you a limit is coming; the guardian acts on it. It is on out of the box (`ccrig init` wires it; `--no-guardian` installs just the bar). From 90% of a window it checkpoints your work state (todos, last request, git HEAD) and saves a resume ticket, and keeps that checkpoint **continuously fresh** through the danger band, so a resume reflects your latest completed step rather than a stale snapshot. At 95% it sends a desktop ping (and, in `resume` mode, arms auto-resume). It also brings compaction-proof checkpoints, and cross-profile failover if you opt in (`"ledger": true` plus `"autopilotFailover": true`). The shipped default is `notify`: no relaunch, nothing unattended (the only background process is the once-a-day update check).

Turn on hands-free auto-resume and a small detached watcher waits out the reset (surviving laptop sleep) and relaunches the exact session with `claude --resume <id> -p`, continuing at the next step instead of redoing finished work:

```bash
ccrig --install-guardian --auto   # hands-free: auto-relaunch the session at reset (autopilot resume)
ccrig --autopilot notify          # the default: checkpoint + keep it fresh + desktop ping, no relaunch
ccrig --autopilot off             # bar only, no guardian side effects
```

Restart Claude Code once so the hooks load. What it honestly can and cannot do: auto-resume needs a Claude.ai Pro/Max plan (Claude Code sends rate-limit data only to subscribers) and a machine that is awake at reset time. It watches the 5-hour and 7-day windows Claude Code reports; a per-model weekly cap (an Opus-only limit, say) is not in that data, so hitting one gets no checkpoint or ping. From the npm install it cannot reach into your open terminal, so it launches a fresh headless run and reconciles via the git snapshot; nothing is lost, because the transcript is continuous. As a [Claude Code mod](#or-install-it-as-a-claude-code-mod) in an open terminal, the resume happens in that session at the reset (no headless relaunch); close the terminal and the detached watcher takes over as before. (If an auto-resume fires while the old terminal is still parked at the limit, close that one rather than typing into it, or the two will fork the same session.) If usage recovers on its own before the reset, because you upgraded your plan or bought extra usage, the guardian notices and stands down. The headless relaunch cannot answer permission prompts; if one blocks it you can set `"autopilotBypassPermissions": true`, off by default because it is a real skip-permission-checks step. It applies only to the guardian's own unattended relaunch, never your interactive session. Nothing runs as a hidden daemon: `ccrig --status` lists armed watchers and `ccrig --disarm` stops them.

## The session board (opt-in)

Turn on `"sessionBoard": true` and every session publishes its state to a shared folder in your home
directory, so one command shows all of them at once, most urgent first:

```bash
ccrig --board          # one snapshot
ccrig board --watch    # redraws in place, and pings your desktop when a session starts waiting
```

Each row carries a lamp: red for a session waiting on you (a permission prompt, an MCP form, a
background session asking for input), yellow for one that is working, green for one that just
finished, grey for one that has gone quiet (or, marked `ready`, one you have not prompted yet). Red sorts to the top, because that is the row that needs
you. Green fades to grey after 30 minutes (`"boardDecayMinutes"`), and the ping can be turned off
with `"boardNotify": false`.

The lamps come from hooks that `ccrig init` wires, so re-run `ccrig init` once if you installed an
older version. Name a session with `/ccrig:name` (or `ccrig --name <label>` in the project folder), which writes `.claude/ccrig-name` there,
or set `CCRIG_SESSION_NAME` in a shell to label just that one session. With the board off, nothing
is written and the hooks do nothing.

## Configure

```bash
ccrig --config          # interactive editor with live preview
ccrig --mode minimal    # display density: minimal | normal | expanded
```

Or copy `statusline.config.example.json` to `statusline.config.json` and edit by hand: for an npm install it lives in `~/.ccrig/`, for a standalone copy next to the script (`ccrig --options` prints the exact path and every setting). Config is a separate file, so updates never touch it. Inside a Claude Code session, `/ccrig:config` opens the same menu, and `--autopilot` (off | notify | resume) and `--keep-working` (on | off) set the guardian's behavior.

Running several accounts or many parallel sessions? `ccrig --sessions` lists recent sessions across every profile with the command to resume each, `ccrig --board` shows every session as a traffic light (opt-in), and the `claude-profile` switcher that ships in the npm package works in bash, zsh and PowerShell:

```bash
source "$(npm root -g)/ccrig/claude-profiles.sh"          # bash / zsh / Git Bash: add to ~/.bashrc or ~/.zshrc
```

```powershell
. "$(npm root -g)\ccrig\claude-profiles.ps1"             # PowerShell: add to $PROFILE (Windows PowerShell 5.1 may first need: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned)
```

(A standalone single-file copy has no switcher; grab `claude-profiles.sh` / `.ps1` from the repo the same way if you want it.)

## Commands

`ccrig --help` prints the full list; the ones worth knowing:

| Command | Does |
|---|---|
| `ccrig init` (`--install`) | wire the bar + guardian into every profile (`--this-profile` for just one; `--no-guardian` for bar only) |
| `--install-guardian` (`--auto`) | (re)wire the guardian + keep-working; `--auto` turns on hands-free auto-resume |
| `--uninstall` / `--uninstall-guardian` | remove the status line and guardian, or only the guardian |
| `--doctor` | diagnose a broken or missing setup |
| `--mode` / `--config` / `--options` | display density, interactive editor, list every setting |
| `--autopilot` / `--keep-working` | limit behavior and keep-working, from the shell |
| `--sessions` / `--board` / `--status` / `--disarm` | list sessions, watch every session as a traffic light (`--board --watch`), list or stop armed watchers (every profile) |
| `--name <label>` | label this project on the board (what `/ccrig:name` runs) |
| `--update` / `--check-update` / `--whatsnew` / `--dismiss-update` / `--force` | update from npm or in place, check now, show what changed, hide or repair |
| `--demo` / `--selftest` / `--version` | sample render, edge-case checks, version |
| `--purge` | delete local guardian state (checkpoints, tickets, cache) |

## Windows: when Git Bash breaks

On Windows with Git for Windows installed, Claude Code runs every status line through Git Bash, and nothing in `settings.json` can change that. If Git Bash's runtime breaks (a damaged Git for Windows install, or security software hooking it), `bash.exe` hangs on startup. Each status line refresh then leaves one more stuck `bash.exe` behind, `git push` fails too, and ending the processes by hand does not help because the next refresh starts more.

CCRig handles that on its own:

- **Its hooks never use Git Bash.** With Claude Code 2.1.139 or newer, `ccrig init` wires the hooks to start `node.exe` directly. An install wired the older way moves over the first time the bar sees a new enough Claude Code.
- **The bar steps aside.** When the bar has stopped drawing, the next hook tries Git Bash in the background. If Git Bash hangs, CCRig takes its status line out of `settings.json` (keeping the exact entry), ends the stuck shells that were running it, and says so once in the session and with a desktop notification. Once Git Bash starts again, the bar comes back by itself.
- **`ccrig --doctor` says what is wrong.** It times Git Bash, ends stuck CCRig shells, and reports a pause.

The fix for Git Bash itself: reboot first. If `bash -c "echo ok"` still hangs, repair or reinstall Git for Windows, or ask IT whether security software is blocking it. The [mod](#or-install-it-as-a-claude-code-mod) never uses a shell, so it is not affected at all.

## Uninstall

```bash
ccrig --uninstall            # remove the status line + any guardian hooks (all profiles)
ccrig --uninstall-guardian   # remove only the guardian; keep the status line
ccrig --purge                # delete local guardian state
```

Your config and the settings backups stay put. With npm, run `ccrig --uninstall` **before** `npm uninstall -g ccrig`: npm runs no uninstall step, so removing the package first leaves the status line and hooks pointing at a deleted file. Already did it the other way round? `npx ccrig --uninstall` cleans up the leftovers.

## License

MIT © Jordan Allen Lewis. The idea came from Hannah Stulberg's guide [_"Your Status Line Is Empty (Let's Fix That)"_](https://hannahstulberg.substack.com/p/claude-code-for-everything-your-status-line-is-empty). Contributions welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
