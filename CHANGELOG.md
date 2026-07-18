# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Renamed the project to Rig** (handle/repo: `ccrig`), tagline *"Your Claude Code rig."*
  It has outgrown "status line": it's the operational layer you run Claude Code from — a
  command bar, the guardian, and more to come. The single file is still `statusline.js`
  and the install/config paths are unchanged, so existing installs keep working.
- The GitLab project path is renamed to `ccrig`. GitLab keeps a redirect from the old path,
  so existing clones and the install one-liner keep working; update your remote at your
  convenience with `git remote set-url`. The `--update` shape-check accepts both the old and
  new name for one release, so any installed copy can still update across the rename.

## [2.4.0] - 2026-07-18

### Added
- **Cross-session board** (`--board`): with `"sessionBoard": true`, every live render publishes
  a light state file to a shared dir, and `--board` shows every session across your worktrees
  and profiles at a glance — project, model, usage, context, running subagents, and whether one
  is near/at a limit. Stale entries (>1h) are pruned; off by default (it writes outside the
  config dir); cleared by `--purge`. The single biggest thing no other tool does for people
  juggling many Claude Code sessions.
- **Resume-picker** (`--sessions`): lists your recent sessions newest-first (project, size, last
  request) with the exact `cd … && claude --resume <id>` for each — read-only, no opt-in.
- **Rules re-injection after compaction** (`"reinjectOnCompact": true` or a file path): a
  `SessionStart` hook re-includes your `CLAUDE.md` (or a named rules file) after Claude Code
  compacts context, in case compaction dropped it. Off by default.

## [2.3.0] - 2026-07-18

Hardening pass from ten parallel adversarial-review workflows (each a different aspect:
supply-chain, auto-resume, keep-working, cross-platform, performance, config-fuzz, privacy,
tests, docs, code quality), every finding independently verified. The behaviour-affecting fixes:

### Changed
- **Autopilot defaults to `off`.** A plain `--install` no longer writes a checkpoint or spawns
  a desktop notification at 98% — only the resume ticket (a documented base feature). The guardian
  (`--install-guardian`) sets `notify`/`resume` as before. Kills an unsolicited `osascript`/`notify-send`
  process for status-line-only users.
- **Config saves are now sparse.** Setters (`--mode`, `--autopilot`, `--install-guardian`, the editor)
  persist only the keys that differ from the defaults, so a future release's improved default value
  actually reaches you instead of being frozen by an earlier save.

### Fixed
- **Auto-resume scheduling.** A session (5h) watcher no longer inherits an earlier weekly reset time
  (it would have fired days late); the checkpoint schedule is refreshed for the window being armed, and
  a `PreCompact` snapshot no longer nulls out an armed window's reset time.
- **The "unattended" instruction** is now injected only when the watcher actually relaunches headless —
  not on an attended context-compaction or a manual resume, where it wrongly made Claude over-cautious.
- **Cross-profile failover** won't launch a second agent into your working tree while the foreground
  session is still active (a 2-minute transcript-idle guard).
- **Config `order` migration:** a saved/older `order` now has newly-added segments (update, downgrade,
  agents) unioned in, so upgrades surface them instead of silently dropping them.
- Proxied HTTPS fetch gets a timeout handler (a mid-body stall no longer hangs `--update`); the
  response-size cap delivers its error once; the CONNECT tunnel preserves bytes past the header.
- `inflightAgents` is cached by transcript size (no 768KB re-read on idle refreshes); `--disarm`/`--purge`
  verify a PID is really our watcher before signalling it; the keep-working Stop hook full-scans a large
  transcript so a big tool_result can't hide open todos; `⏳` counts as 2 cells so wrapping stays exact;
  atomic writes use a pid-unique temp; per-session model files are swept on the 14-day retention.
- A real-HTTP unit test now exercises the fetch/redirect path in-process (a subprocess can't reach a
  test server in a sandbox); the git-clone `--update` path warns that a pinned signing key is not
  enforced on `git pull`. 112 tests.

## [2.2.0] - 2026-07-18

### Added
- **Workflow + subagent awareness.** A new `🤖 N agents` segment shows how many
  subagents (`Task`/`Agent`) are running right now, detected from in-flight tool calls
  in the transcript. When a limit interrupts orchestration, the checkpoint records the
  in-flight subagents, and the resume tells the session they did **not** survive the
  limit and must be re-dispatched — so a workflow-heavy session recovers cleanly.
- `--status` (list armed auto-resume watchers, with their reset times — nothing is a
  hidden daemon; each writes a PID file), `--disarm [session-id]` (stop them), and
  `--purge` (delete all local guardian state). `--doctor` now reports the subscription-
  only nature of the usage/forecast/auto-resume features.
