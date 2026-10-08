# CCRig

[![npm version](https://img.shields.io/npm/v/ccrig.svg)](https://www.npmjs.com/package/ccrig)
[![license: MIT](https://img.shields.io/npm/l/ccrig.svg)](LICENSE)

**See your Claude plan budget while you work, and keep the thread when you hit the wall.**

CCRig is a status line and usage-limit guardian for [Claude Code](https://claude.com/claude-code). It shows your 5-hour and weekly plan usage with reset times, pings you (desktop, and your phone if you like) every time a session stops and waits on you, warns before a limit, saves where you were when you reach one, and can pick the session back up at the reset on its own.

```
▾ ccrig ───────────────────────────────────────────────────────────────────────────────────────
● work │ my-project │ Opus 4.8 1M │ effort high │ git main ●3 ↑1
ctx ━━━━────── 42% │ session ━━━━━━╸─── 63% ↺ 8:53a │ weekly ━━━━━━━━╸─ 88% ↺ Tue 6:53a
```

Preview it with sample data before installing: `npx ccrig --demo` (add `--cols 80` to size a screenshot). Fold it to one line any time with `/ccrig:toggle`.

One Node file, zero dependencies, and no network calls while it draws: everything comes from the JSON Claude Code already hands the status line. (The only network anywhere is an optional once-a-day update check, which `"updateCheck": false` turns off, and the phone push for [stop pings](#stop-pings-on-by-default), only if you set `"pushUrl"`.)

## Install

```bash
npm install -g ccrig
ccrig init
```

`ccrig init` wires the status line **and the guardian** into every Claude profile you have, backing up each `settings.json` first. Restart Claude Code once and the bar is live; the usage meters appear after your first reply (that is when Claude Code first sends them).

| Install | Gets you | Pick it if |
|---|---|---|
| npm (`ccrig init`) | the bar under the prompt, the guardian, the CLI, the detached auto-resume watcher | you want the full tool (most people) |
| [the Claude Code mod](#or-install-it-as-a-claude-code-mod) | toasts before a limit, usage on the spinner, `/ccrig` with no Claude turn, resume in the same window | you also want those, or want no npm and no `settings.json` edits |
| [the single file](#install) (below) | the same as npm | you do not use npm |

The npm install and the mod work together without doubling anything up. Update later with `npm install -g ccrig@latest` (or set `"autoUpdate": true` and CCRig installs new releases itself, in the background), and run `ccrig --doctor` if anything looks off. Want just the bar? `ccrig init --no-guardian`.

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
- **The guardian, from the mod.** Checkpoints, resume tickets, keep-working, stop pings and the board lamps run from the mod's hooks, so nothing is written to `settings.json`. Each hook `ccrig init` already wired is left to it, so none runs twice.
- **Resume in place.** With `"autopilot": "resume"` and the terminal still open, the session continues on its own at the reset, in the same window, where you can watch it and answer any prompt. Close the terminal first and the detached watcher takes over as before.

The band (`auto`, `always`, `alerts`, `off`), the spinner readout and the toasts are the ccrig rows in `/config`, and a change there applies at once. Everything else (segments, mode, thresholds, autopilot) lives in the same `~/.ccrig/statusline.config.json` the npm install reads, so `/ccrig mode minimal` changes both.

Both installs together never double up: `ccrig --doctor` shows whether the mod is active.

**Updates** come through Claude Code: `/plugin update ccrig@ccrig` installs the latest release tag (the marketplace never serves unreleased work from `main`). The mod's copy of `statusline.js` never updates itself.

It needs Claude Code 2.1.287 or newer, and Node 18 or newer on your PATH for the full bar and the guardian. Without Node, and in the Desktop app (where a mod may not start processes), the band draws a native line from Claude Code's own figures: model, context, the usage windows and cost. A `claude -p` or SDK run gets the guardian's hooks and nothing else: no drawing, no toasts, no checkpoint written from a render. Anthropic is turning mods on in stages; if `/plugin` reports that hooks modules are turned off, your account does not have them yet, and the npm install above works as before. A mod runs with your permissions, so `claude plugin validate .claude-plugin/plugin.json` on a clone lists every event it hooks and every call it makes before you install it; [SECURITY.md](SECURITY.md) says what each one is for.

The band is shared, so you can build on it. A mod of your own that lists `ccrig` under `dependencies` runs first, gets CCRig's drawing from `next(e)` in a `ui.render` hook for `AbovePrompt`, and can add a line of its own under it. Or describe the line to Claude in a session ("add my open pull request count under the CCRig bar") and it writes the mod for you.

## What the status line shows

- **Profile**: the active Claude account, when you run more than one
- **A rule line** above the bar, so it reads apart from the conversation above it. It turns amber, then red, as a usage window nears its limit
- **Folder, model, effort**: with a `1M` tag on 1M-context models, plus `fast` / `no-think` flags
- **Context window**: a color-coded meter (green, yellow, red)
- **Git**: branch, uncommitted count, unpushed/unpulled vs upstream
- **Billing**: `api` when an API key is billing you per token (`"billing": "always"` under `show` also shows `sub` for a Claude.ai subscription)
- **Session / weekly usage**: your plan's 5-hour and 7-day windows, each with its reset time
- **Forecast**: when you will hit the wall, projected from your recent burn rate
- **Near-limit warning**: from 90% a window's meter turns red with a `▲`, and adds `· saved` once the guardian has checkpointed your work; at 95% a line of its own names the exact `claude --resume <session-id>` command, saved in a resume ticket too

Running subagents and an update badge appear when relevant; cost and the session name show in `expanded` mode or when you turn them on.

The bar fits the terminal it is in. Related items stay on one line when they can, the meters shorten to `5h` / `7d` and then drop their bars on a narrow terminal, and the limit warning shortens instead of being cut off. Color is reserved for state (green, amber, red), so it reads on light and dark terminals alike, and with `NO_COLOR` set it draws no color at all (the meters still read: a heavy fill on a thin track). `minimal` mode keeps the folder, model and the plan numbers (`ctx 42% │ 5h 63% │ 7d 21%`) on one short line. Prefer the pre-1.9 look with emoji icons and block bars? Set `"style": "classic"` (or `CCRIG_STYLE=classic` for one terminal). `"rule": false` hides the rule line; a `▾` at the start of the first line then marks the section, tinted amber or red near a limit like the rule was.

## The Guardian (on by default)

The status line tells you a limit is coming; the guardian acts on it. It is on out of the box (`ccrig init` wires it; `--no-guardian` installs just the bar). From 90% of a window it checkpoints your work state (todos, last request, git HEAD) and saves a resume ticket, and keeps that checkpoint **continuously fresh** through the danger band, so a resume reflects your latest completed step rather than a stale snapshot. At 95% it sends a desktop ping (and, in `resume` mode, arms auto-resume). And when a turn dies on a usage limit the bar never saw coming (a background agent or another session used the window up, so no render crossed 95%), Claude Code's `StopFailure` hook tells the guardian, which checkpoints, saves the ticket and arms the same auto-resume at the reset Claude Code reports (Claude Code 2.1.78 or newer). It also brings compaction-proof checkpoints, and cross-profile failover if you opt in (`"ledger": true` plus `"autopilotFailover": true`). The shipped default is `notify`: no relaunch, nothing unattended (the only background process is the once-a-day update check).

Turn on hands-free auto-resume and a small detached watcher waits out the reset (surviving laptop sleep) and relaunches the exact session with `claude --resume <id> -p`, continuing at the next step instead of redoing finished work:

```bash
ccrig --install-guardian --auto   # hands-free: auto-relaunch the session at reset (autopilot resume)
ccrig --autopilot notify          # the default: checkpoint + keep it fresh + desktop ping, no relaunch
ccrig --autopilot off             # bar only, no guardian side effects
```

Restart Claude Code once so the hooks load. What it honestly can and cannot do: auto-resume needs a Claude.ai Pro/Max plan (Claude Code sends rate-limit data only to subscribers) and a machine that is awake at reset time. It watches the 5-hour and 7-day windows Claude Code reports; a per-model weekly cap (an Opus-only limit, say) is not in that data, so it gets no warning ahead of time, but hitting it still ends the turn with a usage-limit error, which the `StopFailure` hook catches. Only a session that has drawn the bar is relaunched: a `claude -p` script that hits a limit gets the resume ticket, never an unattended relaunch. From the npm install it cannot reach into your open terminal, so it launches a fresh headless run and reconciles via the git snapshot; nothing is lost, because the transcript is continuous. As a [Claude Code mod](#or-install-it-as-a-claude-code-mod) in an open terminal, the resume happens in that session at the reset (no headless relaunch); close the terminal and the detached watcher takes over as before. (If an auto-resume fires while the old terminal is still parked at the limit, close that one rather than typing into it, or the two will fork the same session.) If usage recovers on its own before the reset, because you upgraded your plan or bought extra usage, the guardian notices and stands down. The headless relaunch cannot answer permission prompts; if one blocks it you can set `"autopilotBypassPermissions": true`, off by default because it is a real skip-permission-checks step. It applies only to the guardian's own unattended relaunch, never your interactive session. Nothing runs as a hidden daemon: `ccrig --status` lists armed watchers and `ccrig --disarm` stops them.

Keep-working applies to every session the hook runs in, including a `claude -p` script: with todos still open, its Stop hook asks for another turn (up to its limit). Turn it off for scripts with `--keep-working off`, or run them under a profile without the guardian. Cross-profile failover is for people who hold two plans of their own (work and personal, say); whether continuing on another account is allowed is between you and your plan's terms, which is why it is off unless you turn it on.

## Stop pings (on by default)

A session that stops while you are looking at something else is time lost. CCRig sends a desktop notification every time a session stops and the next move is yours, whether or not its terminal has focus:

- **finished**: the turn ended. The notification carries the start of Claude's reply (`Claude Code: my-project finished`)
- **needs you**: Claude is waiting on a permission prompt, a question (an MCP form), or, for a background session, your input
- **stopped**: the turn died on an API error (overloaded, a server error, an auth or billing problem). A usage limit gets the guardian's own ping instead, which says when to resume (Claude Code 2.1.78 or newer)

A stop parked on a subagent, a workflow or a `/loop` wakeup stays quiet: those report back and wake the session, so you hear about it when it really stops. A background shell or monitor may run for good (a dev server), so it never holds a ping; the ping says what is still running. Keep-working turning a stop around is not a stop either. `claude -p` scripts and SDK runs never ping. Send a test with `ccrig --notify-test`, and turn pings off with `"stopNotify": false` (or `n` in `ccrig --config`). On macOS the notification comes from Script Editor: if none shows up, allow Script Editor in System Settings › Notifications. On Linux it needs `notify-send`.

**On your phone.** Two routes; use either or both:

- **ntfy, for every session.** Install the [ntfy](https://ntfy.sh) app, subscribe to a topic name nobody would guess, and set `"pushUrl": "https://ntfy.sh/<that-topic>"` (or your own ntfy server; add `?auth=<token>` for a protected topic). `CCRIG_PUSH_URL` sets it for one shell. Every ping then reaches your phone too. The push says which session and what happened (`Finished. Your turn.`), never Claude's reply, and it is the only hook that uses the network. Anyone who knows a topic name on the public ntfy.sh server can read it, so make it long and random.
- **Remote Control, Claude Code's own.** For a session you drive from the Claude app, `ccrig init` turns on Claude Code's own phone push where you have never set it: `inputNeededNotifEnabled` and `agentPushNotifEnabled` in `settings.json`, which `/config` › Notifications shows as "Notify when Claude needs you" and "Notify when Claude is done" (Claude Code 2.1.140 or newer, with Remote Control on). Claude Code decides when that push fires; the ntfy route fires on every stop. With `"pushUrl"` set, `ccrig init` leaves Claude Code's push switches alone, so a stop does not reach your phone twice.

The hooks behind the pings ride with the bar: the guardian's Stop hook (or, for a bar-only install, a Stop hook of its own), a Notification hook for the waiting-on-you types, and a `StopFailure` hook for API errors. `ccrig init` or an npm update wires them; turning pings off in `ccrig --config` takes them out.

## The session board (opt-in)

Turn it on with `ccrig board on` and every session publishes its state to a shared folder in your home
directory, so one command shows all of them at once, most urgent first:

```bash
ccrig board on         # sets "sessionBoard": true and wires the lamp hooks (restart Claude Code once)
ccrig --board          # one snapshot
ccrig board --watch    # redraws in place, and pings your desktop when a session starts waiting
```

Each row carries a lamp: red for a session waiting on you (a permission prompt, an MCP form, a
background session asking for input), yellow for one that is working, green for one that just
finished, grey for one that has gone quiet (or, marked `ready`, one you have not prompted yet). Red sorts to the top, because that is the row that needs
you. Green fades to grey after 30 minutes (`"boardDecayMinutes"`), and the ping can be turned off
with `"boardNotify": false`.

The lamps come from hooks (on each prompt, notification, session end and turn end) that are wired only
while the board is on, since each one starts Node. `ccrig board off` turns the board off and takes them
out again; with the board off, nothing is written. Name a session with `/ccrig:name` (or `ccrig --name <label>` in the project folder), which saves the label in `~/.ccrig/names/`, never in the project,
or set `CCRIG_SESSION_NAME` in a shell to label just that one session.

## Configure

```bash
ccrig --config          # interactive editor with live preview
ccrig --mode minimal    # display density: minimal | normal | expanded
```

In the editor, `y` switches between the `refined` and `classic` looks with a live preview.

Want the room back? Fold the section to one line with `/ccrig:toggle` inside a session (or `ccrig collapse` in a shell), and open it again the same way (`ccrig expand`):

```
▸ ccrig  my-project · Opus 4.8 · ctx 42% · 5h 63% · 7d 21% ──────────────────────────────────
```

A window near its limit keeps its `▲` in the folded line, and at the critical threshold the limit warning still gets a line of its own.

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
| `ccrig collapse` / `expand` / `toggle` (`--collapse` / `--expand` / `--toggle`) | fold the CCRig section to one summary line, or open it again; `/ccrig:toggle` does it from inside a session |
| `--autopilot` / `--keep-working` | limit behavior and keep-working, from the shell |
| `--sessions` / `--board` / `--status` / `--disarm` | list sessions, watch every session as a traffic light (`--board --watch`; `ccrig board on` / `off` turns it on or off), list or stop armed watchers (every profile) |
| `--name <label>` | label this project on the board (what `/ccrig:name` runs) |
| `--notify-test` | send a sample stop ping to your desktop, and to your phone when `"pushUrl"` is set |
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
