# Changelog

All notable changes to **CCRig** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Versioning policy:** `MAJOR.MINOR.PATCH`. **MAJOR** for a breaking change to the
install, config, or documented behavior; **MINOR** for a backward-compatible feature;
**PATCH** for a backward-compatible fix. Every entry below is a real, tagged release.
In-progress work lives under `[Unreleased]` until it's cut.

## [Unreleased]

### Changed
- **Fewer processes per prompt and per turn.** A default install now wires three hooks (Stop, SessionStart, PreCompact) instead of seven. The session board's lamp hooks (UserPromptSubmit, Notification, SessionEnd and a second Stop hook) are wired only while the board is on, and the guardian's Stop hook stamps the done lamp itself, so a prompt starts no CCRig process (it started one, about 40ms of Node startup before Claude saw the prompt) and a turn ends with one instead of two. On Windows a bar-only install keeps a single Stop hook, because that is what notices a broken Git Bash. An `npm update` or `ccrig init` takes the idle lamp hooks out of an older install, and `ccrig --doctor` points them out.
- **The bar redraws every 5 seconds between messages instead of every 2** (`refreshInterval`; Claude Code still redraws it on every message). An idle session starts Node, and on Windows Git Bash, 60% less often. `ccrig init` or an npm update moves an existing install to 5.
- **The refined bar says the same with less.** A window at the warn line no longer gets a line of its own: its meter already reads `▲ session ━━━━━━━━━─ 92%`, and now ends in `· saved` once the guardian has checkpointed. The line comes back at critical, where it names the resume command. `api` shows in the plain text color with a `billing` label (an API key is worth knowing about, not a hazard), and `sub` only with `"billing": "always"`. The update badge is one colored `↑` on a dim line, and `caveman` and `no-think` are dim lowercase labels like the rest. `minimal` mode keeps the plan budget as numbers (`5h 63%`, `7d 21%`) instead of dropping it, on one short line with no bars. Below 100 columns the meters start compact, so making a terminal narrower never makes their labels longer. The classic look is unchanged.
- `"rule": false` now puts a `▾` at the start of the first line, tinted amber or red near a limit like the rule it replaces, so the section still reads as one you can fold. The rule stays on by default.
- Near a limit, the checkpoint refreshed every 10 seconds no longer starts git twice: it reads HEAD from the files under `.git` (packed refs and worktrees included) and takes "dirty" from the git segment's cache, which that same render just wrote. Git still runs when those cannot answer (a repository with no commits yet, `GIT_DIR`, a reftable repository).

### Fixed
- The bar honors `NO_COLOR`: no color codes at all (bold stays), in both looks. `--board` already did.

### Added
- `ccrig board on` / `ccrig board off` (or `b` in `--config`, then save) turns the session board on or off and wires or removes its lamp hooks in every profile CCRig is installed in. Restart Claude Code once afterward.

### Performance
- **A render does less.** Measured on Windows with Node 24, warm caches, two profiles: about 4ms off every render (p50 60.4ms to 56.1ms), and 21 file system calls instead of 28. A render no longer loads Node's process and terminal modules unless it actually starts git or prints to a terminal (that alone was about 3ms), and it writes its line with one plain write. The running-subagents count is worked out once per render instead of twice, and during a turn it reads only what was appended to the transcript since the last render instead of the last 768KB again (a test pins it under 4KB for a one-line append). The burn-rate samples are read once instead of three times, `settings.json` is read only when a model drop is actually seen, and the profile count behind the profile badge is kept for a minute instead of listing your home folder on every render.

## [1.9.0] - 2026-10-02

### Changed
- **A refined default look.** A full-width rule line now sits above the bar, so it reads apart from the conversation above it; it turns amber near a limit and red at critical. Text labels replace the emoji icons, the meters are thin `━──` lines at half-cell resolution, plain values use the terminal's own text color, and color is kept for state (green, amber, red), so the bar is legible on light terminals too. A reset later in the week reads as a weekday (`Tue 6:53a`). The old look is one setting away: `"style": "classic"`, `CCRIG_STYLE=classic` for one terminal, or `y` in `--config`. A saved color that only repeats an old default yields to the new palette; a color you chose is kept.
- **The bar fits any width.** Segments come in groups (who and where, the meters, the limit alert) and a group stays on one line when it can, so `weekly` is no longer stranded on a line of its own. On a narrow terminal the meters shorten to `5h` / `7d` together (never one full meter beside a shrunken one), then drop their bars; the forecast, the downgrade alert and the limit warning shorten too, and anything still too wide ends in `…` instead of running past the edge.