- **Silent-downgrade alarm.** A new `⬇` segment shouts when Claude Code quietly drops the
  model tier mid-session (Opus → Sonnet as you approach the Opus cap), so you notice
  instead of finding out later. Off with `"downgradeAlert": false`.
- **Signed updates (opt-in).** `--update` verifies an Ed25519 signature
  (`statusline.js.sig`) when you pin a public key via `updatePubkey`, using zero-dep
  `node:crypto` — a bad or missing signature refuses the swap. Unpinned, updates rest on
  HTTPS/TLS + validation + manual apply, documented in `SECURITY.md`.
- **A unit-test layer.** `test-unit.js` requires `statusline.js` as a module (it exports
  its pure helpers when required and never runs the CLI) and unit-tests the internals
  directly. `node --test` runs both it and the black-box suite; CI runs both. 105 tests.

### Changed / hardened (pre-launch, from an adversarial critique panel)
- **Auto-resume is capped.** An unattended relaunch runs with keep-working disabled, so
  it completes its reviewable steps and stops instead of looping overnight; the resume
  prompt states it is running unattended and to avoid new long workflows and irreversible
  actions without a human.
- **Honest "zero-network."** Wording everywhere now says the *render* is zero-network and
  names the one optional daily update check (with its off-switch) — the render itself
  still never touches the network.
- **Cross-profile ledger/failover is now OFF by default** (it wrote outside the config
  dir and cross-account use is a per-user call); the failover resume prompt no longer
  claims a transcript that a fresh cross-account session doesn't have. Ledger writes are
  atomic. Added a `SECURITY.md` with the threat model, on-disk data, and update trust model.

## [2.1.0] - 2026-07-18

### Added
- **Update notifications + one-command self-update.** A once-a-day background check
  (a single unauthenticated GET to the public repo) learns whether a newer version
  exists and shows an `⬆ v2.2.0 available` badge in the bar. The **render stays
  zero-network** — it only reads a small local cache (`$CLAUDE_CONFIG_DIR/.ccbsl-update.json`)
  that the detached background check writes; the check is throttled to once per 24h and
  fails silently when offline or blocked. So people already running it learn about new
  features instead of silently drifting behind.
- `--update` pulls the newest version: a `git pull` for a clone, or for a standalone
  copy a download that is **validated before it is trusted** (`node --check` for syntax
  plus a shape check that it really is `statusline.js`), the current file **backed up**,
  then an **atomic same-directory swap** with rollback if anything fails. It prints the
  changelog for what you just pulled. `--check-update` runs the check on demand;
  `--whatsnew` prints the newest changelog section for the installed version.
- Corporate-network aware: honors `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` (a zero-dep
  CONNECT tunnel for HTTPS) and never spams errors when a proxy or TLS policy blocks it.
- Turn it all off with `"updateCheck": false`.

## [2.0.0] - 2026-07-18

The **Guardian**: five features that make the status line the first one that *acts*
on your limits instead of only displaying them. Everything still reads the JSON and
transcript Claude Code already writes: no network, no token, no keychain, zero deps.
All of it is opt-in and reversible; wire it with `node statusline.js --install-guardian`
(the plain `--install` still installs the status line alone). Grounded in a survey of
the whole ecosystem (ccstatusline, claude-powerline, ccusage, Claude-Code-Usage-Monitor,
claude-auto-retry, unsnooze) and verified against the official docs.

### Added
- **Limit Autopilot (auto-pause + auto-resume).** At `thresholds.usage.critical`
  (98%) the status line snapshots the exact work state to a checkpoint (open/finished
  todos, the last request, and git HEAD + dirty flag). With `autopilot: "resume"` a
  detached, sleep-safe watcher (polls wall-clock, so it survives laptop suspend and
  week-long waits) relaunches the precise session with `claude --resume <id> -p` the
  moment the window resets, and a `SessionStart` hook re-injects the checkpoint so the
  resumed run continues the next step and does not repeat finished work. `"notify"`
  (default) checkpoints and pings without relaunching; `"off"` disables it.
- **Relentless mode (keep-working).** A `Stop` hook refuses to let the session pause
  while todos remain, feeding the open items back so it keeps going. It yields the
  moment you're actually asked a question, and has loop guards (a hard continue cap and
  a stall detector) so it never spins. Off by default; `--keep-working on`.
- **Time-to-limit forecast.** A new `forecast` segment projects, from a rolling
  burn-rate sample, when you'll hit the wall: `⏳ ~34m to session limit · slow down`,
  or `⏳ session safe (resets first)` when the window refreshes before you'd exhaust it.
  Plain language, right in the bar. No separate monitor process.
- **Cross-profile failover.** Each render publishes this profile's usage to a shared
  ledger; when the active account is at its limit and another profile still has
  headroom, the bar suggests continuing there (`⤳ personal free 80%`), and with
  `autopilotFailover: true` the watcher continues on it instead of waiting for the reset.
  Stale ledger entries (>6h) are ignored.
