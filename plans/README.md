# Rig enhancement plans — front door

This directory is an executor-ready plan hierarchy for **Rig** (the repo at the root of this
checkout, package/CLI name `ccrig`, current `VERSION = '1.0.1'` at `statusline.js:70`). It was
produced by a survey + parallel audit of the actual code, not from assumption. Every concrete
claim below is anchored to a real file and line, and every bug was reproduced in a sandbox or is
decisive by code inspection (the two are labelled).

Read this file first. Then open the one area plan you are assigned. Each area plan is
self-contained: it restates everything its executor needs and does not depend on having read the
others.

---

## 1. What this repo is (project-context brief)

Rig is a **single-file, zero-dependency Node status line for [Claude Code](https://claude.com/claude-code)**,
plus an opt-in "Guardian" that acts on usage limits. It is aimed at people who run Claude Code all
day, often across multiple accounts (profiles) and worktrees.

- **The whole product is `statusline.js`** (2331 lines). Claude Code invokes it every ~2 seconds
  (and after every message) with a JSON blob on stdin; the script prints one terminal status line.
  There is no build step, no bundler, no `node_modules`. It runs on the Node that ships with Claude
  Code (README claims **Node 18+**).
- **The render makes zero network calls.** Everything shown is read from Claude Code's own stdin
  JSON (`rate_limits`, `context_window`, `effort`, model, flags) plus local files (`git status`,
  the transcript tail, the config). The *only* network anywhere is an optional once-a-day update
  check that runs in a detached child process.
- **The Guardian** (opt-in, `--install-guardian`) wires three Claude Code hooks (`Stop`,
  `SessionStart`, `PreCompact`) plus a detached watcher that can auto-resume a session when a usage
  limit resets. All of it reads the same stdin/transcript and is fully reversible.
- Supporting files: `test.js` (105 black-box tests that spawn the real script in throwaway
  sandboxes), `test-unit.js` (13 unit tests that `require()` the script's exported helpers),
  `claude-profiles.sh` (a sourced bash/zsh profile switcher), `install.sh` (a 7-line wrapper),
  `statusline.config.example.json` (a hand-mirrored copy of the config defaults), and the docs
  (`README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`). CI is GitLab
  (`.gitlab-ci.yml`).

**Core purpose, in one line:** make Claude Code pleasant to run all day — show the operational
state at a glance, and never lose work to a usage limit. The **flagship** is the render pipeline
(the status bar itself); the Guardian is the highest-value differentiator built on top of it.

---

## 2. Capability map (subsystem → what it does → health → where it lives)

| Subsystem | What it does today | Health | Home (in `statusline.js` unless noted) | Plan |
|---|---|---|---|---|
| **Render core** | Reads stdin JSON, builds ~18 segments, wraps to terminal width, prints. The product surface. | good | `64-370` (config, width, bar, fmtReset), `1104-1359` (segments, `collectSegments`, `render`), `2313-2331` (main path) | [render-core.md](render-core.md) |
| **CLI + installer** | `--install`/`--uninstall`/`--doctor`/`--config`/`--board`/`--sessions` and the argv dispatcher; wires `settings.json` for every profile. | good | `1360-1420`, `1660-2311` | [cli-installer.md](cli-installer.md) |
| **Guardian** | Checkpoints, the `Stop`/`SessionStart`/`PreCompact` hooks, the auto-resume watcher, forecast, ledger/board writers. | good | `372-852`, `1421-1659` | [guardian.md](guardian.md) |
| **Update** | Once-a-day version check, `--update` download/validate/swap, a zero-dep HTTP(S)+proxy stack, optional Ed25519 signature gate. | good | `854-1101` | [update.md](update.md) |
| **Tests + CI** | `node --test` (both suites) + GitLab CI (`node:22` only, shellcheck soft-gated). | good | `test.js`, `test-unit.js`, `.gitlab-ci.yml` | [tests-ci.md](tests-ci.md) |
| **Shell + docs** | The profile switcher, the installer wrapper, and every authored document. | good | `claude-profiles.sh`, `install.sh`, `*.md`, `statusline.config.example.json` | [shell-docs.md](shell-docs.md) |
| **Cross-platform** | Windows/Linux/macOS correctness of notify, watcher PID handling, path/quoting, the Node floor. | good | scattered win32/POSIX branches | [xplatform.md](xplatform.md) |
| **Performance** | The per-2s render hot path and its filesystem/subprocess budget. | strong | render path + `gitProbe` `1217-1234` | [perf.md](perf.md) |
| **Quality gates** (cross-cutting) | Mechanical gates for the three authored output surfaces (rendered bar, CLI text, docs) so taste failures cannot ship. | *does not exist yet* | proposed `test-gates.js` | [quality-gates.md](quality-gates.md) |

Overall the codebase is in good shape: it is defensively written, has a real test suite (124
tests, all passing, ~13s), and its author has already run several adversarial-review passes. The
work below is **enhancement**: fixing a set of real correctness bugs (most cosmetic-to-medium, two
genuinely high), hardening the install/uninstall safety envelope, closing test-harness hermeticity
holes, one measured performance win, and installing the mechanical quality gates the docs doctrine
currently relies on humans to enforce.

---

## 3. Hard constraints (the landmines — stated once, enforced everywhere)

These are the invariants that silently break the project or its process if violated. Every area
plan bakes the relevant ones into its acceptance criteria. **Verify each against the cited file
before trusting it; do not add to this list without the same discipline.**

- **C1 — Zero dependencies, stock Node 18+.** No `npm install`, no `node_modules`, no non-builtin
  `require`. `statusline.js`, `test.js`, `test-unit.js` use only Node builtins. The README promises
  Node 18+ (`README.md:43`); CI currently only tests `node:22` (`.gitlab-ci.yml:6`). Any new API
  must exist on Node 18. (Verified: `grep` finds no post-18 API in the current source; the suite
  passes on Node 18.15.0.)
- **C2 — The render path makes zero network calls.** `render`/`collectSegments` and everything they
  call must not open a socket. Only the detached `--check-update` child (`spawnDetached` at
  `statusline.js:897`) may touch the network. (Verified by instrumenting `fs`/`child_process`: a
  steady render does zero `connect`.)
- **C3 — The render is a hot path (~2s cadence).** No new per-render work above ~1ms without a
  cache, and every cache must be keyed by something cheap (mtime or size). Measured floor: Node
  interpreter boot ~47–55ms is ~75% of the ~60–95ms render wall; script-attributable JS is
  ~8–12ms. The one recurring cost worth touching is the git subprocess (see [perf.md](perf.md)).
- **C4 — New behavior is config-gated and OFF by default,** documented in `README.md` **and**
  mirrored into `statusline.config.example.json`. Bug *fixes* (width correctness, crash guards) are
  not new behavior and need no gate.
- **C5 — Every bug fix ships with a test.** Pure logic → a case in `test-unit.js`; behavioral → a
  `REGRESSION:`-prefixed test in `test.js`. A fix without a failing-before/passing-after test is
  incomplete (`CONTRIBUTING.md:26-29`).
- **C6 — The config SSOT is the `DEFAULTS` object** at `statusline.js:93-167` (plus `DEFAULT_ORDER`
  `:89`, `MINIMAL_KEEP` `:91`, `MODES` `:92`). `statusline.config.example.json` is a **hand-mirrored
  copy** and drifts; `saveConfig` (`:2258`) persists only the diff from `DEFAULTS`. Editing a
  consumer of a default instead of `DEFAULTS` is the classic bug here. **Real drift exists today**
  (see below) — a mechanical gate is planned in [quality-gates.md](quality-gates.md).
- **C7 — Everything on disk is local, reversible, and backed up.** Writes stay under
  `$CLAUDE_CONFIG_DIR` (or, only when opted in, the shared `~/.claude-usage-ledger` /
  `~/.claude-rig-sessions`). Destructive edits back up first (`backupSettings` `:1787`). `--purge`
  (`:1648`) and `--uninstall` (`:2028`) must stay total and honest about what they remove.
- **C8 — Process safety: never `process.kill` a PID you have not confirmed is our watcher.** The
  guard is `isOurWatcher` (`:1603`). It is sound on POSIX (a `ps` cmdline check) but
  **unconditionally returns `true` on win32** (`:1605`) — a real recycled-PID hazard (see
  [xplatform.md](xplatform.md) / [guardian.md](guardian.md)).
- **C9 — The verification vocabulary** (use these exact commands as acceptance criteria, never
  "run the tests"):
  - `node --test` — runs **both** suites (`test.js` + `test-unit.js`), 124 tests today.
  - `node statusline.js --selftest` — edge-case render/wrap check.
  - `node --check statusline.js` (and on `test.js`, `test-unit.js`) — syntax gate.
  - `shellcheck claude-profiles.sh install.sh` — shell lint (**currently failing SC2148**; see
    [shell-docs.md](shell-docs.md)).
- **C10 — Test hermeticity is currently incomplete and is itself a landmine.** `test.js` sandboxes
  `HOME`/`CLAUDE_CONFIG_DIR` but **not** `TMPDIR` and **not** `USERPROFILE`; the `--purge` test
  deletes real user tmp state, and on Windows the install tests would rewire a contributor's real
  profiles. **Consequence for executors: never run `statusline.js` — including `--demo` — or the
  test suite outside a sandbox that also overrides `TMPDIR` and (on Windows) `USERPROFILE`, with
  `CCBSL_NO_ACT=1`.** This exact hazard already caused an incident during the audit (a mis-quoted
  env var ran `--purge`/`--uninstall` against the real `~/.claude`; it was repaired and verified).
  Fixing it is [tests-ci.md](tests-ci.md) TEST-01/02.
- **C11 — Process rule: plans only.** Do not build/deploy/push/commit as part of executing a plan
  unless the plan's final step explicitly flags a human-run verification. `main` is the working
  branch; branch before any change. Do not edit generated/gitignored files by hand
  (`statusline.config.json` and `*.bak` are gitignored per `.gitignore`).

**The single biggest fan-out hazard:** `statusline.js` is one 2331-line file and is the shared
mutation point of almost every code plan. Two workstreams that both edit `statusline.js` **must**
use git-worktree isolation and a merge step, or be sequenced. Each area plan calls out exactly
which of its tasks touch `statusline.js` and where.

---

## 4. Second directive: output-surface quality gates (ACTIVE)

Rig produces **authored output surfaces**, so the cross-cutting quality-gate directive applies.
The surfaces are:

1. **The rendered status bar** — colored, wrapped terminal text. Owned by [render-core.md](render-core.md).
   Its taste failures are *mechanical*, not stylistic: bars that saturate before 100%, width
   miscounts that overflow narrow terminals, color that leads the text by a tier. Gated by
   `--selftest` (extended) + unit assertions on `bar()`/`dispWidth()`.
2. **CLI text output** — `--help`, `--doctor`, `--install`, `--options`, `--board`, etc. Owned by
   [cli-installer.md](cli-installer.md). Failures: contradictory summaries, unaligned columns,
   destructive commands that don't name their target.
3. **Authored docs** (`*.md`) and the CLI string literals. Owned by [shell-docs.md](shell-docs.md).
   The repo's own doctrine (`CHANGELOG.md` Unreleased) is a **plain human voice with no em-dashes
   and no AI-tell vocabulary**. Audit finding: the docs and CLI literals are **currently clean**
   (zero em-dashes, zero tell-words in `.md` files and string literals; the 11 em-dashes in
   `statusline.js` are in source *comments*, outside the doctrine's stated scope). But there is **no
   mechanical gate**, so it rests on vigilance.

The fix for a recurring taste failure is a scanner, not a one-time cleanup. [quality-gates.md](quality-gates.md)
specifies a **single new file `test-gates.js`** (auto-discovered by `node --test`, so no CI change)
that unifies four gates behind one evolving rule source: docs-voice (em-dash + tell-word),
example-config-vs-`DEFAULTS` drift, `CONFIG.<key>`-reads-exist-in-`DEFAULTS`, and README↔`--help`
flag parity. Landing it green requires fixing the **real drift that exists today**: the example
config is missing `show.update`, `color.update`, `color.agents` and README omits `--status`,
`--disarm`, `--selftest`. Definition of done for this track: a quality failure on any of the three
surfaces is mechanically impossible to ship.

---

## 5. Ranked order of work (why this order)

Ranked by (severity × blast-radius) then (unblocks-other-work) then (effort). Detailed
task-level sequencing and the fan-out map are in [roadmap.md](roadmap.md).

1. **Test-harness hermeticity** ([tests-ci.md](tests-ci.md) TEST-01..04) — *do this first.* Until
   the suite stops touching real `TMPDIR`/`USERPROFILE` and `CCBSL_NO_ACT` actually gates
   `relaunchResume`, every other plan's regression tests are unsafe to author and run. This
   unblocks everyone.
2. **The two HIGH correctness bugs that break the safety envelope** ([cli-installer.md](cli-installer.md)
   CLI-01 flag-gate bypass, CLI-02 uninstall ownership asymmetry) and the **HIGH render-crash**
   ([xplatform.md](xplatform.md) XPLAT-01 `spawnDetached` unhandled error → live render dies at
   critical usage).
3. **Render correctness quick wins** ([render-core.md](render-core.md) RENDER-01 config
   sanitization, RENDER-02 null-stdin/hostile-input guard) — smallest, highest-confidence fixes.
4. **The unified width fix** ([render-core.md](render-core.md) RENDER-03 `glyphWidth`) — restores
   the wrap guarantee for CJK/emoji; consolidates two bugs into one helper.
5. **Installer/doctor safety hardening** ([cli-installer.md](cli-installer.md) CLI-03..09).
6. **Guardian state-machine fixes** ([guardian.md](guardian.md)) and **update fixes** ([update.md](update.md)).
7. **The measured performance win** ([perf.md](perf.md) PERF-01 git duty-cycle).
8. **Cross-cutting quality-gate track** ([quality-gates.md](quality-gates.md)) + the doc/example
   syncs it depends on ([shell-docs.md](shell-docs.md)).
9. **CI matrix + cross-platform** ([tests-ci.md](tests-ci.md) TEST-08, [xplatform.md](xplatform.md)).

---

## 6. Cross-subsystem dependency graph (which plan unlocks which)

```
tests-ci: TEST-01/02 (hermetic run())  ──unblocks──▶  every regression test in every plan
tests-ci: TEST-03 (CCBSL_NO_ACT gates relaunchResume) ──unblocks──▶ guardian watcher tests (GUARD-*, TEST-05)
tests-ci: TEST-07 (export DEFAULTS/DEFAULT_ORDER/MODES/helpText) ──unblocks──▶ quality-gates GATE-01..04
                                                                  └─────────▶ shell-docs SHELL-06 (drift fixes)

cli-installer: CLI-04 (isOurCmd unified predicate) ──unblocks──▶ CLI-02 (uninstall asymmetry) + CLI-05 (3rd-party delete) + CLI-06 (doctor path-check)

render-core: RENDER-03 (glyphWidth helper) ── same fix as ──▶ xplatform XPLAT-05 (CJK dispWidth)  [DO NOT double-implement]

quality-gates: GATE-02 (config-drift gate) ── must land WITH ──▶ shell-docs SHELL-06 (fix the drift) so the gate is green
quality-gates: GATE-04 (flag-parity gate)  ── must land WITH ──▶ shell-docs SHELL-07 (add --status/--disarm/--selftest to README)

perf: PERF-01 (gitCacheMs 2500→10000) ── touches DEFAULTS + example ──▶ coordinate with any RENDER-01 edit to loadConfig/DEFAULTS (same file region)
```

**Shared-file coordination (worktree isolation required):** `statusline.js` is edited by
render-core, cli-installer, guardian, update, xplatform, perf, and the export prereq for
quality-gates/tests-ci. `test.js` is edited by nearly every plan (regression tests).
`statusline.config.example.json` is edited by render-core (RENDER-01 doc mirror), perf (PERF-01),
shell-docs (SHELL-06), update (UPD-07). See [roadmap.md](roadmap.md) §"Fan-out map" for the exact
concurrency-safe grouping.

---

## 7. Index

- **[render-core.md](render-core.md)** — flagship. Width correctness, config sanitization, hostile-input hardening, the bar, the rendered-surface quality read.
- **[cli-installer.md](cli-installer.md)** — the two HIGH bugs, install/uninstall/doctor safety, the CLI-text surface.
- **[guardian.md](guardian.md)** — checkpoint state machine, watcher, the sidechain question (verified low, not high), ledger traversal hardening.
- **[update.md](update.md)** — the dead 30-day nag guard, the spawn-storm, redirect/proxy hardening, the signing-docs SSOT drift.
- **[tests-ci.md](tests-ci.md)** — hermetic harness (the unblocker), guardian-runtime coverage, CI Node matrix, coverage.
- **[shell-docs.md](shell-docs.md)** — shellcheck gate, profile-name validation, doc-accuracy fixes, config/example sync.
- **[xplatform.md](xplatform.md)** — the render-crash HIGH, Windows notify/PID/quoting, the Node-18 floor.
- **[perf.md](perf.md)** — the one measured win (git duty cycle) and the honest "do-not-optimize" list.
- **[quality-gates.md](quality-gates.md)** — cross-cutting: the unified `test-gates.js`.
- **[roadmap.md](roadmap.md)** — the consolidated, priority-ranked, fan-out-mapped sequence + the correctness track, the performance track, and the human-decision open questions.

---

## 8. Verification-status note

The adversarial-verification pass is **complete**. All 40 unique bug claims from the audit were
independently re-checked by separate verifier agents instructed to refute them (a usage limit
interrupted the first pass after 11; the remaining 29 were re-run after the reset — the interruption
and pickup were themselves handled by this repo's own Guardian, which checkpointed and auto-resumed
the run). Final tally: **39 CONFIRMED, 1 REFUTED, 0 uncertain.** Every bug promoted into an area
plan is labelled either **CONFIRMED (reproduced)** — the failure was observed in a sandbox — or
**CONFIRMED (code-decisive)** — proven by tracing the exact lines (used for Windows-only bugs that
cannot run on the macOS audit host). The one **REFUTED** claim was the Guardian "sidechain leak":
real Claude Code main transcripts contain **zero** `isSidechain` entries (all such entries on the
audit host live in separate `subagents/*.jsonl` files) — refuted independently twice, and kept only
as low-severity defense-in-depth in [guardian.md](guardian.md) (GUARD-05).
