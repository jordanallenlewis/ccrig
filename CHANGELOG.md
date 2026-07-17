# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Renamed the project to **Better Status Line**. The repo slug, the `statusline.js`
  filename, and the install commands are unchanged, so existing installs keep working.

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

[Unreleased]: https://gitlab.com/jordanallenlewis/claude-code-statusline/-/compare/v1.4.0...HEAD
[1.4.0]: https://gitlab.com/jordanallenlewis/claude-code-statusline/-/compare/v1.3.0...v1.4.0
[1.3.0]: https://gitlab.com/jordanallenlewis/claude-code-statusline/-/compare/v1.2.0...v1.3.0
[1.2.0]: https://gitlab.com/jordanallenlewis/claude-code-statusline/-/compare/v1.1.0...v1.2.0
[1.1.0]: https://gitlab.com/jordanallenlewis/claude-code-statusline/-/compare/v1.0.0...v1.1.0
[1.0.0]: https://gitlab.com/jordanallenlewis/claude-code-statusline/-/tags/v1.0.0