- **Compaction-proof checkpoints.** A `PreCompact` hook snapshots work state before
  Claude Code compacts context, and `SessionStart` restores it, so nothing is lost
  across a compaction or a manual resume, limit or not.
- New commands: `--install-guardian [--auto]`, `--uninstall-guardian`,
  `--autopilot <off|notify|resume>`, `--keep-working <on|off>`, and the internal
  `--hook <event>` / `--watch <id>` the installer wires. `--doctor` now reports which
  guardian hooks are wired and whether `claude` is reachable for auto-resume; `--options`
  prints the guardian block; `--uninstall` removes guardian hooks too.
- 35+ tests covering the Stop/SessionStart/PreCompact hooks, the checkpoint, the
  forecast, the ledger/failover, and the installer, plus an end-to-end watcher relaunch.

### Hardened (found by a multi-agent adversarial review, each with a regression test)
- The keep-working loop guards now **fail open**: if the continue/stall counters can't
  be persisted, the Stop hook allows the pause instead of blocking forever.
- The auto-resume watcher **refuses to fire without a known reset time** (a null
  `resets_at` no longer collapses to "relaunch in `buffer` seconds" and re-hit the wall),
  **stands down if you already continued the session yourself** after the reset (no
  concurrent headless run), keeps the checkpoint if the relaunch spawn fails, and clears
  its arming markers on relaunch so a second limit in the resumed session re-arms.
- The burn-rate fit **rebases timestamps to a local origin**, fixing catastrophic
  floating-point cancellation on raw epoch seconds that made short-span ETAs wildly wrong;
  a window with usage but no reset no longer shows an absurd multi-hundred-hour forecast.
- Guardian side effects (ticket, checkpoint, notification) are gated to the **live render**
  only, so `--demo` / `--config` / `--selftest` never write files or ping, even under a
  hand-edited `critical` threshold. `--uninstall` now leaves a **third-party status line**
  untouched, and guardian-hook removal is **per-hook** so a co-located user hook survives.
  Orphaned burn-sample files are pruned on the 14-day retention like tickets/checkpoints.

### Constraints (documented, not hidden)
- Auto-resume needs a Claude.ai Pro/Max plan (rate-limit data is subscriber-only) and
  a machine that's on at the reset. It relaunches a *new headless* run of the session
  (Claude Code exposes no way to wake your open terminal) and reconciles via git; the
  resume ticket + `SessionStart` restore still cover the manual case. Weekly (7-day)
  auto-relaunch is off by default because multi-day waits are less reliable.

## [1.4.0] - 2026-07-17

### Changed
- `/statusline-config` now opens an interactive menu in the Claude Code CLI
  (via the AskUserQuestion tool): pick display mode, toggle a segment, reset
  style, thresholds, and so on, then apply, preview, and loop for the next change.
  Free-text ("turn off billing") still works. `--install` regenerates the command.

## [1.3.0] - 2026-07-17

