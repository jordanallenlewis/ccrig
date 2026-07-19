# Contributing

Contributions are welcome: bug fixes, new segments, better platform support,
docs. Anyone can contribute; you don't need to be a maintainer. The only rule is
that every change lands through a merge request that a maintainer approves.

## How to contribute

1. Clone the repo (`git clone https://gitlab.com/jordanallenlewis/ccrig.git`), or fork it,
   then make your change on a branch. (Users install from npm; the clone is for hacking on CCRig.)
2. Keep it **zero-dependency**: `statusline.js` runs on the Node that ships with
   Claude Code, with no npm install. The shell tooling targets bash and zsh.
3. Test locally before opening the MR (there is no CI pipeline; the maintainer runs
   these on review, so please run them yourself first):
   - `node --test` (runs all three suites: `test-unit.js` + `test.js` + `test-gates.js`)
   - `node statusline.js --selftest` (quick rendering check on edge inputs)
   - `node statusline.js --demo` (eyeball the result)
   - `shellcheck claude-profiles.sh install.sh` if you touched the shell files

   The suite has three layers:
   - **`test-unit.js`**: fast unit tests of the pure helpers (version compare, model
     tier, changelog/version parsing, transcript parsing, wrapping/bars, glyph width). It
     `require()`s `statusline.js`, which exports its internals only when required (the CLI never runs).
   - **`test.js`**: black-box regression/integration tests that spawn the real script as
     a subprocess against a throwaway `HOME`/`CLAUDE_CONFIG_DIR`/`TMPDIR` sandbox, covering
     rendering, wrapping, the guardian hooks, auto-resume, updates, and every CLI mode.
     Tests prefixed `REGRESSION:` encode a specific bug found in review. Keep them passing.
   - **`test-gates.js`**: mechanical quality gates (plain-voice scan of docs and CLI text,
     example-config-versus-defaults parity, config-key coverage, README/help flag parity).
     These keep the docs and config honest; keep them green.

   The suite is hermetic (it never touches your real `~/.claude` or temp dir), and it
   passes on Node 18, 20, and 22 (the supported floor is Node 18), on macOS, Linux, and
   Windows. A few tests that need a POSIX shell or symlink privilege skip cleanly on
   Windows rather than failing.

   **A bug fix must ship with a test:** a unit test in `test-unit.js` if the logic is
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

## Performance budget

The status line runs on every refresh (about every 2 seconds), so the render is a
hot path. Measured on a recent laptop:

- Node interpreter startup is the floor, roughly 47ms, and about 75% of a render. A
  spawned single-file script cannot avoid it.
- Parsing and evaluating the script adds about 5ms.
- All the render's own work is about 8 to 12ms of JavaScript, doing roughly 19 file
  reads and zero writes and zero network at steady state.
- A git cache miss adds 24 to 65ms depending on repo size, which is why git state is
  TTL-cached (`gitCacheMs`).
- Transcript reads are capped at 768KB (about 1.9ms on a cold cache).

The rule that keeps it fast: **no new per-render work above about 1ms without a cache,
and every cache keyed by something cheap (a file mtime or size).** Do not add network
calls or un-cached subprocess spawns to the render.

To benchmark a change, run the script in a throwaway sandbox so it never touches your
real `~/.claude` or temp dir (the same isolation the tests use):

```bash
S=$(mktemp -d)
IN='{"model":{"display_name":"Opus 4.8"},"context_window":{"used_percentage":42}}'
for i in $(seq 1 30); do
  echo "$IN" | env HOME="$S" CLAUDE_CONFIG_DIR="$S/.claude" TMPDIR="$S/tmp" CCBSL_NO_ACT=1 COLUMNS=120 \
    node statusline.js >/dev/null
done
rm -rf "$S"
```

A render without those env overrides writes to your real `~/.claude` and real temp dir,
so always sandbox a benchmark.

## Ideas that would help

- A PowerShell version of `claude-profiles.sh` for Windows.
- Reorder / color editing in the `--config` editor.
- More segments people ask for, behind config flags.

## Maintainers

Merge rights and approvals rest with the project maintainers. If you'd like to
become one after a few solid contributions, say so in an MR.