### Added
- **Collapse and expand the CCRig section.** `/ccrig:toggle` inside a session (or `ccrig collapse` / `ccrig expand` / `ccrig toggle` in a shell, `c` in `--config`, `/ccrig collapse` in the mod) folds the bar to a single line: `▸ ccrig  my-project · Opus 4.8 · ctx 42% · 5h 63% · 7d 21%`. The rule above the open section reads `▾ ccrig`. Folded, a window near its limit keeps its `▲`, and at critical the limit warning still gets its own line. The choice is saved, like `--mode`.

### Fixed
- A usage window at 99.6% read "100%" while its bar was not full; it now reads 99% until the window is truly full, and a sliver of use reads `<1%` with a visible sliver instead of an empty bar.
- A window whose reset had already passed still drew its stale bar (often a red 100%); it now reads `session ↺ reset` until fresh numbers arrive.
- A usage percentage outside 0 to 100 (or not a number) drew an out-of-range bar such as 250%; it is now clamped or dropped. A reset time sent in milliseconds is read correctly, and a non-numeric cost or line count no longer prints `NaN`.
- A session name in CJK or emoji is now shortened by terminal cells, not characters.
- Saving from `--config` while a style override was active no longer froze that style's whole palette into the config file.

## [1.8.1] - 2026-10-01

### Fixed
- **Windows: a broken Git Bash no longer piles up stuck `bash.exe` processes.** Claude Code runs every
  status line through Git Bash on Windows, so when Git Bash's runtime hangs on startup, each refresh left
  another stuck shell (and the next one started more). CCRig now notices that the bar has stopped
  drawing, tries Git Bash in the background, and if it hangs, takes its status line out of
  `settings.json`, ends the stuck shells that were running it, and says so once in the session and with
  a desktop notification. The bar comes back by itself once Git Bash starts again. It only ever ends a
  shell whose command line ends with the exact command CCRig wired, and never touches another tool's
  status line.
- **Windows: the hooks no longer use Git Bash.** With Claude Code 2.1.139 or newer, the hooks start
  `node.exe` directly (exec form, `args`), so a broken Git Bash cannot stall every prompt and stop. An
  install wired the older way moves over the first time the status line sees a new enough Claude Code;
  older Claude Code keeps the shell form.
- `ccrig --doctor` on Windows times Git Bash, ends stuck CCRig shells, reports a paused bar and puts it
  back when Git Bash works again, and says when the hooks still run through Git Bash.

## [1.8.0] - 2026-10-01

### Added
- **CCRig as a Claude Code mod.** The repo is now also a plugin marketplace: `/plugin marketplace add
  jordanallenlewis/ccrig`, then `/plugin install ccrig@ccrig`, in the CLI or the Desktop app (Claude Code
  2.1.287+). The mod draws the bar in the band above the prompt, shows the usage window to watch beside
  the spinner, raises a toast when a window crosses the warn or critical line (Claude Code pushes the
  figures, so nothing polls), and adds `/ccrig`, which answers at once, even mid-turn, with no Claude
  turn: a summary, a usage pane with the pace forecast, the session board, and the `mode`, `autopilot`,
  `keep-working`, `status`, `sessions` and `doctor` commands.
- The mod runs the guardian's hooks itself (checkpoints, resume tickets, keep-working, board lamps), so a
  plugin install edits no `settings.json`. When `ccrig init` already wired the status line or the hooks,
  the mod leaves those to it: the band shows only limit alerts and no hook runs twice.
- Without Node on the PATH, and in the Desktop app, the band falls back to a native line built from
  Claude Code's own figures (model, context, usage windows, cost).
- `/config` gains three ccrig rows: the band (`auto`, `always`, `alerts`, `off`), the spinner readout and
  the toasts. A change applies at once.
