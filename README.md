# CCRig

[![npm version](https://img.shields.io/npm/v/ccrig.svg)](https://www.npmjs.com/package/ccrig)
[![npm downloads](https://img.shields.io/npm/dm/ccrig.svg)](https://www.npmjs.com/package/ccrig)
[![node](https://img.shields.io/node/v/ccrig.svg)](https://www.npmjs.com/package/ccrig)
[![license: MIT](https://img.shields.io/npm/l/ccrig.svg)](LICENSE)

**Your Claude Code rig.** The operational layer that makes [Claude Code](https://claude.com/claude-code) pleasant to run all day: a live command bar, an opt-in guardian that picks your work back up after a usage limit, and more as it grows.

Three pieces so far:

1. **A status line** that turns the bar at the bottom of your terminal into a command center: active profile, model, reasoning effort, context-window usage, git state, billing path, and your plan's rate-limit windows.
2. **The Guardian** (opt-in): the part that *acts* on your limits instead of just showing them. It keeps a session working while there is work left, and when you hit a limit it snapshots your exact work state and can pick the session back up the moment the window resets, carrying on at the next step instead of redoing finished work. See [The Guardian](#the-guardian).
3. **A cross-session board, a resume-picker, and a profile switcher** (`--board`, `--sessions`) for running many sessions across worktrees and accounts.

Everything the status line shows is read from the JSON Claude Code already hands it on stdin, so **the render makes no network calls**: no API token, no keychain reads, nothing leaves your machine. (The one exception is an optional once-a-day update check in the background, off with `"updateCheck": false`.) It is a single Node file with zero dependencies (Node ships with Claude Code), and your settings live in a separate config file so updates never touch them.

```
👤 work │ 📂 my-project │ ★ Opus 4.8 [1m] │ ⚡high │ ctx ████░░░░░░ 42% │ 🌿 main ●3 ↑1 │ 💳 sub
session █████░░░ 63% ↺8:53a │ weekly ███████░ 88% ↺7/22 6:53a
```

The bars are color-coded (green, then yellow, then red) and the line wraps to your terminal width. When a limit is coming (this is where CCRig earns its spot), it forecasts the wall and, if you have enabled the guardian, checkpoints your work and arms the pickup:

```
👤 work │ 📂 my-project │ ★ Opus 4.8 [1m] │ ⚡high │ ctx ██████░░░░ 61% │ 🌿 main ●2
session ████████░ 96% ↺2h14m │ weekly ██████░░ 71% ↺7/22 │ ⏳ ~9m to session limit · slow down │ ⚠ limit imminent: checkpoint saved, autopilot armed
```

> If it earns a spot in your terminal, please **star the project** on GitLab. It is free, it is the whole ask, and a star is how the next person finds it.

## Install

Two short steps: install the command, then set it up in Claude Code.

```bash
npm install -g ccrig      # 1. install the ccrig command
ccrig init                # 2. wire the status line into Claude Code
```

`ccrig init` finds every Claude profile you have (your `~/.claude` and any `~/.claude-<name>`), backs up each `settings.json` first, wires in the status line, and prints what it changed. Restart Claude Code once and the bar is live: profile, model, context window, git state, and your plan's usage windows. It is safe to re-run, so run it again after you add a profile; scope it to the active one with `--this-profile`.

Installing tries to run that setup for you too, but npm v12, pnpm, yarn, and bun turn install scripts off by default, so `ccrig init` (the same as `ccrig --install`) is the step that always works. Skip the automatic attempt with `CCRIG_NO_POSTINSTALL=1`.

Want to look first? `npx ccrig --demo` renders the bar with sample data (add `--cols 80` to size a screenshot). Commands in this README use the `ccrig ...` form the npm install gives you: `ccrig --help` lists everything, `ccrig --version` prints the version, and `ccrig --selftest` sanity-checks rendering on edge inputs.
- Update any time with `npm install -g ccrig@latest` (see [Update](#update)).
- If anything looks off, `ccrig --doctor` diagnoses the usual suspects: unwired settings, a node path broken by a version-manager upgrade, invalid config.
- **Backing out** is clean and total: `--uninstall` removes the status line and any guardian hooks across every profile, `--uninstall-guardian` removes just the guardian, and `--purge` deletes the local state it wrote for the active profile (checkpoints, resume tickets, watcher files, the update cache, this profile's ledger entry, the shared session board, temp caches, and the render error log). Your config, the settings backups, and the script itself stay put.

<details>
<summary><b>No npm? Install the single file directly.</b></summary>

CCRig needs Node 18+ (Claude Code ships it). If you have Node but not npm, grab the one file. macOS / Linux:

```bash
mkdir -p ~/.claude && curl -fsSL https://gitlab.com/jordanallenlewis/ccrig/-/raw/main/statusline.js -o ~/.claude/statusline.js && node ~/.claude/statusline.js --install
```

Windows (PowerShell):

```powershell
mkdir -Force $HOME\.claude | Out-Null; iwr https://gitlab.com/jordanallenlewis/ccrig/-/raw/main/statusline.js -OutFile $HOME\.claude\statusline.js; node $HOME\.claude\statusline.js --install
```

Then run the `ccrig ...` commands from this README as `node statusline.js ...` instead. To wire it by hand, add this to `~/.claude/settings.json` (use an absolute node path if `node` is not on the status line's PATH):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/statusline.js\"",
    "refreshInterval": 2
  }
}
```
</details>

## Update

From npm, updating is one command:

```bash
npm install -g ccrig@latest
```

That is the official update path. `ccrig --update` points you to it: it detects an npm install and defers to npm rather than overwriting a file npm manages. Once a day, a background check asks the public repo whether a newer version exists and shows an `⬆ v<new> update` badge in the bar when there is one. **The render itself makes no network calls**; it only reads a small local cache the check writes. The check is throttled to once a day and fails quietly when you are offline or behind a proxy, so a team sharing CCRig hears about new versions instead of drifting behind.

```bash
ccrig --check-update    # check for a newer version right now
ccrig --whatsnew        # what changed in the version you have
ccrig --dismiss-update  # hide the badge for a version you want to skip
```

Turn the check off with `"updateCheck": false` (or `NO_UPDATE_NOTIFIER=1`).

Installed the single file without npm? Then `ccrig --update` does the work itself: it fetches the new file, **validates it** (`node --check` plus a shape check that it really is `statusline.js`), **backs up** yours, and does an **atomic swap**, rolling back untouched on any failure. It refuses to downgrade (pass `--force` to re-apply anyway) and refuses anything that does not look like the real script, so a proxy login page cannot overwrite your file. It honors `HTTPS_PROXY` / `NO_PROXY` and a corporate root CA. For stronger integrity you can pin an Ed25519 key in `updatePubkey`, after which `--update` requires a matching `statusline.js.sig`; see [SECURITY.md](SECURITY.md).

## What the status line shows

- **👤 profile**: the active Claude profile, when you run more than one (see [Multiple Claude accounts](#multiple-claude-accounts)). Hidden if you only have one.
- **⬆ update**: an "update available" badge when a newer version exists (see [Update](#update)). Shown only when there is one to pull.
- **📂 folder**: the current project, as a repo-relative path.
- **★ model**: the model, with a `[1m]` tag on a 1M-context model.
- **⬇ downgrade**: a yellow heads-up if the model tier drops mid-session (Opus → Sonnet), which Claude Code does silently as you near the Opus cap. Shown only when usage is elevated.
- **⚡ effort**: reasoning effort (low through max).
- **flags**: `fast` when Fast mode is on, `no-think` when extended thinking is off.
- **ctx**: a context-window bar. Green under 50%, yellow under 70%, red above.
- **🌿 git**: branch, uncommitted count, unpushed `↑` and unpulled `↓` vs upstream.
- **🤖 agents**: how many subagents are running right now, when you use the Task tool or workflows.
- **💳 billing**: `sub` for a Claude.ai subscription, `api` for pay-per-token. Claude Code sends rate-limit data only to subscribers, which is how this is detected.
- **session / weekly**: 5-hour and 7-day plan-usage bars, each with its reset time (a clock time today, dated when it is days out).
- **⏳ forecast**: a plain-language read on when you will hit the wall, projected from your recent burn rate: `⏳ ~34m to session limit · slow down`, or `⏳ session safe (resets first)` when the window refreshes before you would run out. Shows only once there is enough history to be meaningful. Part of the [Guardian](#the-guardian); off with `"forecast": false`.
- **⚠ near-limit hint**: once session or weekly usage crosses the warn threshold (90% by default), the bar turns bold red and a hint shows that your work is auto-saved and how to pick it back up (`claude --continue`). If another profile still has headroom, it points there too (`⤳ personal free 80%`).
- **resume tickets**: at critical usage (98% by default) it also saves `resume-tickets/<session>.md` in your Claude config dir, holding the project path and the exact `claude --resume <session-id>` command. Claude Code already saves the transcript continuously, so nothing is lost at a limit; the ticket is for days later, after a weekly reset, when `claude --continue` would resume the wrong (a newer) session. Turn off with `"resumeTickets": false`. For hands-free pickup, see [The Guardian](#the-guardian).
- **[CAVEMAN]**: the mode badge for the third-party caveman plugin, shown only if you use that plugin; everyone else never sees it.
- **cost / session name**: session spend and the session's title. Off by default.

## The Guardian

A status line *tells* you the wall is coming. The Guardian snapshots your work, waits out the reset, and puts you back where you were. It is opt-in and reversible, and reads only the JSON and transcript Claude Code already writes. Wire it in one command (this also installs the status line if it is not already):

```bash
ccrig --install-guardian          # checkpoint + notify + keep-working
ccrig --install-guardian --auto   # same, plus hands-free auto-resume
```

Restart Claude Code once so the hooks load. Remove it any time with `ccrig --uninstall-guardian` (the status line stays). It wires three Claude Code hooks (`Stop`, `SessionStart`, `PreCompact`) into your `settings.json`, alongside any hooks you already have.

It has five parts:

**1. Auto-pause and auto-resume.** At critical usage (98%), once you have enabled the guardian, the status line writes a checkpoint: your open and finished todos, your last request, and the git HEAD + dirty state. With `autopilot: "resume"` a small detached watcher then waits for the window to reset (polling the wall clock, so it survives your laptop sleeping and week-long waits) and relaunches the exact session with `claude --resume <id> -p`, handing it the checkpoint so it continues the next step and does not repeat finished work. A `SessionStart` hook does the same restoration if you resume by hand. `autopilot: "notify"` (what `--install-guardian` sets) checkpoints and sends a desktop ping but does not relaunch. The shipped default is `"off"`, so a plain `--install` never checkpoints or spawns a notification. Only the guardian does.

```bash
ccrig --autopilot resume     # full hands-free pickup
ccrig --autopilot notify     # checkpoint + ping only (what --install-guardian sets)
ccrig --autopilot off        # do nothing beyond the resume ticket (shipped default)
```

**2. Relentless mode (keep-working).** A `Stop` hook refuses to let the session pause while todos remain, feeding the open items back so Claude keeps going until the task is actually done. It steps aside the moment Claude asks you a real question, and has loop guards (a hard continue cap and a stall detector) so it never spins on the spot. Off by default:

```bash
ccrig --keep-working on
```

**3. Time-to-limit forecast.** The `⏳` segment described above, projected from your recent burn rate.

**4. Cross-profile failover.** With `"ledger": true` (off by default), each render publishes this profile's usage to a shared ledger. When you are at your limit and another profile still has headroom, the bar points there (`⤳ personal free 80%`); add `autopilotFailover: true` and the watcher continues the work on that profile instead of waiting for the reset. Ledger entries older than six hours are ignored so you are never sent to a stale account.

**5. Compaction-proof checkpoints.** A `PreCompact` hook snapshots your work state before Claude Code compacts the context, and restores it afterward, so a compaction never quietly drops your plan.

`ccrig --doctor` reports which hooks are wired and, in `resume` mode, whether `claude` is reachable on `PATH` for the relaunch. Nothing runs as a hidden daemon: `ccrig --status` lists any armed auto-resume watchers, and `ccrig --disarm` stops them. Every knob (`autopilot`, `keepWorking`, `autopilotBuffer`, `autopilotWeekly`, `autopilotFailover`, `autopilotBypassPermissions`, `forecast`, `ledger`, `claudeBin`) lives in `statusline.config.json`.

The auto-resume relaunch is headless, so it cannot answer a permission prompt. If one blocks it, set `"autopilotBypassPermissions": true` and the relaunch runs in bypass-permissions mode. It is off by default because it is a real "skip permission checks" step; it applies only to the guardian's own unattended relaunch, never your interactive session, and the relaunch prompt still tells the model to favor reversible actions and stop before anything destructive.

**What it can and cannot do, honestly.** Auto-resume needs a Claude.ai Pro/Max plan (Claude Code only sends rate-limit data to subscribers) and a machine that is awake when the window resets. Claude Code gives no way to reach into your open terminal session, so auto-resume launches a *fresh headless* run of the session and reconciles the working tree via the git snapshot. Nothing is lost because the transcript is continuous, and the checkpoint keeps it from redoing finished work. Weekly (7-day) auto-relaunch is off by default (`autopilotWeekly`), because a watcher sleeping for days across reboots is less reliable than the checkpoint + `SessionStart` restore you get on a manual resume. If you are on an API key rather than a subscription, the forecast and auto-resume have no usage data to work from. The rest of the status line is unaffected.

## Running many sessions

If you keep several Claude Code sessions going across worktrees and accounts, two commands help:

```bash
ccrig --board       # every live session at a glance (opt-in)
ccrig --sessions    # recent sessions + the command to resume each
```

- **`--board`**: turn on `"sessionBoard": true` and each session publishes a small state file to a shared dir. `--board` then shows them all in one table: project, model, session/weekly usage, context, running subagents, and whether one is near or at a limit. Stale entries (older than an hour) are pruned. It is off by default because it writes outside your config dir (like the ledger). `--purge` clears it.
- **`--sessions`**: read-only, no opt-in. Lists your recent sessions across **every profile** newest-first, each row labelled with its profile, with the project, size, last request, and the exact command to pick it back up. That command **pins `CLAUDE_CONFIG_DIR` to the profile the session ran under**, so a session started on your personal account resumes on personal even from a shell set to work. On Windows it prints a PowerShell form (`cd '…'; $env:CLAUDE_CONFIG_DIR='…'; claude --resume …`) that pastes straight into PowerShell, the default Windows shell. The resume ticket and the guardian's auto-resume relaunch pin the profile the same way.

And **`"reinjectOnCompact": true`** (or a file path) re-includes your `CLAUDE.md` (or a named rules file) after Claude Code compacts context, in case compaction dropped it. Off by default.

## Customize

Three ways, easiest first.

**From a Claude Code session** (installed by `ccrig init`): CCRig adds native slash commands to the `/` menu, so everything is one keystroke away: `/ccrig` (a hub), `/ccrig:status`, `/ccrig:sessions`, `/ccrig:doctor`, `/ccrig:update`, and `/ccrig:config` (the classic `/statusline-config` still works too). Run `/ccrig:config` to open an interactive menu right in the CLI (pick display mode, toggle a segment, reset style, thresholds, and so on), apply your choice, see a fresh preview, and keep changing things until you are done. You can also just say what you want ("switch to minimal", "turn off billing"). `ccrig --options` prints the option list in a terminal.

**Interactive terminal editor:**

```bash
ccrig --config
```

It shows a live preview, lets you toggle any segment, cycle the mode (`m`), and writes your choices to `statusline.config.json` next to the script.

**By hand:** copy `statusline.config.example.json` to `statusline.config.json` and edit colors, thresholds, segment order, reset style (`clock`, `clock24` for a 24-hour clock, or `relative`), and profile labels. Your config is a separate file, so updating CCRig never wipes it.

## Display modes

Three densities, switchable in one command (applies live in a couple of seconds):

```bash
ccrig --mode minimal    # quiet: profile, folder, model, context, git
ccrig --mode normal     # the default set of segments
ccrig --mode expanded   # everything with data, including cost and session name
```

The near-limit warning always shows through, even in minimal mode. In the `--config` editor, press `m` to cycle modes with a live preview. `normal` respects your per-segment toggles; `minimal` and `expanded` override them.

## Multiple Claude accounts

A profile is an isolated `CLAUDE_CONFIG_DIR` with its own login, settings, and history. The default profile is `~/.claude`, and a named profile lives in `~/.claude-<name>`. The npm install ships the switcher, so source it from your shell:

```bash
# in ~/.zshrc or ~/.bashrc
source "$(npm root -g)/ccrig/claude-profiles.sh"
```

The profile switcher is a bash/zsh helper. On Windows, set the profile yourself in PowerShell with `$env:CLAUDE_CONFIG_DIR = "$HOME\.claude-work"` before running `claude`.

Then:

```bash
claude-profile new work         # create a profile
claude-profile use work         # switch this shell to it, then run `claude`
claude-profile run work         # or launch claude with it in one shot
claude-profile list             # list profiles (* = current)
claude-profile current          # show the active one
claude-profile remove work      # delete a profile (asks first; won't touch the default)
```

The status line's `👤` badge shows which profile is active, so you always know which account you are in.

## Staying responsive

Claude Code refreshes the status line after each message (debounced at 300ms) and, since Claude Code 2.1.97, `refreshInterval` re-runs it on a timer too (see the [status line docs](https://code.claude.com/docs/en/statusline)). The installer sets `refreshInterval: 2`, so time-based segments like reset countdowns stay current even while a session is idle; on an older Claude Code the key is ignored harmlessly. Git state is cached briefly (`gitCacheMs`, default 10000ms) so a large repository does not re-shell `git status` on every render; branch and dirty state can lag by up to about that long, which is invisible in normal use and one config line to change.

## Credit

The idea came from Hannah Stulberg's guide **"Claude Code for Everything: Your Status Line Is Empty (Let's Fix That)"**: https://hannahstulberg.substack.com/p/claude-code-for-everything-your-status-line-is-empty. The command-center concept, the context-bar thresholds, the folder / model / git / usage segments, and the portable Node-script approach come from there. A comment on that article (by AstroHan) noted that the plan-usage numbers are already in the status line's stdin, which is what let this version drop the API call.

### What's different from the article

- **No render-time network.** The article reads plan usage from the `/api/oauth/usage` endpoint with a keychain token. This reads `rate_limits`, `context_window`, `effort`, and the mode flags from the stdin Claude Code already sends. No token, no keychain, no rate-limit calls, always fresh. (The only network anywhere is the optional once-a-day update check, which runs in the background and is off with one flag.)
- Line-wrapping that tracks a live terminal resize, and a brief git cache for large repos.
- Extra segments: active profile, reasoning effort, fast / no-think flags, unpushed / unpulled commits, billing path, and date-aware reset times.
- External config with an interactive editor, so nothing is hardcoded and updates do not clobber your settings.
- A companion profile switcher for running multiple Claude accounts.

## Contributing

Contributions are welcome and anyone can send one. See [CONTRIBUTING.md](CONTRIBUTING.md). Every change lands through a merge request that a maintainer approves. Changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## License

MIT © Jordan Allen Lewis. [jordanallenlewis.com](https://jordanallenlewis.com)
