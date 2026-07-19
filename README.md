# Rig

**Your Claude Code rig.** The operational layer that makes [Claude Code](https://claude.com/claude-code) pleasant to run all day: a live command bar, an opt-in guardian that picks your work back up after a usage limit, and more as it grows.

The pieces so far:

1. **A status line** that turns the bar at the bottom of your terminal into a command center: active profile, model, reasoning effort, context-window usage, git state, billing path, and your plan's rate-limit windows.
2. **The Guardian** (opt-in): the part that *acts* on your limits instead of just showing them. It keeps the session working while there's work left, and when you do hit a limit it snapshots your exact work state and can pick the session back up automatically the moment the window resets. It carries on at the next step instead of redoing finished work. See [The Guardian](#the-guardian).
3. **A cross-session board and resume-picker** (`--board`, `--sessions`) for keeping track of many sessions across worktrees and accounts, plus **a profile switcher** for running multiple Claude accounts side by side.

Everything the status line shows is read from the JSON Claude Code already hands it on stdin, so **the render makes no network calls**. No API token, no keychain reads, nothing leaves your machine. The one exception is an optional once-a-day update check that runs in the background (a single request to the public repo so you learn about new versions; off with `"updateCheck": false`). It's a single Node file with zero dependencies (Node ships with Claude Code), and your settings live in a separate config file so updates never overwrite them.

```
👤 work │ 📂 my-project │ ★ Opus 4.8 [1m] │ ⚡high │ ctx ████░░░░░░ 42% │ 🌿 main ●3 ↑1 │ 💳 sub
session █████░░░ 63% ↺8:53a │ weekly ███████░ 88% ↺7/22 6:53a
```

The bars are color-coded (green, then yellow, then red) and the line wraps to your terminal width. And when a limit is coming (this is where Rig earns its spot), it forecasts the wall and, if you've enabled the guardian, checkpoints your work and arms the pickup:

```
👤 work │ 📂 my-project │ ★ Opus 4.8 [1m] │ ⚡high │ ctx ██████░░░░ 61% │ 🌿 main ●2
session ████████░ 96% ↺2h14m │ weekly ██████░░ 71% ↺7/22 │ ⏳ ~9m to session limit · slow down │ ⚠ limit imminent: checkpoint saved, autopilot armed
```

Once you have the file (download or clone below), you can preview it with sample data before wiring anything: `node statusline.js --demo` (add `--cols 80` to size it for a screenshot). `node statusline.js --selftest` sanity-checks rendering on edge inputs, and `node statusline.js --version` prints the version.

> If it earns a spot in your terminal, please **star the project** on GitLab. It is free and it is the whole ask, and a star is how the next person finds it.

## Install

One line on macOS / Linux:

```bash
mkdir -p ~/.claude && curl -fsSL https://gitlab.com/jordanallenlewis/ccrig/-/raw/main/statusline.js -o ~/.claude/statusline.js && node ~/.claude/statusline.js --install
```

One line on Windows (PowerShell):

```powershell
mkdir -Force $HOME\.claude | Out-Null; iwr https://gitlab.com/jordanallenlewis/ccrig/-/raw/main/statusline.js -OutFile $HOME\.claude\statusline.js; node $HOME\.claude\statusline.js --install
```

The installer wires every Claude profile on your machine (your `~/.claude` and any `~/.claude-<name>`), backs up each `settings.json` first, and prints which profiles it touched. Run more than one account and they all get the bar in one shot. Want just the active profile? Add `--this-profile`. It uses the exact node binary it was run with and is safe to re-run. If `node` isn't on your PATH, run the same commands with an absolute path to any Node 18+ binary. Restart Claude Code once. After that, edits apply live. Run `node statusline.js --help` for the full flag list.

Prefer a clone? It keeps you on `git pull` updates and includes the profile switcher:

```bash
git clone https://gitlab.com/jordanallenlewis/ccrig.git
cd ccrig
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

If anything looks wrong, `node statusline.js --doctor` diagnoses the usual suspects (unwired settings, a node path broken by a version manager upgrade, invalid config).

**Backing out** is clean and total: `--uninstall` removes the status line (and any guardian hooks) across every profile, `--uninstall-guardian` removes just the guardian, and `--purge` deletes the local state it wrote for the active profile (checkpoints, resume tickets, watcher files, the update cache, this profile's ledger entry, the shared session board, temp caches, and the render error log). Your `statusline.config.json`, the settings backups, and the script itself stay in place; delete them by hand if you want. Every settings write is backed up first, and nothing it touches lives outside your home dir.

## What the status line shows

- **👤 profile**: the active Claude profile, when you run more than one (see below). Hidden if you only have one.
- **⬆ update**: an "update available" badge when a newer version exists (see [Staying up to date](#staying-up-to-date)). Shown only when there's one to pull.
- **📂 folder**: the current project, as a repo-relative path.
- **★ model**: the model, with a `[1m]` tag on a 1M-context model.
- **⬇ downgrade**: a yellow heads-up if the model tier drops mid-session (Opus → Sonnet), which Claude Code does silently as you near the Opus cap. Shown only when usage is elevated.
- **⚡ effort**: reasoning effort (low through max).
- **flags**: `fast` when Fast mode is on, `no-think` when extended thinking is off.
- **ctx**: a context-window bar. Green under 50%, yellow under 70%, red above.
- **🌿 git**: branch, uncommitted count, unpushed `↑` and unpulled `↓` vs upstream.
- **🤖 agents**: how many subagents are running right now, when you use the Task tool or workflows.
- **💳 billing**: `sub` for a Claude.ai subscription, `api` for pay-per-token. Claude Code sends rate-limit data only to subscribers, which is how this is detected.
- **session / weekly**: 5-hour and 7-day plan-usage bars, each with its reset time (a clock time today, dated when it's days out).
- **⏳ forecast**: a plain-language read on when you'll hit the wall, projected from your recent burn rate: `⏳ ~34m to session limit · slow down`, or `⏳ session safe (resets first)` when the window refreshes before you'd run out. Shows only once there's enough history to be meaningful. Part of the [Guardian](#the-guardian); off with `"forecast": false`.
- **⚠ near-limit hint**: once session or weekly usage crosses the warn threshold (90% by default), the bar turns bold red and a hint shows that your work is auto-saved and how to pick it back up (`claude --continue`). If another profile still has headroom, it points there too (`⤳ personal free 80%`).
- **resume tickets**: at critical usage (98% by default) it also saves `resume-tickets/<session>.md` in your Claude config dir, holding the project path and the exact `claude --resume <session-id>` command. Claude Code already saves the transcript continuously, so nothing is lost at a limit; the ticket is for days later, after a weekly reset, when `claude --continue` would resume the wrong (a newer) session. Turn off with `"resumeTickets": false`. For hands-free pickup, see [The Guardian](#the-guardian).
- **[CAVEMAN]**: the mode badge for the third-party caveman plugin, shown only if you use that plugin; everyone else never sees it.
- **cost / session name**: session spend and the session's title. Off by default.

## The Guardian

A status line *tells* you the wall is coming. The Guardian snapshots your work, waits out the reset, and puts you back where you were. It's opt-in and reversible, and reads only the JSON and transcript Claude Code already writes. Wire it in one command (this also installs the status line if it isn't already):

```bash
node statusline.js --install-guardian          # checkpoint + notify + keep-working
node statusline.js --install-guardian --auto    # same, plus hands-free auto-resume
```

Restart Claude Code once so the hooks load. Remove it any time with `node statusline.js --uninstall-guardian` (the status line stays). It wires three Claude Code hooks (`Stop`, `SessionStart`, `PreCompact`) into your `settings.json`, alongside any hooks you already have.

It has five parts:

**1. Auto-pause and auto-resume.** At critical usage (98%), once you've enabled the guardian, the status line writes a checkpoint: your open and finished todos, your last request, and the git HEAD + dirty state. With `autopilot: "resume"` a small detached watcher then waits for the window to reset (polling the wall clock, so it survives your laptop sleeping and week-long waits) and relaunches the exact session with `claude --resume <id> -p`, handing it the checkpoint so it continues the next step and does not repeat finished work. A `SessionStart` hook does the same restoration if you resume by hand. `autopilot: "notify"` (what `--install-guardian` sets) checkpoints and sends a desktop ping but does not relaunch. The shipped default is `"off"`, so a plain `--install` never checkpoints or spawns a notification. Only the guardian does.

```
node statusline.js --autopilot resume     # full hands-free pickup
node statusline.js --autopilot notify     # checkpoint + ping only (what --install-guardian sets)
node statusline.js --autopilot off        # do nothing beyond the resume ticket (shipped default)
```

**2. Relentless mode (keep-working).** A `Stop` hook refuses to let the session pause while todos remain, feeding the open items back so Claude keeps going until the task is actually done. It steps aside the moment Claude asks you a real question, and has loop guards (a hard continue cap and a stall detector) so it never spins on the spot. Off by default:

```
node statusline.js --keep-working on
```

**3. Time-to-limit forecast.** The `⏳` segment described above, projected from your recent burn rate.

**4. Cross-profile failover.** With `"ledger": true` (off by default), each render publishes this profile's usage to a shared ledger. When you're at your limit and another profile still has headroom, the bar points there (`⤳ personal free 80%`); add `autopilotFailover: true` and the watcher continues the work on that profile instead of waiting for the reset. Ledger entries older than six hours are ignored so you're never sent to a stale account.

**5. Compaction-proof checkpoints.** A `PreCompact` hook snapshots your work state before Claude Code compacts the context, and restores it afterward, so a compaction never quietly drops your plan.

`node statusline.js --doctor` reports which hooks are wired and, in `resume` mode, whether `claude` is reachable on `PATH` for the relaunch. Nothing runs as a hidden daemon: `node statusline.js --status` lists any armed auto-resume watchers, and `node statusline.js --disarm` stops them. Every knob (`autopilot`, `keepWorking`, `autopilotBuffer`, `autopilotWeekly`, `autopilotFailover`, `autopilotBypassPermissions`, `forecast`, `ledger`, `claudeBin`) lives in `statusline.config.json`.

The auto-resume relaunch is headless, so it cannot answer a permission prompt. If one blocks it, set `"autopilotBypassPermissions": true` and the relaunch runs in bypass-permissions mode. It is off by default because it is a real "skip permission checks" step; it applies only to the guardian's own unattended relaunch, never your interactive session, and the relaunch prompt still tells the model to favor reversible actions and stop before anything destructive.

**What it can and can't do, honestly.** Auto-resume needs a Claude.ai Pro/Max plan (Claude Code only sends rate-limit data to subscribers) and a machine that's awake when the window resets. Claude Code gives no way to reach into your open terminal session, so auto-resume launches a *fresh headless* run of the session and reconciles the working tree via the git snapshot. Nothing is lost because the transcript is continuous, and the checkpoint keeps it from redoing finished work. Weekly (7-day) auto-relaunch is off by default (`autopilotWeekly`), because a watcher sleeping for days across reboots is less reliable than the checkpoint + `SessionStart` restore you get on a manual resume. If you're on an API key rather than a subscription, the forecast and auto-resume have no usage data to work from. The rest of the status line is unaffected.

## Staying up to date

Once a day, a tiny background check asks the public repo whether a newer `statusline.js` exists and, if so, shows an `⬆ v<new> update` badge in the bar. **The status-line render itself makes no network calls**. It only reads a small local cache (`$CLAUDE_CONFIG_DIR/.ccbsl-update.json`) that the background check writes. The check is throttled to once every 24 hours and fails silently when you're offline or behind a proxy. So if you share this with your team, they find out about new features instead of silently drifting behind.

```bash
node statusline.js --update          # pull the newest version
node statusline.js --check-update    # check right now
node statusline.js --whatsnew        # what changed in the version you have
node statusline.js --dismiss-update  # silence the badge for a version you want to skip
```

`--update` does a `git pull` if you cloned, or for a downloaded copy it fetches the new file, **validates it** (`node --check` plus a shape check that it really is `statusline.js`), **backs up** your current file, and does an **atomic swap**, rolling back untouched if anything fails. It refuses to downgrade (unless you pass `--force`) and refuses anything that doesn't look like the real script (so a proxy login page can't overwrite your file). It honors `HTTPS_PROXY` / `NO_PROXY` and a corporate root CA. Turn the whole thing off with `"updateCheck": false` (or `NO_UPDATE_NOTIFIER=1`).

Trust note: by default, over-the-wire integrity rests on HTTPS/TLS to GitLab, which is why `--update` validates and backs up before it ever swaps, and never runs anything without you asking. For a stronger guarantee you can pin an Ed25519 public key in `updatePubkey` (see `statusline.config.example.json`); once pinned, `--update` refuses any download without a matching `statusline.js.sig` signature. See [SECURITY.md](SECURITY.md) for the signing commands.

## Running many sessions

If you keep several Claude Code sessions going across worktrees and accounts, two commands help:

```bash
node statusline.js --board       # every live session at a glance (opt-in)
node statusline.js --sessions    # recent sessions + the command to resume each
```

- **`--board`**: turn on `"sessionBoard": true` and each session publishes a small state file to a shared dir. `--board` then shows them all in one table: project, model, session/weekly usage, context, running subagents, and whether one is near or at a limit. Stale entries (older than an hour) are pruned. It's off by default because it writes outside your config dir (like the ledger). `--purge` clears it.
- **`--sessions`**: read-only, no opt-in. Lists your recent sessions newest-first with the project, size, last request, and the exact `cd … && claude --resume <id>` to pick one back up. It prints a `cd /d "…"` form on Windows; in PowerShell 5.1 (where `&&` is not a separator) run the `cd` and `claude --resume` parts as two commands.

And **`"reinjectOnCompact": true`** (or a file path) re-includes your `CLAUDE.md` (or a named rules file) after Claude Code compacts context, in case compaction dropped it. Off by default.

## Customize

Three ways, easiest first.

**From a Claude Code session** (installed by `--install`): run `/statusline-config`. It opens an interactive menu right in the CLI (pick display mode, toggle a segment, reset style, thresholds, and so on), applies your choice, shows a fresh preview, and asks if you want to change anything else. You can also just say what you want ("switch to minimal", "turn off billing"). `node statusline.js --options` prints the option list in a terminal.

**Interactive terminal editor:**

```bash
node statusline.js --config
```

It shows a live preview, lets you toggle any segment, cycle the mode (`m`), and writes your choices to `statusline.config.json` next to the script.

**By hand:** copy `statusline.config.example.json` to `statusline.config.json` and edit colors, thresholds, segment order, reset style (`clock`, `clock24` for a 24-hour clock, or `relative`), and profile labels. Your config is a separate file, so updating `statusline.js` never wipes it.

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
source /path/to/ccrig/claude-profiles.sh
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

The status line's `👤` badge shows which profile is active, so you always know which account you're in.

## Staying responsive

Claude Code refreshes the status line after each message (debounced at 300ms) and, since Claude Code 2.1.97, `refreshInterval` re-runs it on a timer too (see the [status line docs](https://code.claude.com/docs/en/statusline)). The installer sets `refreshInterval: 2`, so time-based segments like reset countdowns stay current even while a session is idle; on an older Claude Code the key is ignored harmlessly. Git state is cached briefly (`gitCacheMs`, default 10000ms) so a large repository doesn't re-shell `git status` on every render; branch and dirty state can lag by up to about that long, which is invisible in normal use and one config line to change.

## Credit

The idea came from Hannah Stulberg's guide **"Claude Code for Everything: Your Status Line Is Empty (Let's Fix That)"**: https://hannahstulberg.substack.com/p/claude-code-for-everything-your-status-line-is-empty. The command-center concept, the context-bar thresholds, the folder / model / git / usage segments, and the portable Node-script approach come from there. A comment on that article (by AstroHan) noted that the plan-usage numbers are already in the status line's stdin, which is what let this version drop the API call.

### What's different from the article

- **No render-time network.** The article reads plan usage from the `/api/oauth/usage` endpoint with a keychain token. This reads `rate_limits`, `context_window`, `effort`, and the mode flags from the stdin Claude Code already sends. No token, no keychain, no rate-limit calls, always fresh. (The only network anywhere is the optional once-a-day update check, which runs in the background and is off with one flag.)
- Line-wrapping that tracks a live terminal resize, and a brief git cache for large repos.
- Extra segments: active profile, reasoning effort, fast / no-think flags, unpushed / unpulled commits, billing path, and date-aware reset times.
- External config with an interactive editor, so nothing is hardcoded and updates don't clobber your settings.
- A companion profile switcher for running multiple Claude accounts.

## Contributing

Contributions are welcome and anyone can send one. See [CONTRIBUTING.md](CONTRIBUTING.md). Every change lands through a merge request that a maintainer approves. Changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## License

MIT © Jordan Allen Lewis. [jordanallenlewis.com](https://jordanallenlewis.com)