- **Resume in place.** With `"autopilot": "resume"` and the mod drawing the bar, an open session past its
  critical line continues on its own at the reset, in the same terminal, through CCRig's own resume prompt
  (`--hook mod-resume` decides, with the watcher's rules). Close the terminal first and `--hook mod-exit`
  arms the detached watcher as before.
- `--doctor`, `init` and `--uninstall` know the mod: doctor shows when it last ran (from
  `~/.ccrig/mod.json`, which its renders write) and stops flagging a missing status line it draws for
  you; `init` skips the markdown `/ccrig` commands the mod replaces; `--uninstall` names
  `/plugin uninstall ccrig@ccrig`. The mod hides those markdown `/ccrig:*` commands from the menu.

### Changed
- A mod-host render acts (checkpoints, tickets, pings) only in an interactive terminal or Desktop session
  (`CCRIG_INTERACTIVE=1`). A `claude -p` or SDK run, including the guardian's own `--resume -p`
  relaunch, gets the hooks and nothing else.
- The mod's copy of `statusline.js` never updates itself: the badge, `--check-update` and `--doctor` point
  at `/plugin update ccrig@ccrig`, `--update` refuses, `autoUpdate` does nothing there, and `init` refuses
  to wire a plugin-cache copy into `settings.json`.
- The marketplace installs the release tag (`ref: vX.Y.Z`), never whatever is on `main`.
- The mod runs each guardian hook only when `settings.json` does not already run it, by slug, and only
  when CCRig's config asks for it (`autopilot` off means no checkpoints from Stop or PreCompact).
- `/ccrig` passes only the arguments each command takes; nothing typed after it can become a CLI flag.
- The mod follows `/clear`, `/resume` and `/branch` to the new session, runs the board's session-end
  cleanup before Claude Code exits, renders once a minute between turns, tries the node your wired status
  line names first, and stops retrying in the Desktop app after one failed start.
- The mod reads CCRig's decisions (thresholds, autopilot, keep-working, board, forecast, update) from a
  `state` block statusline.js prints beside the segments, instead of recomputing them.
- Run under the mod (`CCRIG_HOST=mod`), `statusline.js` prints its segments as JSON for the mod to lay
  out, and keeps its config in `~/.ccrig/` like an npm install, since `/plugin` replaces the plugin
  directory on every update. `CCRIG_PURE=1` renders with no side effects, for a band drawn beside a
  wired status line.
- `npm test` names its three suites, because a bare `node --test` on Node 22+ also collects the mod's
  `tests/*.test.ts`, which need Claude Code's test kit (`claude plugin test`). CI runs both.

## [1.7.0] - 2026-09-25

### Added
- **Traffic-light session board.** `--board` now shows a lamp per session instead of a single
  "active" string: red for a session waiting on you, yellow for working, green for just finished,
  grey for gone quiet, with red sorted to the top. The states come from three new hooks
  (`UserPromptSubmit`, `Notification`, `SessionEnd`) that write one small file per session, so
  nothing new runs on the per-tool-call path. Green fades to grey after 30 minutes
  (`"boardDecayMinutes"`).
- **`--board --watch`**: an in-place redraw that keeps the board current, plus a desktop ping the
  moment a session starts waiting on a human (`"boardNotify": false` to silence it). It runs in the
  foreground and writes no pid file, so it is never a hidden daemon and `--status` / `--disarm`
  never mistake it for an auto-resume watcher.
- **Session labels on the board.** `/ccrig:name` writes `.claude/ccrig-name` for a project, and
  `CCRIG_SESSION_NAME` labels a single shell's session. Claude Code's own session name and the
  folder name are the fallbacks.

### Changed
- The lamp hooks are installed with the status line, so `--no-guardian` installs and `npm update`
  keep them, and `--uninstall-guardian` leaves them alone. `--uninstall` removes them.
- `--doctor` reports whether the board is on, how many records it holds, and whether the lamp hooks
  are wired. `--options` and `--config` expose the board, its decay window, and its ping.
- The update check reads the npm registry's latest release instead of the GitHub `main` branch, so npm
  users are never told about a version npm cannot install yet, and a standalone `--update` downloads
  that release's tagged file instead of whatever is on `main`.
- **`"autoUpdate": true`** (opt-in) installs a newer release from the background daily check: npm installs
  through `npm install -g ccrig@<version>` into their own prefix (never with sudo), standalone copies
  through the usual validated swap.

### Fixed
- **Windows without Git Bash:** Claude Code runs commands through PowerShell there, which read the
  installed `"node.exe" "statusline.js"` as a string, so the bar and every hook did nothing. The first
  token is now never quoted on Windows (forward slashes; plain `node` when the path has a space).
- **`npm update` wiped your settings:** an npm install now keeps `statusline.config.json` in
  `~/.ccrig/`, outside the package directory npm replaces. Settings saved by an earlier npm install were
  already lost on each update, so set them once more.
- `npx ccrig --demo` no longer installs anything, and postinstall no longer wires a project dependency or
  runs as root under `sudo npm install -g` (which left a root-owned `~/.claude`).
- A command node path survives `brew upgrade node`: the node on PATH is used when it is the same binary.
- On Windows the git segment no longer runs a `git.exe` / `git.bat` shipped inside a cloned repo (git is
  found on PATH directly, never through a shell or the project directory).
- A `settings.json` or `statusline.config.json` saved with a UTF-8 BOM is read instead of rejected, and a
  config that does not parse is never overwritten by `--mode` / `--autopilot` / `--config`.
- Auto-resume on Windows with `claudeBin` pointing at npm's `claude.cmd`: the current shim form is resolved,
  and there is no `cmd.exe` fallback that split paths at spaces and cut the prompt at its first newline.
- An armed auto-resume watcher now stands down after `--autopilot off` / `notify`, and `--uninstall` /
  `--uninstall-guardian` stop it instead of leaving it to relaunch Claude at the reset.
- Board: the green "done" lamp now lights on `--no-guardian` installs (the board has its own Stop hook),
  an interrupted turn settles through `idle_prompt`, a prompt sent right after a Stop still shows yellow,
  and the session-end sweep no longer deletes the lamp of a session that has waited over an hour.
- PowerShell `claude-profile new` created nothing (`New-Item` has no `-LiteralPath`), and `claude-profile
  run <name> <one arg>` split that argument into characters.
- `claude-profile use default` / `run default` now unset `CLAUDE_CONFIG_DIR` instead of setting it to
  `~/.claude`, which Claude Code treats as a separate login.
- The README now says to run `ccrig --uninstall` before `npm uninstall -g ccrig`.
- **Board:** a live session not prompted yet shows grey `ready` instead of yellow; an MCP URL dialog
  lights red; the board ping on Linux survives a label starting with `-`; `--board --watch` redraws
  cleanly in a short terminal and gives the cursor back on Ctrl+Z; `/ccrig:name` finds its label from a
  subdirectory, reads a UTF-16 label file, and saves through the new `--name <label>` (no protected-folder
  prompt); `--config` gains the board-ping toggle; BMP emoji such as ✅ count as two cells.
- **Updates:** an `https://` proxy is spoken to over TLS (its password never crosses in clear); a tunneled
  request sends the right Host port; a response with no length framing is refused; a download must pass
  its own `--selftest` before the swap; the swap keeps the exec bit, re-wires new hooks and slash commands
  in every profile, and `--whatsnew` then shows the new notes; a typed `--update` / `--check-update` trusts
  the OS certificate store like the background check. SECURITY.md no longer suggests pinning a signing
  key the official releases do not use yet.
- **Guardian:** a watcher killed by a reboot is re-armed while the reset is still ahead; stopping a watcher
  also stops the claude it launched; `--status` / `--disarm` cover every profile; Linux without `ps` reads
  `/proc`; the resume prompt's "original request" skips task notifications and slash-command output; a
  compaction near a limit is no longer told it hit one (and keeps the limit checkpoint); "auto-saved"
  shows only when something is saved; `opusplan` never reads as a downgrade; a `HOME` ending in `/` no
  longer disables failover; todos from the newer `TaskCreate` / `TaskUpdate` tools are read too.
- **Install and CLI:** an npm update re-points an existing guardian at the new copy (never adds or drops
  one); a typed `--no-guardian` really leaves just the bar; `init` reports the real autopilot mode;
  `--uninstall-guardian --this-profile` leaves the shared config alone while another profile has the
  guardian; a settings.json that cannot be read or parsed is reported (exit 1) instead of "nothing to
  remove"; config commands exit 1 when the save fails; custom keep-working limits survive
  `--keep-working on`; pnpm installs point at the stable global path and every "how to update" line names
  the right package manager; flag typos stop the command before it runs, and `status`, `mode`, `purge`
  and friends work as bare commands; our own path is recognised case-insensitively on Windows and macOS,
  and a foreign `node ~/.claude/statusline.js` bar is never removed as ours; one profile spelled two ways
  is set up once; `--doctor` flags `disableAllHooks`, checks the auto-resume target the way the relaunch
  does (an absolute `claudeBin` passes), and suggests a repair that does not switch keep-working on;
  `--options` lists every setting; slash-command hints render as text; one profile-naming rule everywhere.
- **Render and privacy:** dir, model, effort and session names are stripped of terminal escapes; long branch
  names are cut to fit; a slow repo keeps its last known git state instead of the segment vanishing; the
  `[1m]` tag and the context fallback use the session's own window size, and effort no longer falls back
  to settings on a model without it; a `critical` threshold below `warn` still fires; the tmp caches move to
  a private per-user folder, guardian state is written owner-only, and rewriting settings.json keeps its
  mode and a dotfiles symlink; a status JSON that arrives late no longer renders as an empty bar.
- **Shell helpers:** the bash/zsh switcher enforces its advertised name charset, both helpers refuse a
  trailing dot and ccrig's own dirs, bash/zsh list symlinked profiles, handle a trailing slash and
  `set -u`, PowerShell `remove` no longer follows a junction out of the profile, `new` says to run
  `ccrig init` after the first login, and `install.sh` works through a symlink and under plain `sh`.
- **Docs and CI:** a Windows PowerShell standalone install and exact switcher lines in the README; the
  standalone download comes from the latest release and never overwrites your own statusline.js; the
  guardian's thresholds, background process and opt-in failover described as they are; a push/PR CI
  matrix (macOS, Linux, Windows x Node 18-24) plus a packaged smoke test; release hardening (pinned
  actions and npm, tag must be on main); `.gitattributes` keeps Windows checkouts LF; the suite no longer
  pops notifications, touches the network, or depends on git being installed.

## [1.6.1] - 2026-07-21

### Fixed
- **An `npm update` no longer re-enables the guardian.** `postinstall.js` now wires the status line
  only (`--install --no-guardian`) since it re-runs on every update; the guardian is set up by an
  explicit `ccrig init` (still on by default there), so an update can't silently turn it back on for
  someone who removed it. (`--uninstall-guardian` already persists `autopilot: off`.)
- **The profile switchers stop listing ccrig's own state directories** (`.claude-usage-ledger`,
  `.claude-rig-sessions`) as phantom profiles, in both `claude-profiles.sh` and `claude-profiles.ps1`.
