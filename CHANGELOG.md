# Changelog

All notable changes to **Rig** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Versioning policy:** `MAJOR.MINOR.PATCH`. **MAJOR** for a breaking change to the
install, config, or documented behavior; **MINOR** for a backward-compatible feature;
**PATCH** for a backward-compatible fix. Every entry below is a real, tagged release.
In-progress work lives under `[Unreleased]` until it's cut.

## [Unreleased]

### Changed
- Rewrote the docs (README, SECURITY, CONTRIBUTING, changelog prose) and the CLI's own output
  in a plainer, more human voice: dropped every em-dash and tightened the phrasing. No behavior
  change. Also corrected the README install section, which still claimed you had to re-run
  `--install` per profile (`1.0.1` made one run cover them all).

## [1.0.1] - 2026-07-18

### Fixed
- `--install` now wires **every** Claude profile on your machine, not only the active one.
  If you run more than one profile (say a work `~/.claude` and a personal `~/.claude-personal`),
  a single `--install` used to land on whichever profile `CLAUDE_CONFIG_DIR` happened to point at
  and quietly skip the others. So you'd fire up the second profile and the bar just wasn't there.
  Now install finds all of them, wires each, and prints exactly which ones it touched. The same
  goes for `--install-guardian`, `--uninstall`, and `--uninstall-guardian`. Want the old behavior?
  Add `--this-profile` to scope any of them to the active profile. Rig's own state folders
  (`.claude-usage-ledger`, `.claude-rig-sessions`) are never mistaken for a profile, and one
  profile with a broken `settings.json` no longer blocks the rest.

## [1.0.0] - 2026-07-18

The first public release of **Rig**: the operational layer you run Claude Code from.

Rig began life as "Claude Code Better Status Line," a single-file status line that read
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

[Unreleased]: https://gitlab.com/jordanallenlewis/ccrig/-/compare/v1.0.1...HEAD
[1.0.1]: https://gitlab.com/jordanallenlewis/ccrig/-/compare/v1.0.0...v1.0.1
[1.0.0]: https://gitlab.com/jordanallenlewis/ccrig/-/tags/v1.0.0
