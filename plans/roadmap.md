# Roadmap

The consolidated, priority-ranked plan across all areas. Read [README.md](README.md) first for
project context and the hard constraints (C1–C11). This file is the sequencing + fan-out map + the
three cross-cutting tracks (correctness, performance, quality) + the human-decision open questions.

Every task ID here is stable and defined in its area plan. Severity/impact and the CONFIRMED
(repro) / CONFIRMED (code) status come from the area plans' audits; the adversarial-verification
pass over every claim is complete (39 confirmed, 1 refuted).

---

## 0. Highest-severity findings, up top

**The two things to fix first (highest severity × blast radius):**

1. **XPLAT-01 — `spawnDetached` unhandled `error` crashes the live render at critical usage** (HIGH,
   CONFIRMED, all platforms). A one-line fix (`child.on('error', () => {})`). The render dies exactly
   when the guardian is trying to help (a missing `notify-send` on headless Linux). See
   [xplatform.md](xplatform.md).
2. **CLI-01 — one-shot flags dispatch before the exclusivity gate** (HIGH, CONFIRMED). `--purge
   --install` purges and exits 0 without installing; `--disarm --purge` does neither. See
   [cli-installer.md](cli-installer.md).

**Also high:** CLI-02 (uninstall from a moved copy leaves guardian hooks wired — breaks the
reversibility promise, CONFIRMED code-decisive); and the **test-harness hermeticity holes**
(TEST-01/02/03) which are both a landmine (C10 — the suite deletes real user tmp state and, on
Windows, rewires real profiles) **and** the prerequisite for safely authoring every other regression
test.

**Biggest measured performance win:** PERF-01 — `gitCacheMs` 2500→10000 + `--no-optional-locks`
halves the git subprocess duty cycle (4/7 → 2/7 renders), cutting ~18ms→~9ms average per-render git
cost on a 2k-file repo. Measured, not vibes.

**One high-severity auditor claim was REFUTED and dropped:** the Guardian "sidechain leak." Real
Claude Code main transcripts contain zero `isSidechain` entries (all live in separate
`subagents/*.jsonl` files) — independently re-verified. It survives only as low-severity
defense-in-depth (GUARD-05).

---

## 1. Quick wins vs. deep work

**Quick wins (small, high-confidence, mostly one-file):**
- XPLAT-01 (spawnDetached error handler) — 1 line.
- RENDER-01 (config sanitization), RENDER-02 (null/hostile-input guard), RENDER-04 (bar 100%).
- CLI-01 (hoist the gate), CLI-04 (isOurCmd), CLI-03 (uninstall cleanup hoist), CLI-09 (honest
  summary).
- UPD-02 (fail-closed spawn), UPD-01 (staleness fix), UPD-04 (git-clone regex), UPD-06 (NO_PROXY),
  UPD-08 (--force repair), UPD-09 (strict version parse).
- GUARD-03 (ledger validation), GUARD-05 (sidechain guard), GUARD-06 (--status honesty).
- SHELL-01 (shellcheck directive), SHELL-06 (example sync), SHELL-07 (help flags), SHELL-03 (purge
  error-log), SHELL-04 (SECURITY data map).
- PERF-01 (git duty cycle), PERF-03 (perf budget doc).
- XPLAT-06 (win cd), XPLAT-07b (writeJsonAtomic tmp), XPLAT-09 (clock24).
- TEST-07 (export DEFAULTS/helpText).

**Deep work (medium effort, multi-file, or needs a pipeline):**
- RENDER-03 (glyphWidth — the width-correctness consolidation).
- CLI-06 (doctor path-checking across hooks + unquoted + slash-command).
- CLI-07 (install replacement notice + backup protection), CLI-08 (profile marker), CLI-10 (unknown-
  flag rejection).
- GUARD-01/02 (re-arm + watcher single-source-of-truth), GUARD-04 (win32 isOurWatcher).
- UPD-07 (signing-docs SSOT), UPD-05 (--dismiss-update).
- TEST-01/02/03 (hermetic harness), TEST-05 (guardian-runtime tests), TEST-06 (proxy/unit coverage),
  TEST-08 (CI matrix + non-root + junit), TEST-09 (gap tests), TEST-10 (shard), TEST-11 (coverage).
- SHELL-02 (profile-name validation, bash+zsh tests).
- XPLAT-04 (WinRT toast + injection fix).
- GATE-01/02/03/04 (the unified quality gate).