- **The resume ticket now records the true limit level.** It is still written once at the warn band,
  but the critical render refreshes it when usage has climbed (e.g. 92% -> 99%), so the ticket's
  usage/reset line is accurate instead of frozen at the first warn-band value.
- Updated `SECURITY.md` (guardian is on by default, not opt-in) and stale `98%` references to the
  current `95%` critical threshold.

## [1.6.0] - 2026-07-20

### Added
- **Native PowerShell profile switcher (`claude-profiles.ps1`).** Windows and cross-platform
  PowerShell users get the same `claude-profile` verbs as the bash/zsh helper (list, use, run,
  new, current, remove); dot-source it from `$PROFILE`. It resolves home the same way Node does
  (`USERPROFILE`) so it agrees with Claude Code, surfaces dot-profiles on macOS/Linux, and enforces
  a strict name allowlist. ccrig is now natively usable on macOS, Windows, and Linux end to end.

## [1.5.0] - 2026-07-20

### Changed
- **The guardian is now ON by default.** `ccrig init` / `--install` wires the guardian hooks
  (SessionStart restore, PreCompact, Stop) and the shipped `autopilot` default is `notify`: out of
  the box, hitting a usage limit checkpoints your work, saves a resume ticket, and sends a desktop
  ping. Nothing runs unattended at the default. Install the bar only with `--install --no-guardian`,
  or set `"autopilot": "off"`. `--install-guardian --auto` still opts into hands-free auto-resume.