### Added
- In-session configuration: `--install` now also writes a `/statusline-config`
  slash command (to the profile's `commands/` dir). Running it in a Claude Code
  session shows every option and lets you change settings in plain language.
  `--uninstall` removes the command.
- `--options`: prints every current setting and its choices (display mode,
  segments with state, thresholds, reset style, resume tickets, git cache,
  profile labels) in a human- and agent-readable form.

### Fixed
- A reset time that passes while the session is idle no longer lingers as a stale
  past time. Claude Code only refreshes `rate_limits` on the next message, so a
  window whose `resets_at` is now in the past shows `↺now`, and its near-limit
  warning and resume ticket are cleared (the window already refreshed). Fresh
  numbers arrive on the next message. Re-evaluated every render against the clock.

## [1.2.0] - 2026-07-17

### Added
- Display modes: `node statusline.js --mode minimal | normal | expanded` sets how
  much the status line shows, saved to config and applied live. `minimal` keeps the
  quiet essentials (profile, folder, model, context, git); `expanded` shows every
  segment with data (including cost and session name); `normal` respects your
  per-segment toggles. The near-limit warning always shows through, even in minimal.
  In `--config`, press `m` to cycle modes with a live preview. An invalid `mode` in
  config falls back to `normal`.

## [1.1.0] - 2026-07-17

### Added
- Near-limit warning: once session or weekly usage crosses `thresholds.usage.warn`
  (default 90%), the usage bar turns bold red and a `resumeHint` segment shows that
  work is auto-saved and how to resume after a rate-limit reset (`claude --continue`).
- Built-in cross-platform installer: `node statusline.js --install` wires
  `settings.json` (with a backup) using the exact node binary it was run with;
  safe to re-run. `--uninstall` removes it. Enables the one-line install in the
  README, and works on Windows where `install.sh` can't.
- `--doctor`: diagnoses the common failure modes (unwired settings, a node path
  broken by a version-manager upgrade, invalid settings or config JSON, a render
  error) with a fix hint per finding. Exits 1 when something is wrong.
- `--version`, and running the file bare in a terminal now prints help instead of
  blocking on stdin.
- Resume tickets: at critical usage (`thresholds.usage.critical`, default 98%) the
  status line saves `resume-tickets/<session>.md` in the Claude config dir with the
  project path and the exact `claude --resume <session-id>` command, so a session
  interrupted by a limit is findable days later. One ticket per session, 14-day
  retention, off with `"resumeTickets": false`.
- A test suite: `node --test test.js`, zero dependencies, 44 tests covering
  rendering, wrapping, profiles, tickets, hostile configs, git, and every CLI mode,
  run in CI. Regression tests encode bugs found by adversarial review.

### Fixed
- A crash guard around rendering: on any error the status line prints a short
  hint and logs the stack to `statusline-error.log` instead of dying silently.
- A hand-edited config that nulls out a whole section (`"color": null`,
  `"show": "x"`, an empty `order`) no longer crashes the script; the broken
  section falls back to defaults. Non-numeric threshold values fall back too
  (they silently broke bar colors).
- Found by adversarial review, each with a regression test: `--install` against a
  settings.json holding a JSON array or bare value reported success while
  installing nothing (now refused); `--doctor` missed a dead script path, false-
  failed valid wrapper commands, and crashed on a non-string `command` (now checks
  every quoted absolute path and diagnoses type errors); `--uninstall` dumped a raw
  stack trace on a read-only settings.json (now a clean failure message).
- Passing two mode flags at once (`--install --uninstall`) now errors instead of
  silently running only the first.
- `os.homedir()` throwing (arbitrary-UID containers) no longer kills the script
  before the crash guard.

### Changed
- `install.sh` now delegates to the built-in Node installer.

## [1.0.0] - 2026-07-17

### Added
- Single-file, zero-dependency status line for Claude Code, reading every value
  from the JSON Claude Code passes on stdin (no network, no token, no keychain).
- Segments: active profile (`👤`), project folder (`📂`), model (`★`, with a
  `[1m]` tag on 1M-context models), reasoning effort (`⚡`), inference-mode flags
  (`fast` / `no-think`), a color-coded context-window bar, git (branch,
  uncommitted, unpushed `↑` / unpulled `↓`), the caveman-plugin badge, billing
  path (`💳 sub` vs `💳 api`), and session (5h) + weekly (7d) usage bars with
  date-aware reset times. Optional cost and session-name segments.
- Dynamic line-wrapping that tracks live terminal resize.
- External configuration in `statusline.config.json` (deep-merged over built-in
  defaults) so updates never overwrite your settings. See
  `statusline.config.example.json`.
- Interactive config editor: `node statusline.js --config` (toggle segments,
  live preview, save).
- `--demo`, `--selftest`, and `--help` command-line modes.
- Git state is cached briefly (`gitCacheMs`, default 2500ms) so large repositories
  do not slow down each render.
- `claude-profiles.sh`: manage and switch multiple Claude Code account profiles
  (`claude-profile list|use|run|new|current|remove`), generalized for any profile
  names. The status line's `👤` badge shows which profile is active.
- Billing-path detection: `rate_limits` in stdin means a Claude.ai subscription;
  an API key means pay-per-token.
- `install.sh` installer and CI (`--selftest` + shellcheck).

[Unreleased]: https://gitlab.com/jordanallenlewis/ccrig/-/compare/v2.4.0...HEAD
[2.4.0]: https://gitlab.com/jordanallenlewis/ccrig/-/compare/v2.3.0...v2.4.0
[2.3.0]: https://gitlab.com/jordanallenlewis/ccrig/-/compare/v2.2.0...v2.3.0
[2.2.0]: https://gitlab.com/jordanallenlewis/ccrig/-/compare/v2.1.0...v2.2.0
[2.1.0]: https://gitlab.com/jordanallenlewis/ccrig/-/compare/v2.0.0...v2.1.0
[2.0.0]: https://gitlab.com/jordanallenlewis/ccrig/-/compare/v1.4.0...v2.0.0
[1.4.0]: https://gitlab.com/jordanallenlewis/ccrig/-/compare/v1.3.0...v1.4.0
[1.3.0]: https://gitlab.com/jordanallenlewis/ccrig/-/compare/v1.2.0...v1.3.0
[1.2.0]: https://gitlab.com/jordanallenlewis/ccrig/-/compare/v1.1.0...v1.2.0
[1.1.0]: https://gitlab.com/jordanallenlewis/ccrig/-/compare/v1.0.0...v1.1.0
[1.0.0]: https://gitlab.com/jordanallenlewis/ccrig/-/tags/v1.0.0
