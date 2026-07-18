# Contributing

Contributions are welcome: bug fixes, new segments, better platform support,
docs. Anyone can contribute; you don't need to be a maintainer. The only rule is
that every change lands through a merge request that a maintainer approves.

## How to contribute

1. Fork the repo (or create a branch if you have access) and make your change.
2. Keep it **zero-dependency**: `statusline.js` runs on the Node that ships with
   Claude Code, with no npm install. The shell tooling targets bash and zsh.
3. Test locally before opening the MR:
   - `node --test` (runs **both** suites: `test-unit.js` + `test.js`)
   - `node statusline.js --selftest` (quick rendering check on edge inputs)
   - `node statusline.js --demo` (eyeball the result)
   - `shellcheck claude-profiles.sh install.sh` if you touched the shell files

   There are two layers, both run in CI on every push:
   - **`test-unit.js`** — fast unit tests of the pure helpers (version compare, model
     tier, changelog/version parsing, transcript parsing, wrapping/bars). It `require()`s
     `statusline.js`, which exports its internals only when required (the CLI never runs).
   - **`test.js`** — black-box regression/integration tests that spawn the real script as
     a subprocess against a throwaway `HOME`/`CLAUDE_CONFIG_DIR` sandbox, covering
     rendering, wrapping, the guardian hooks, auto-resume, updates, and every CLI mode.
     Tests prefixed `REGRESSION:` encode a specific bug found in review — keep them passing.

   **A bug fix must ship with a test** — a unit test in `test-unit.js` if the logic is
   pure, a `REGRESSION:` test in `test.js` if it's behavioral. A new feature ships with
   tests for the happy path and the failure/edge cases.
4. Open a **merge request** describing the change and why. Reference an issue if
   one exists.
5. A maintainer reviews it. **An MR is merged only after a maintainer approves
   it.** That approval is required, so nothing lands unreviewed.

## What makes a change likely to be accepted

- It reads a value Claude Code actually provides (see the status line docs), or
  degrades gracefully when a field is absent.
- It stays fast: the script runs on every refresh, so avoid slow work on the hot
  path (network calls, un-cached subprocess spawns).
- New behavior is configurable and off by a sensible default, and documented in
  the README + `statusline.config.example.json`.
- User-facing changes get a note in `CHANGELOG.md` under `Unreleased`.

## Ideas that would help

- A PowerShell version of `claude-profiles.sh` for Windows.
- Reorder / color editing in the `--config` editor.
- More segments people ask for, behind config flags.

## Maintainers

Merge rights and approvals rest with the project maintainers. If you'd like to
become one after a few solid contributions, say so in an MR.
