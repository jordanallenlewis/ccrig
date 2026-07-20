# Changelog

All notable changes to **CCRig** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Versioning policy:** `MAJOR.MINOR.PATCH`. **MAJOR** for a breaking change to the
install, config, or documented behavior; **MINOR** for a backward-compatible feature;
**PATCH** for a backward-compatible fix. Every entry below is a real, tagged release.
In-progress work lives under `[Unreleased]` until it's cut.

## [Unreleased]

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

[Unreleased]: https://github.com/jordanallenlewis/ccrig/compare/v1.6.0...HEAD
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
