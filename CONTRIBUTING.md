# Contributing

Contributions are welcome: bug fixes, new segments, better platform support,
docs. Anyone can contribute; you don't need to be a maintainer. The only rule is
that every change lands through a pull request that a maintainer approves.

## How to contribute

1. Clone the repo (`git clone https://github.com/jordanallenlewis/ccrig.git`), or fork it,
   then make your change on a branch. (Users install from npm; the clone is for hacking on CCRig.)
2. Keep it **zero-dependency**: `statusline.js` runs on the Node that ships with
   Claude Code, with no npm install. The shell tooling targets bash and zsh.
3. Test locally before opening the PR (there is no per-push CI; the release workflow runs the
   full suite on macOS, Windows, and Linux at tag time, but the maintainer reviews locally, so
   please run these yourself first):
   - `npm test` (runs all three suites: `test-unit.js` + `test.js` + `test-gates.js`; the file list is
     pinned because a bare `node --test` on Node 22+ also picks up the mod's `tests/*.test.ts`)
   - `claude plugin validate .claude-plugin/plugin.json` and `claude plugin test` if you touched the mod
     (if `claude plugin test` says the rollout switch is off for your account, run it with
     `CLAUDE_CONFIG_DIR` pointed at an empty folder; the tests need no sign-in)
     (`hooks/`, `.claude-plugin/`, `tests/`); both run offline, with no session or sign-in
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

   The suite is hermetic (it never touches your real `~/.claude` or temp dir, pops no desktop
   notification, and makes no network call), and `.github/workflows/ci.yml` runs it on every push
   to main and every pull request on Node 18, 20, 22 and 24 (the supported floor is Node 18), on
   macOS, Linux, and Windows. A few tests that need a POSIX shell, git, or symlink privilege skip
   cleanly where those are missing rather than failing.

   `node .github/smoke.js` is the packaged smoke test CI also runs: it installs the tool the way users
   do (npm pack, global install, upgrade, uninstall; the curl copy), runs the installed commands
   through every shell Claude Code may use, and checks auto-resume and autoUpdate end to end. It uses
   the network (npm and the live registry), so it is not part of `node --test`.

   The mod (`hooks/ccrig.ts` and the pure helpers in `hooks/lib.ts`) has its own suite under `tests/`,
   run by `claude plugin test` from Claude Code's mod test kit: it raises the events Claude Code would
   raise, stubs what Claude Code would answer, and presses the buttons the mod draws. The mod never
   duplicates a CCRig decision: it hands `statusline.js` the status JSON (`CCRIG_HOST=mod` prints the
   segments as JSON) and forwards the guardian's hooks to `statusline.js --hook`, so a fix to the bar or
   the guardian lands in `statusline.js` and both installs get it.

   **A bug fix must ship with a test:** a unit test in `test-unit.js` if the logic is
   pure, a `REGRESSION:` test in `test.js` if it's behavioral. A new feature ships with
   tests for the happy path and the failure/edge cases.
4. Open a **pull request** describing the change and why. Reference an issue if
   one exists.
5. A maintainer reviews it. **A PR is merged only after a maintainer approves
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

The status line runs on every message and every few seconds between them (`refreshInterval` 5), so the render is a
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
calls or un-cached subprocess spawns to the render, and do not `require` `child_process`
or `tty` at the top of the file (they load `net` and `stream`, about 3ms).

The `perf:` tests in `test.js` hold the line: a warm render starts no process, stats the
transcript once, reads the burn-rate samples once, never reads `settings.json`, and stays
within 22 file system calls (counted by a preload, Node's own module loading included);
during a turn it reads only the bytes appended to the transcript. If a change needs more,
raise the number in the test and say why in the pull request.

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

- Reorder / color editing in the `--config` editor.
- More segments people ask for, behind config flags.

## Releasing

Releases take one command and no logins:

```bash
npm run release -- patch      # or minor, major, X.Y.Z; add --dry-run to preview
```

It refuses unless you are on `main`, the tree is clean, `main` matches `origin/main`, and
`CHANGELOG.md` has something under `## [Unreleased]`. Then it bumps every version together
(`statusline.js`, `package.json`, `.claude-plugin/plugin.json`, and the `marketplace.json` pin),
turns `[Unreleased]` into the dated section, runs `npm test` and the self-test (a failure undoes the
bump), commits, tags, and pushes the commit and tag in one atomic push. The marketplace pin on `main`
therefore never names a tag that does not exist yet.

The tag starts `.github/workflows/release.yml`: tests on macOS, Windows and Linux (Node 18 and 22, plus
the packaged smoke test), the mod suite, and a check that the tag is on `main` and matches every
manifest. Then two independent jobs run, each safe to re-run:

- **GitHub Release** from the changelog section, with `statusline.js` attached (the standalone install
  downloads it from `releases/latest`).
- **npm publish** with provenance through **Trusted Publishing** (OIDC). It skips a version already on
  npm. No npm token lives in the repo or on a laptop; publish rights come from the Trusted Publisher
  set up once on npmjs.com (package `ccrig`, GitHub user `jordanallenlewis`, repository `ccrig`,
  workflow `release.yml`).

The Claude Code mod needs no step of its own: `/plugin update ccrig@ccrig` follows the tag pinned in
`marketplace.json`. The Anthropic plugin directory follows the `release` branch, which a third job in
`release.yml` fast-forwards to each released tag (never to unreleased work on `main`); the directory then
scans the new version and publishes it according to the listing's publish setting.

## Maintainers

Merge rights and approvals rest with the project maintainers. If you'd like to
become one after a few solid contributions, say so in a PR.