---

## 2. Dependency-ordered sequence (waves)

Do the waves in order. Within a wave, tasks are independent (see the fan-out map for worktree
grouping). Each wave ends by re-running the full check (`node --test && node statusline.js
--selftest && node --check statusline.js`).

**Wave 0 — unblock the harness (must be first).**
- TEST-01 + TEST-02 (hermetic `run()` + isolated `SCRIPT`) — one worktree, `test.js`.
- TEST-03 (gate `relaunchResume` on `CCBSL_NO_ACT`) — `statusline.js`.
- TEST-07 (export `DEFAULTS`/`DEFAULT_ORDER`/`MODES`/`helpText`) — `statusline.js`.
- *Rationale:* every later regression test needs a hermetic harness; TEST-03 unblocks all guardian-
  runtime tests; TEST-07 unblocks the quality gates. Nothing else should land before Wave 0.

**Wave 1 — the HIGH bugs + render quick wins.**
- XPLAT-01 (render crash guard), CLI-01 (flag gate), CLI-04 (isOurCmd, unblocks CLI-02/05).
- RENDER-01 (config sanitize), RENDER-02 (input guard).
- *All edit `statusline.js`* → worktree isolation, merge sequence per the fan-out map.

**Wave 2 — safety-envelope + width + guardian state machine.**
- CLI-02, CLI-05 (consume CLI-04), CLI-06 (doctor), CLI-07, CLI-08, CLI-03, CLI-09, CLI-10, CLI-11.
- RENDER-03 (glyphWidth; also closes XPLAT-05), RENDER-04, RENDER-05.
- GUARD-01, GUARD-02 (need TEST-03), GUARD-03, GUARD-04 (=XPLAT-03), GUARD-05, GUARD-06.
- XPLAT-04, XPLAT-06, XPLAT-07b, XPLAT-08b, XPLAT-09.

**Wave 3 — update subsystem + perf.**
- UPD-01, UPD-02, UPD-03, UPD-04, UPD-05, UPD-06, UPD-08, UPD-09.
- UPD-07 (signing docs + `updatePubkey` in DEFAULTS) — coordinate the `DEFAULTS` line with RENDER-01
  and PERF-01.
- PERF-01 (git duty cycle; `DEFAULTS` line), PERF-02 (fold, if touching collectSegments), PERF-03
  (doc).

**Wave 4 — docs accuracy + the quality-gate track (each gate with its fix).**
- SHELL-01 (shellcheck directive), SHELL-02 (+ SHELL-05), SHELL-03, SHELL-04, SHELL-06, SHELL-07.
- GATE-01 (green immediately), then GATE-02 **with** SHELL-06+UPD-07, GATE-03 **with** UPD-07, GATE-04
  **with** SHELL-07 + README flag additions. (A gate must merge in the same MR as its fix — the one
  hard ordering constraint of this track.)
- TEST-09 (gap tests), TEST-06 (proxy/unit coverage).

**Wave 5 — CI + optional.**
- TEST-08 (Node 18/20/22 matrix, non-root, junit, hard shellcheck — needs SHELL-01; owner-run in a
  pipeline). XPLAT-07 is TEST-08's node:18 leg.
- TEST-11 (coverage), TEST-10 (shard test.js — only after Wave 0 hermeticity).
- XPLAT-08 (README Windows note).

---

## 3. Fan-out map (what can run in parallel; where worktree isolation is mandatory)

**The governing hazard (C11):** `statusline.js` is one file edited by almost every code task. `test.js`
is edited by almost every regression test. Parallel edits to the same file **require git-worktree
isolation + a merge step**, or must be sequenced. Below, tasks grouped by the file they mutate; within
a group, sequence or use one worktree; across groups, fully parallel.

**Group A — `statusline.js` (the contended file).** Serialize by region to minimize merge conflicts:
- *`DEFAULTS`/`loadConfig` region (lines ~89–215):* RENDER-01, UPD-07 (`updatePubkey` line), PERF-01
  (`gitCacheMs`). **One worktree, one MR** — they touch adjacent lines.
- *`dispWidth`/`truncFolder`/`bar` (~234–295):* RENDER-03, RENDER-04, RENDER-05. One worktree.
- *guardian render-adjacent (~372–852):* GUARD-01, GUARD-03, GUARD-05. Sequence 01 first.
- *update stack (~854–1101):* UPD-01/02/03/04/06/08/09. Mostly disjoint functions → parallel worktrees
  ok; UPD-01+UPD-02 share `maybeCheckUpdate` → sequence.