- **Continuous-refresh checkpoints (`continuousCheckpoint`, default true).** While a window is in the
  danger band, the checkpoint is re-written on the render loop (about every 10s) so an auto-resume
  reflects your latest completed step instead of a stale snapshot from when the limit was first crossed.
  Driven by the existing status-line refresh, so there is no per-tool-call overhead, and it stays
  fully cross-platform (macOS, Windows, Linux).
- **Critical threshold lowered from 98% to 95%,** so the checkpoint arms with more headroom before the wall.

### Added
- **`--no-guardian`**: install the status line without the guardian hooks (bar only).

## [1.4.0] - 2026-07-20

### Added
- **Guardian: warn-band checkpoints.** The work-state checkpoint (and resume ticket) is now
  written from the warn threshold (90%), not only at critical (98%). A usage limit that arrives
  without a `>=`critical render (a jump straight from 9x% to the wall, a per-model cap, or the
  last pre-wall render landing sub-critical) still leaves recovery state, and it upgrades to the
  full critical snapshot at critical. The auto-resume watcher and desktop notification stay
  critical-only, and a plain (non-guardian) install still checkpoints nothing.

### Changed
- **Guardian: disarm on recovery.** If an armed limit window recovers before its reset, because you
  upgraded your plan or bought extra usage and the same session keeps going, the guardian now stands
  the auto-resume watcher down instead of relaunching later on already-finished work. A missing usage
  reading is treated as "still blocked", never as recovery.
- **Guardian: verified relaunch.** The auto-resume relaunch now consumes the checkpoint only on a clean
  exit. A relaunch that launches but immediately dies (a still-active weekly cap, expired auth, network
  down) keeps the checkpoint for a manual `claude --resume` and reports the failure honestly, instead of
  discarding recovery state and reporting success regardless of exit code.
- **Guardian: a pre-reset manual resume keeps auto-resume armed.** Opening the session before the reset
  (to look, or after upgrading a different profile) no longer forfeits the armed watcher; it stands
  itself down only once you genuinely continue past the reset. A resume after the reset consumes as before.
- **Guardian: stands down when the work is already done.** At fire time, if the checkpointed todos are
  all complete, the watcher skips the unattended relaunch.
- **Moved to GitHub.** The canonical repository is now `github.com/jordanallenlewis/ccrig`; the update
  check, `--update` download, install one-liner, and package metadata all point at GitHub.
- **Simplified the README** for the repo and npm pages.

## [1.3.0] - 2026-07-19

### Added
- **Native `/ccrig` commands in Claude Code.** Installing now adds a `/ccrig` hub plus focused
  `/ccrig:status`, `/ccrig:sessions`, `/ccrig:doctor`, `/ccrig:update`, and `/ccrig:config` commands to
  the Claude Code `/` menu (the classic `/statusline-config` stays). Each runs the matching CCRig command
  and presents the result in plain language. `--uninstall` removes them all.

