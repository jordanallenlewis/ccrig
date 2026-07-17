# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Near-limit warning: once session or weekly usage crosses `thresholds.usage.warn`
  (default 90%), the usage bar turns bold red and a `resumeHint` segment shows that
  work is auto-saved and how to resume after a rate-limit reset (`claude --continue`).

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

[Unreleased]: https://gitlab.com/jordanallenlewis/claude-code-statusline/-/compare/v1.0.0...HEAD
[1.0.0]: https://gitlab.com/jordanallenlewis/claude-code-statusline/-/tags/v1.0.0