- *`collectSegments` (~1258–1335):* RENDER-02 (input coercion), PERF-02 (fold). Coordinate.
- *guardian runtime (~1421–1659):* GUARD-02, GUARD-04, GUARD-06, TEST-03, XPLAT-01 (`spawnDetached`
  is at 622 — separate), XPLAT-06 (`runSessions`/`writeResumeTicket`), XPLAT-07b (`writeJsonAtomic`).
  Mostly disjoint → parallel; GUARD-02+GUARD-01 coordinate.
- *CLI/installer (~1660–2311):* CLI-01..11, CLI-06/XPLAT-08b share `runDoctor`; CLI-11/XPLAT-06 share
  `runSessions`; CLI-03/CLI-05/CLI-02 share `uninstallFrom`; SHELL-03/CLI-11 share `runPurge`.
  Sequence the shared-function pairs; parallelize the rest.
- *export block (~1369–1374):* TEST-07 — do once in Wave 0, everyone rebases onto it.

**Group B — `test.js`.** Every REGRESSION appends here. To avoid constant conflicts: land TEST-01/02
first (Wave 0), then have each area append its own REGRESSION block in its own worktree; the
coordinator merges append-only (low conflict). Or serialize test additions per wave.

**Group C — independent files (fully parallel, no `statusline.js` contention):**
- `test-gates.js` (new): GATE-01/02/03/04.
- `test-unit.js`: RENDER-03/04/05 units, UPD-03/06/09 units, GUARD-04 unit, XPLAT-04 unit, TEST-06.
- `claude-profiles.sh`: SHELL-01/02/05.
- `.gitlab-ci.yml`: TEST-08/11, SHELL-01's `allow_failure` removal, GATE-01's `--check` line.
- docs (`README.md`/`SECURITY.md`/`CONTRIBUTING.md`/`CHANGELOG.md`/`statusline.config.example.json`):
  SHELL-03/04/06, UPD-07, PERF-01/03, XPLAT-08/09 doc mirrors. Coordinate `statusline.config.example.json`
  edits (SHELL-06, UPD-07, PERF-01, XPLAT-09 all touch it) into one worktree.

**Concurrency ceiling reminder:** the biggest safe parallel fan-out is Group C (independent files) +
one worktree per Group-A region. Do not run two Group-A region worktrees that touch the same region
concurrently without a merge plan.

---

## 4. Cross-cutting track: CORRECTNESS (every known bug-fix, with status)

Ordered by severity. Status: **CONFIRMED (repro)** = reproduced in a sandbox by an independent
verifier (or the orchestrator); **CONFIRMED (code)** = code-decisive (Windows-only or traced).
The adversarial-verification pass is complete: every row below was independently re-checked.
Each carries a regression test (C5).