### Changed
- Every command's output was rewritten to read as polished, user-facing text: friendly phrasing, real
  plurals ("1 watcher", not "watcher(s)"), and no developer jargon (for example, "refusing to apply" is
  now "Update skipped") across install, uninstall, the guardian, update, status, board, sessions, and purge.

### Fixed
- All writes to `settings.json` (and `statusline.config.json`) now go through an atomic write-and-rename,
  so an interrupted or locked write can never leave the file every tool shares half-written. A failed
  write now reports honestly that the file was left unchanged.

## [1.2.0] - 2026-07-19

### Added
- `ccrig init` sets up the status line in Claude Code (the same action as `ccrig --install`), following
  the `init` convention of tools like starship and husky. Short subcommand forms now work alongside the
  flags: `ccrig init`, `ccrig update`, `ccrig doctor`, `ccrig preview`.
- Installing with `npm install -g ccrig` also best-effort-runs that setup through an npm postinstall, so
  a single command can be enough. Because npm v12, pnpm, yarn, and bun turn install scripts off by
  default, that step may be skipped, so `ccrig init` is the reliable way to wire it and is safe to
  re-run. The postinstall never fails the install, never runs from the project's own source checkout,
  and can be turned off with `CCRIG_NO_POSTINSTALL=1`.

### Changed
- The official name is now **CCRig** (the npm package and the `ccrig` command stay lowercase, as npm
  requires). The CLI banner, the README, and the rest of the docs use it.
- Full README revision: a two-step quick start (install, then `ccrig init`), an npm badges row, an
  npm-first update path, the `ccrig ...` command form throughout, and tighter prose.
- A friendlier `--help` header and a clearer first-run message after install.

### Fixed
- **Cross-platform: Guardian auto-resume now works on Windows.** The relaunch used to spawn `claude`
  directly, which fails on Windows because `claude` is a `.cmd`/`.ps1` shim, not a `.exe`. It now resolves
  the shim to the Node entry it runs and launches that, passing the resume prompt verbatim with no shell
  in the loop.
- The `--sessions` and resume-ticket command is PowerShell-native on Windows now
  (`cd '...'; $env:CLAUDE_CONFIG_DIR='...'; claude --resume ...`), instead of cmd.exe syntax that would not
  paste into PowerShell and never exported the profile (so a copied command resumed under the wrong account).
- `--install` no longer prints a bash `source` hint on Windows, where PowerShell cannot source a `.sh` file.
- `--doctor` no longer warns that a Windows `.cmd` shim is un-spawnable (auto-resume can launch it now).
- The test suite runs green on Windows as well as macOS and Linux (a POSIX-only profile-switcher test
  skips cleanly where no bash or zsh is present).

## [1.1.2] - 2026-07-19

### Changed
- The user install docs are now npm-only. The git clone was removed from the README's install options,
  so nobody is told to clone just to run ccrig: npm is the install (`npm install -g ccrig && ccrig
  --install`), the update (`npm install -g ccrig@latest`), and where the profile switcher is sourced
  from (`source "$(npm root -g)/ccrig/claude-profiles.sh"`). The curl one-liner stays as a fallback for
  a machine that has Node but not npm. Cloning is now documented only in CONTRIBUTING.md, for people
  hacking on ccrig.

## [1.1.1] - 2026-07-19

### Changed
- The tool's official name is **ccrig**, matching the npm package and the `ccrig` command. The docs no
  longer call it "Rig"; the phrase "your Claude Code rig" stays only as the origin of the name. No code
  or on-disk paths changed (the `.claude-rig-sessions` board directory keeps its name).
- **npm is now the primary, official way to install ccrig and to get updates.** The README leads with
  `npm install -g ccrig && ccrig --install`, and `npm install -g ccrig@latest` for updates; the curl
  one-liner and the git clone stay documented as alternatives for people without a Node package manager
  or who prefer `git pull`. SECURITY.md is reframed the same way. No behavior change to the render or
  the guardian.
- `--check-update` now prints the npm upgrade command (`npm install -g ccrig@latest`) when the running
  copy was installed from npm, instead of pointing at `--update` (which already defers to npm). The
  `--help` line for `--update` names the npm path too.

### Added
- Published to npm as `ccrig`. Install with `npm install -g ccrig && ccrig --install`, or preview with
  `npx ccrig --demo`. The clone and curl paths are unchanged.

## [1.1.0] - 2026-07-19

### Added
- Cell-accurate terminal width for CJK, Hangul, kana, and fullwidth characters, so the bar no
  longer overflows a narrow terminal when a folder, branch, or session name is non-ASCII.
- `resetStyle: "clock24"` for a 24-hour reset clock (the default stays `clock`).
- `--dismiss-update` to silence the update badge for a version you choose to skip.
- `updatePubkey`: pin an Ed25519 public key to require a signed `statusline.js.sig` on every
  `--update`. Empty by default, so behavior is unchanged; see SECURITY.md for the signing commands.
- The guardian re-arms on a second limit in one session (a window switch), and the watcher
  re-reads its checkpoint each tick, so a refreshed reset time is honored.
- `autopilotBypassPermissions` (off by default): let the unattended auto-resume relaunch run in
  bypass-permissions mode, so a permission prompt cannot stall a headless pickup. Applies only to
  the guardian's own relaunch, never your interactive session.
- Profile-aware resume: a session belongs to a profile (`CLAUDE_CONFIG_DIR`), and every resume path
  now pins that profile so a session resumes on the account it ran under, not whatever profile the
  shell or watcher happens to be set to. `--sessions` scans every profile and labels each row; the
  resume ticket records the owning profile and pins it; the checkpoint stores the profile and the
  auto-resume watcher relaunches under it.
- A performance budget and a sandboxed benchmark recipe in CONTRIBUTING.md.
- Mechanical quality gates (`test-gates.js`, run by `node --test`): a plain-voice scan of the docs
  and CLI text, example-config-versus-defaults parity, config-key coverage, and README/help flag parity.

### Changed
- Rewrote the docs (README, SECURITY, CONTRIBUTING, changelog prose) and the CLI's own output
  in a plainer, more human voice: dropped every em-dash and tightened the phrasing. No behavior
  change. Also corrected the README install section, which still claimed you had to re-run
  `--install` per profile (`1.0.1` made one run cover them all).
- Raised the `gitCacheMs` default from 2500 to 10000, roughly halving how often a large repo
  re-shells `git status` on the render. Branch and dirty state can lag by up to about 10 seconds;
  one config line changes it back. Both `git status` calls now pass `--no-optional-locks`, so a
  background render never takes the repo index lock.

### Fixed
- A missing desktop-notifier binary no longer crashes the render at critical usage (the detached
  spawn now handles its asynchronous error event).
- One-shot flags such as `--purge` and `--update` now respect the one-command-at-a-time gate, so a
  combined command like `--purge --install` is rejected instead of silently running only one.
- `--uninstall` removes the guardian hooks even when run from a moved or re-downloaded copy, and
  leaves a genuinely third-party status line in place instead of deleting it just because its
  script is also named `statusline.js`.
- `--doctor` path-checks guardian hook commands and unquoted status-line commands and flags a stale
  `/statusline-config` path, instead of reporting "All checks passed" on a broken install.
- `--install` no longer wires a foreign `~/.claude-*` tool directory as a profile, announces when
  it replaces an existing status line, and protects the original settings backup across re-installs.
- The update badge stops nagging about a version that can never be fetched: staleness is now based
  on the last successful check, not the last attempt.
- An unwritable config dir no longer spawns a network-touching update checker on every render.
- Update redirects are restricted to http(s) with no https-to-http downgrade; `isOurGitClone` no
  longer matches an unrelated repo whose remote merely contains the project name as a substring;
  `NO_PROXY` honors the `*.example.com` form; `--update --force` can re-apply the current version to
  repair a modified copy; a malformed four-part remote version is refused.
- Hostile or empty stdin (valid-JSON `null`, a non-string model name, a non-numeric `reserveCols`)
  degrades per segment instead of crashing the render to the error banner.
- The usage bar reserves its last block for a true 100%, so it no longer reads "full" at about 94%,
  and it turns red at the warn threshold in step with the label.
- `writeJsonAtomic` never strands a temp file when a rename fails; `--purge` now also removes the
  render error log; `--sessions` and the resume ticket print a Windows-runnable `cd /d` command on
  Windows.
- The profile switcher rejects slashed or dot-dot profile names, so `claude-profile new`/`remove`
  can no longer create or delete a directory outside the `.claude-*` namespace.

### Security
- On Windows, the guardian's PID-ownership check verifies the process command line before signaling,
  so a recycled PID is never killed; the desktop notification passes its text through the
  environment instead of a PowerShell command string, closing an injection path; and the
  cross-profile ledger validates each profile name before it becomes a config-dir path.

## [1.0.1] - 2026-07-18

### Fixed
- `--install` now wires **every** Claude profile on your machine, not only the active one.
  If you run more than one profile (say a work `~/.claude` and a personal `~/.claude-personal`),
  a single `--install` used to land on whichever profile `CLAUDE_CONFIG_DIR` happened to point at
  and quietly skip the others. So you'd fire up the second profile and the bar just wasn't there.
  Now install finds all of them, wires each, and prints exactly which ones it touched. The same
  goes for `--install-guardian`, `--uninstall`, and `--uninstall-guardian`. Want the old behavior?
  Add `--this-profile` to scope any of them to the active profile. ccrig's own state folders
  (`.claude-usage-ledger`, `.claude-rig-sessions`) are never mistaken for a profile, and one
  profile with a broken `settings.json` no longer blocks the rest.