| Task | Bug | Severity | Status |
|---|---|---|---|
| XPLAT-01 | `spawnDetached` unhandled error crashes render at critical usage | HIGH | CONFIRMED (repro) |
| CLI-01 | one-shot flags bypass the exclusivity gate | HIGH | CONFIRMED (repro) |
| CLI-02 (+CLI-04) | uninstall from a moved copy leaves guardian hooks | HIGH | CONFIRMED (code) |
| RENDER-01 | non-numeric `reserveCols` disables wrapping | medium | CONFIRMED (repro) |
| RENDER-03 | `dispWidth` undercounts CJK/wide → overflow | medium | CONFIRMED (repro) |
| CLI-05 (+CLI-04) | uninstall deletes a live 3rd-party `statusline.js` | medium | CONFIRMED (repro) |
| CLI-06 | doctor false-passes dead unquoted cmd + unchecked hook paths | medium | CONFIRMED (repro) |
| CLI-07 | install stomps a foreign statusLine + destroys its backup | medium | CONFIRMED (repro) |
| CLI-08 | `detectProfiles` wires foreign `~/.claude-*` tool dirs | medium | CONFIRMED (repro) |
| GUARD-01 | second limit / window switch never re-arms | medium | CONFIRMED (repro) |
| GUARD-04 / XPLAT-03 | win32 `isOurWatcher` kills a recycled PID (C8) | medium | CONFIRMED (code) |
| UPD-01 | dead 30-day staleness guard (badge nags forever) | medium | CONFIRMED (repro) |
| UPD-02 | unwritable CFG → per-render spawn+network storm (C2) | medium | CONFIRMED (repro) |
| XPLAT-04 | win32 notify PowerShell injection + silent no-op | medium | CONFIRMED (code) |
| SHELL-01 | shellcheck SC2148 (verify cmd + CI job red) | medium | CONFIRMED (repro) |
| SHELL-02 | `claude-profile` name traversal (`rm -rf` outside HOME) | medium | CONFIRMED (repro) |
| SHELL-03 | `--purge` never removes `statusline-error.log` (C7 overclaim) | medium | CONFIRMED (repro) |
| TEST-01 | suite deletes real tmp state / leaks host env (C10) | high (process) | CONFIRMED (repro) |
| TEST-02 | repo-local config breaks the suite | high (process) | CONFIRMED (repro) |
| TEST-03 | `CCBSL_NO_ACT` doesn't gate `relaunchResume` | medium (process) | CONFIRMED (repro) |
| RENDER-02 | null/hostile stdin crashes to the error banner | low | CONFIRMED (repro) |
| RENDER-04 | usage bar saturates before 100% | low (quality) | CONFIRMED (repro) |
| GUARD-03 | `pickFreshProfile` traversal into `CLAUDE_CONFIG_DIR` | low | CONFIRMED (repro) |
| UPD-03 | redirects follow any scheme (file:// / downgrade) | low | CONFIRMED (repro) |
| UPD-04 | `isOurGitClone` substring match pulls wrong repo | low | CONFIRMED (repro) |
| UPD-06 | `NO_PROXY *.example.com` ignored | low | CONFIRMED (repro) |
| UPD-08 | `--update --force` can't repair the current version | low | CONFIRMED (repro) |
| UPD-09 | non-x.y.z remote version silently missed | low | CONFIRMED (repro) |
| CLI-03 | uninstall leaves slash command when statusLine foreign | low | CONFIRMED (repro) |
| CLI-09 | install summary contradicts itself when a profile skipped | low | CONFIRMED (repro) |
| XPLAT-06 | `--sessions` POSIX `cd` fails on Windows shells | low | CONFIRMED (repro) |
| XPLAT-07b | `writeJsonAtomic` strands `.tmp` on rename fail | low | CONFIRMED (repro) |
| XPLAT-08b | doctor `where claude` accepts un-spawnable `.cmd` shim | low | CONFIRMED (code) |
| GUARD-05 | (defense-in-depth) sidechain turns — **not a live bug** | low | REFUTED as high; kept as insurance |
| SHELL-04/06/07 | SECURITY data map / example drift / help flags | low | CONFIRMED (repro) |

Every row's fix ships with the failing-before/passing-after test named in its area plan (C5).

---

## 5. Cross-cutting track: PERFORMANCE (every optimization, with its measured target)

| Task | Change | Baseline (measured) | Target | Proof | Worth it |
|---|---|---|---|---|---|
| PERF-01 | `gitCacheMs` 2500→10000 + `--no-optional-locks` | 4/7 renders spawn git; git 32.3ms (2k)/64.7ms (20k); render 62.5→91.3ms on a miss | ≤2/7 renders spawn git; ~18→~9ms avg git/render (2k) | 7×`sleep 2` loop counting `execSync` (≤2); `test.js` cache-sentinel REGRESSION | **yes** |
| PERF-02 | fold duplicate `inflightAgents` call | 2 fs ops + 0.04ms | 1 fs op | instrumented op count | only if touching `collectSegments` |
| PERF-03 | perf-budget doc + sandboxed bench recipe | n/a (doc) | protects the ~1ms/render rule (C3) | docs-voice gate | yes (cheap) |

**Everything explicitly NOT optimized (measured, bounded, do-not-build):** node boot / 137KB parse
(~52ms, no in-script fix), `computeInflightAgents` (768KB-capped, 1.9ms), `settingsVal`/
`detectProfiles`/`contextPct`/sample reads (<0.3ms combined), streaming transcript parser,
`NODE_COMPILE_CACHE` injection. See [perf.md](perf.md) §4 for the numbers. The render is
Node-startup-dominated; there is exactly one worthwhile in-script win.

---

## 6. Cross-cutting track: QUALITY GATES (the second directive)

Definition of done: **a quality failure on any of the three authored surfaces is mechanically
impossible to ship.** One new file, `test-gates.js`, one shared rule source, auto-discovered by
`node --test` (no CI job change; one `--check` line). See [quality-gates.md](quality-gates.md).

| Surface | Gate | Task | Lands with |
|---|---|---|---|
| Rendered bar | `bar()`/`dispWidth()` units + `--selftest` CJK | RENDER-03/04/05 | render-core |
| CLI text | behavioral asserts + literal scan | CLI-09/11 + GATE-01 | cli-installer + gates |
| Docs + literals | em-dash + AI-tell scan | GATE-01 | green today |
| Config SSOT | example-vs-`DEFAULTS` parity | GATE-02 | SHELL-06 + UPD-07 |
| Config SSOT | `CONFIG.<key>` reads exist in `DEFAULTS` | GATE-03 | UPD-07 |
| Flags | README↔`helpText` parity | GATE-04 | SHELL-07 + README additions |

**The one hard ordering rule:** GATE-02/03/04 must each merge in the same MR as their fix, or CI goes
red on arrival. GATE-01 is green today. The shared `BANNED` rule source in `test-gates.js` is the
single evolving definition of "bad" across the docs and CLI-literal scanners (directive requirement).

---

## 7. Open questions for the human (decisions the executor must NOT make)

1. **RENDER-05 taste call:** should the usage bar track the `warn` threshold (plan's choice — 81–89%
   is yellow) or *lead* the label as an early-warning cue (keep today's behavior, just document the
   gap)? Reversible either way; lowest priority.
2. **CLI-02 ownership breadth:** confirm `--uninstall` should strip guardian hooks belonging to *any*
   Rig install (by name), not only the running copy. The plan chooses "by name" to honor the
   reversibility promise. (See [cli-installer.md](cli-installer.md) §9.)
3. **CLI-09 exit code:** should `--install` exit 1 on a partial success (a skipped profile)? The plan
   aligns it with `--uninstall` (exit 1). If the one-line installers depend on exit 0, fix only the
   wording.
4. **UPD-07 is a SECURITY.md correction** (the docs currently deny a signature feature the code
   ships). Owner should review the wording — it is a trust document.
5. **Official release signing** (separate from UPD-07's opt-in docs): does the owner want to generate
   an Ed25519 key, sign each release's `statusline.js.sig` in CI, and publish the public key? The plan
   documents the *mechanism* but does not assume the *operation*.
6. **`gitCacheMs` 10000 staleness** (PERF-01): confirm ~10–12s branch/dirty staleness is an acceptable
   trade for halving the git subprocess rate. The plan judges it clearly worth it.
7. **Windows CI:** does the owner have (or want) a GitLab Windows runner? If yes, the win32-skipped
   regressions (GUARD-04, XPLAT-06/08b) can be un-skipped there. If no, the plan relies on
   code-decisive fixes + the `USERPROFILE`/`notifySpec` unit gates.
8. **XPLAT-04 scope:** full WinRT toast, or injection-fix-only (keep BurntToast as the shower, accept
   the silent-no-op-on-stock-Windows as a documented limitation)? Owner's call on maintenance appetite
   for a PowerShell/WinRT snippet.
9. **`CHANGELOG.md:89` puffery** ("Hardened by many adversarial-review passes"): soften or keep? The
   docs-voice gate does not flag it.
10. **TEST-08 non-root CI** (`su node`) may fight the GitLab runner (cache/artifact permissions);
    owner should verify in a pipeline and choose the fallback if it does.

---

## 8. Housekeeping note (not a plan task)

During the audit, a subagent's mis-quoted sandbox env (a zsh word-splitting quirk) ran `--purge` and
`--uninstall` against the **real** `~/.claude`. It was repaired and **verified intact** by the
orchestrator: `settings.json` has the statusLine wired, all guardian hooks present, the slash command
restored, no `.tmp` orphans. The stray `~/.claude/guardian/*.watch.pid` (9736) is **this** session's
own guardian watcher — expected, not a leak. Some `ccbsl-*`/`ccsl-test-*` scratch dirs may remain in
the system `$TMPDIR` from test runs; they are harmless and self-expire under the 14-day retention
sweep. No action required; noted for transparency. This incident is itself the strongest argument for
TEST-01 (C10) landing first.