## [1.0.0] - 2026-07-18

The first public release of **ccrig**: the operational layer you run Claude Code from.

ccrig began life as "Claude Code Better Status Line," a single-file status line that read
[Claude Code](https://claude.com/claude-code)'s own stdin. It grew into a full rig: a live
command bar plus an opt-in guardian that survives usage limits, self-update, and tools for
running many sessions. This release consolidates all of that into one intentional 1.0.0.
It's a single Node file with zero dependencies; the render makes no network calls, and
everything that touches your machine is opt-in, backed up, and reversible.

### The status line
- A command-center bar read entirely from Claude Code's stdin JSON: active profile, model
  (with a `[1m]` tag on 1M-context models), reasoning effort, `fast`/`no-think` flags, a
  color-coded context-window bar, git (branch, uncommitted, unpushed/unpulled), billing path
  (`sub` vs `api`), and 5-hour + 7-day plan-usage bars with date-aware reset times.
- Dynamic line-wrapping that tracks a live terminal resize; a brief git cache so large repos
  don't slow each render; three display densities (`--mode minimal|normal|expanded`).
- External config in `statusline.config.json` (deep-merged over defaults, so updates never
  overwrite your settings), an interactive editor (`--config`), and an in-session
  `/statusline-config` menu. Config saves persist only your overrides, not a full snapshot.

### The Guardian (opt-in: `--install-guardian`)
- **Limit Autopilot.** At ~98% usage it checkpoints your work state (open/finished todos,
  last request, git HEAD + dirty, in-flight subagents); with `autopilot: "resume"` a detached,
  sleep-safe watcher relaunches `claude --resume <id> -p` the moment the window resets and
  re-injects the checkpoint, so it continues the next step instead of redoing finished work.
  Capped and unattended-safe. Default `off`; `--install-guardian` sets `notify`.
- **Keep-working.** A `Stop` hook keeps the session going while todos remain (loop-guarded,
  yields to a real question).
- **Time-to-limit forecast** in the bar (`⏳ ~34m to session limit`), from a rolling burn rate.
- **Cross-profile failover** (opt-in `ledger: true`): continue on an account with headroom.
- **Compaction-proof checkpoints** (`PreCompact`), and optional `reinjectOnCompact` to
  re-include your `CLAUDE.md` after a compaction.
- **Subagent awareness** (`🤖 N agents`) and a **silent-downgrade alarm** (`⬇`, Opus→Sonnet).
- Inspect and control it: `--status`, `--disarm`, `--purge`; resume tickets at critical usage.

### Self-update
- A once-a-day background check shows an `⬆` update badge (the render stays zero-network; it
  reads a local cache the check writes). `--update` does a `git pull` for a clone, or for a
  standalone copy downloads → validates (`node --check` + shape gate, optional Ed25519
  signature) → backs up → atomic-swaps, refusing downgrades and anything that isn't the real
  script. `--check-update` and `--whatsnew` on demand. Honors `HTTPS_PROXY`/`NO_PROXY` + a
  corporate CA. Off with `"updateCheck": false`.

### Running many sessions
- `--board` (opt-in): every live session across your worktrees and profiles at a glance.
- `--sessions`: recent sessions with the exact command to resume each.

### Profiles
- `claude-profiles.sh`: create, switch, and run isolated `CLAUDE_CONFIG_DIR` profiles; the
  `👤` badge shows which account is active.

### Trust & quality
- Zero-network render, local-only reads, opt-in guardian, backups before every write, full
  reversibility. `SECURITY.md` carries the threat model and on-disk data map. Hardened by
  many adversarial-review passes; **unit + regression suites (119 tests), CI-enforced.**
  Unofficial. Not affiliated with Anthropic. MIT.

### Credit
- Kickstarted by Hannah Stulberg's guide, *"Claude Code for Everything: Your Status Line Is
  Empty (Let's Fix That)"*. The command-center concept, the context-bar thresholds, the
  folder/model/git/usage segments, and the portable Node-script approach all came from there. A comment on it
  (by AstroHan) noted the plan-usage numbers are already in the status line's stdin, which is
  what let this drop the API call the guide used.

[Unreleased]: https://github.com/jordanallenlewis/ccrig/compare/v1.6.1...HEAD
[1.6.1]: https://github.com/jordanallenlewis/ccrig/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/jordanallenlewis/ccrig/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/jordanallenlewis/ccrig/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/jordanallenlewis/ccrig/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/jordanallenlewis/ccrig/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/jordanallenlewis/ccrig/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/jordanallenlewis/ccrig/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/jordanallenlewis/ccrig/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/jordanallenlewis/ccrig/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/jordanallenlewis/ccrig/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jordanallenlewis/ccrig/releases/tag/v1.0.0
