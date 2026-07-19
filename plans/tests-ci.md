# tests-ci

The test harness and CI. **This plan is the unblocker: TEST-01/02/03 must land before the
regression tests in every other area can be authored and run safely.** Self-contained.

---

## 1. Current-state audit

**Structure.** A two-file, zero-dependency `node:test` suite plus a 2-job GitLab CI.
- `test.js` (1345 lines, 105 tests) — black-box. Helpers: `SCRIPT` const (`21`, points at the repo's
  `statusline.js`), `sandbox()` (`29`), `scriptCopy()` (`36`, for config-variant runs), `run()`/
  `render()` (`42-55`, spawn the real script with `HOME`/`CLAUDE_CONFIG_DIR`/`CCBSL_NO_ACT`
  sandboxing, 15s `spawnSync` timeout). Sections: rendering, profile badge, warnings + resume
  tickets, hostile-config fuzz (`270`), display modes, install/uninstall/doctor/CLI, git, caveman,
  guardian (hooks, checkpoints, forecast, ledger, installers), update system incl. Ed25519 signing
  (`845-866`, `1321-1334`), board/sessions/reinject, order migration.
- `test-unit.js` (166 lines, 13 tests) — `require()`s `statusline.js` (exports at `1369-1374`),
  covers `semverGt`, `modelTier`, `parseRemoteVersion`, `parseChangelogTop`, `dispWidth`, `deepMerge`,
  `truncFolder`, `fmtReset` (2 cases), `inflightAgents`, `resumePromptFromCheckpoint`, `fetchText`
  (real HTTP GET + 302, 500, local path), `bar`.
- `.gitlab-ci.yml` — one `node:22` job (`node --check` ×3, `--selftest`, `node --test`) + a
  `shellcheck` job with `allow_failure: true`.

**Measured:** 124/124 pass, ~12.7s wall; per-test TAP durations sum ≈ the wall time, i.e. `test.js`
runs strictly serial and dominates; slowest single test 630ms (git).

**Coverage.** Well-covered: render segments, profile badge, warn/critical tickets, hostile CONFIGS,
all three modes, the install family, uninstall, doctor (7 cases), the setters, git, caveman,
keep-working, checkpoints, downgrade, forecast, ledger, update badge/apply/signing, board/sessions,
reinject, config migration. **Untested (precise):** the `runWatch` runtime loop (`1564-1599`);
`relaunchResume` (`1527-1556`); `httpViaProxy`/`noProxy` (`943-984`, `906`); `notify` (`631-638`);
`ttyWidth`/`getWidth` COLUMNS-fallback; `runBoard` off-notice + mid-age entries; the `cavemanBadge`
suffix file (`1147-1152`); `reinjectOnCompact` = path variant + 8000-char cap; the error-log write
path (`2328`); `writeLedger` name-regex refusal; `pickFreshProfile` boundaries; live `--disarm`/
`--purge` against a running watcher; `fmtReset` relative combos + 12a/12p; `dispWidth` ZWJ clusters;
keep-working `maxContinues`/stuck-reset/hand-off phrases; `latestTodos` full-scan branch; the
retention sweeps; `maybeCheckUpdate` throttle; unknown `--hook` event; `ANTHROPIC_AUTH_TOKEN`
billing.

**Health: good** for the assertions it makes, but with **hermeticity holes that are themselves a
landmine (C10)** and a CI that only tests one Node version on one OS as root.

---

## 2. Enhancement opportunities, ranked

| # | Title | Impact | Effort | Files |
|---|---|---|---|---|
| E1 | Hermetic `run()`: TMPDIR sandbox + env scrub + USERPROFILE (TEST-01) | high | small | `test.js` |
| E2 | Isolate the default `SCRIPT` from the repo checkout (TEST-02) | high | small | `test.js` |
| E3 | Gate `relaunchResume` on `CCBSL_NO_ACT` (TEST-03) | high | small | `statusline.js`, `test.js` |
| E4 | Export `DEFAULTS`/`DEFAULT_ORDER`/`MODES`/`helpText` (TEST-07, prereq for quality-gates) | high | small | `statusline.js` |
| E5 | CI: Node 18/20/22 matrix, non-root run, junit, hard shellcheck (TEST-08) | high | medium | `.gitlab-ci.yml` |
| E6 | Guardian-runtime tests: `runWatch`, `relaunchResume`, live `--disarm`/`--purge` (TEST-05) | medium | medium | `test.js` |
| E7 | Proxy + remaining unit coverage (TEST-06) | medium | medium | `test-unit.js` |
| E8 | Targeted black-box gap tests (TEST-09) | medium | medium | `test.js` |
| E9 | Optional: shard `test.js` for wall-time (TEST-10) | low | medium | `test.js` → new files |
| E10 | Subprocess-aware coverage in CI (TEST-11) | low | small | `.gitlab-ci.yml` |

---

## 3. Correctness audit (the harness's own bugs)

**BUG-TEST-1 — a `statusline.config.json` in the repo dir breaks the suite (not hermetic to script-adjacent config).** *[high; CONFIRMED — reproduced by auditor]*
- Path: `SCRIPT` (`test.js:21`) points at the repo's `statusline.js`; most render/CLI tests spawn it
  directly (`run()`/`render()` `42-55`) instead of via `scriptCopy()`. `statusline.js` resolves its
  config next to itself (`170`), so any `statusline.config.json` in the clone — the normal state for a
  contributor who dogfoods the clone (the README install flow) — silently changes mode/thresholds and
  fails dozens of assertions.
- Repro (auditor): copy the repo, write `statusline.config.json` = `{"mode":"minimal"}`, run the
  `usage bars` test → fails; passes after removing the file.
- Fix: TEST-02.

**BUG-TEST-2 — the suite shares the real `os.tmpdir()` with the user: the `--purge` test deletes live user state on every `node --test`.** *[high; CONFIRMED — reproduced by auditor]*
- Path: `run()` sandboxes `HOME`/`CLAUDE_CONFIG_DIR` but not `TMPDIR`/`TEMP`/`TMP` (`49`).
  `statusline.js` keys burn-rate samples (`708`), agent caches (`468`), git caches (`1237`) in
  `os.tmpdir()`, and `runPurge` (`1655`) unlinks **every** `ccbsl-usage-*`/`ccbsl-agents-*`/`ccsl-git-*`
  there. The `--purge` test (`774`) therefore wipes the developer's real live-session forecast history
  and caches; `seedSamples` (`702`) also writes to real tmp.
- Repro (auditor): a sandboxed-HOME `--purge` with a canary `ccbsl-usage-*` in `os.tmpdir()` deletes
  the canary — proving HOME-only sandboxing does not contain `--purge`/sample/cache writes. (This is
  C10 and the exact mechanism behind the audit's real-`~/.claude` incident.)
- Fix: TEST-01.

**BUG-TEST-3 — host environment leaks into spawned tests (`NO_UPDATE_NOTIFIER=1` fails the update-badge tests).** *[medium; CONFIRMED — reproduced by auditor]*
- Path: `run()` spreads the full `process.env` into every child (`49`). `statusline.js` honors
  `NO_UPDATE_NOTIFIER` (`865`), `ANTHROPIC_API_KEY`/`AUTH_TOKEN` (`1210`), proxies (`915`/`907`),
  `CCBSL_UPDATE_BASE` (`74`), `CCBSL_UNATTENDED` (`1450`). A host exporting any of these changes test
  behavior; `NO_UPDATE_NOTIFIER=1` concretely fails "update badge shows a newer cached version"
  (`1162`).
- Fix: TEST-01.

**BUG-TEST-4 — `CCBSL_NO_ACT` does not gate `relaunchResume`: a `--watch` fire spawns the real `claude` even under the test guard.** *[medium; CONFIRMED — reproduced by auditor]*
- Path: the test contract (`47-48`) says `CCBSL_NO_ACT` keeps the guardian from spawning processes,
  and `notify` (`632`), `armWatcher` (`762`), `writeLedger` (`657`) honor it via `actAllowed()`.
  `relaunchResume` (`1527-1556`) does not — `runWatch` on a due checkpoint spawns `claudeBin()`,
  NO_ACT or not. This is why the entire watcher runtime is untested (a test would launch a real
  `claude -p`).
- Repro (auditor): stub `claudeBin`, a due checkpoint, `--watch` under `CCBSL_NO_ACT=1` → the stub was
  executed.
- Fix: TEST-03 (a `statusline.js` change) — it is both a test-harness fix and a product-safety guard,
  and it **unblocks all guardian-runtime tests**.

**BUG-TEST-5 — the sandbox is ineffective on Windows: `run()` sets `HOME` but `os.homedir()` uses `USERPROFILE`.** *[high for Windows contributors; CONFIRMED — code-decisive]*
- Path: `run()` sandboxes only `HOME` (`49`). On win32 `os.homedir()` (`222`) reads `USERPROFILE` and
  ignores `$HOME`, so the install/uninstall tests would wire/unwire the contributor's real
  `~/.claude*`, and successive `backupSettings` clobber the original `.bak`. No Windows CI catches it.
- Fix: TEST-01 (mirror `USERPROFILE` from `HOME`). Also [xplatform.md](xplatform.md) XPLAT-02 (same
  fix).

**BUG-TEST-6 — hostile stdin (non-string `model.display_name`) crashes the whole render — a gap in the hostile-input family and the only path to the untested error log.** *[low; CONFIRMED — reproduced by auditor]*
- This is the render-core bug BUG-RC-2 seen from the test side. The **fix** lives in
  [render-core.md](render-core.md) RENDER-02 (String-coerce at the source); the **test** (a hostile-
  STDIN fuzz family mirroring the hostile-CONFIG family at `test.js:270`) is authored there. Listed
  here only so the coverage map is complete; no separate task.

---

## 4. Performance audit

**On the hot path? No — this is the developer/CI feedback loop, not the render.** But it is worth
one measured win. `test.js`'s 105 tests run strictly serial in one process, each spawning 1–5 real
node subprocesses (~151 spawn sites; bare node ~50–60ms), so wall ≈ the serial sum: **12.7s
measured**, per-test TAP durations summing to ~12.5s (zero effective parallelism), slowest 630ms
(git). **Target ~4–6s** on a 4-core box (≈7–8s on a 2-core GitLab runner) with identical isolation
and spawn count, by **file-level parallelism** — `node --test` runs separate files in parallel child
processes. This is TEST-10, ranked low because it is a convenience win, not a correctness one, and
must not compromise isolation.

---

## 5. Quality audit + gate plan

This area does not itself emit an authored surface, but it **hosts the mechanical gates for every
other surface** (`node --test` auto-discovers `test-*.js`). The dedicated cross-surface scanner is
[quality-gates.md](quality-gates.md)'s `test-gates.js`; its **prerequisite is TEST-07** (exporting
`DEFAULTS`/`DEFAULT_ORDER`/`MODES`/`helpText`). This area's own contribution to the quality mission
is TEST-08 (a hard shellcheck gate + non-root run so the read-only-settings regression actually
executes) and TEST-11 (coverage visibility).

---

## 6. Scope & non-goals

**In scope:** hermetic `run()` (TMPDIR + env scrub + USERPROFILE); isolate `SCRIPT`; the
`CCBSL_NO_ACT` gate on `relaunchResume`; the export prereq; guardian-runtime tests; proxy/unit
coverage; targeted black-box gap tests; the CI matrix/non-root/junit/hard-shellcheck; optional
sharding; optional coverage.

**Do NOT build / do NOT touch:**
- **No in-process refactor replacing the subprocess spawns.** The black-box "spawn the real script"
  guarantee is the suite's whole value; keep it.
- **No test-framework dependency** (C1) — `node:test` only.
- **No fs/network mocking layers** — use real local http servers (the existing `test-unit.js:129`
  pattern) and real sandboxed dirs.
- **No paid macOS/Windows CI runners** before confirming runner availability — a Linux Node-version
  matrix is the cheap 80%; the Windows hazards are covered by the `USERPROFILE` fix + unit-level gates.
- Do not shard (TEST-10) until TEST-01/02/03 land — sharding a non-hermetic suite multiplies the
  hazard.

---

## 7. Implementation plan (fan-out-ready)

**Fan-out summary:** TEST-01 and TEST-02 both edit `test.js`'s startup/`run()` region — do them
together (one worktree) as the first change. TEST-03 edits `statusline.js` (coordinate with the
guardian worktree). TEST-07 edits `statusline.js`'s export block (coordinate with any other
`statusline.js` worktree). TEST-08 edits only `.gitlab-ci.yml` (fully parallel). TEST-05/06/09 add
tests and depend on TEST-01/02/03. **This plan's TEST-01/02/03/07 are the global prerequisites for
every other area's regression tests** — schedule them in the first wave.

---

### TEST-01 — Hermetic `run()`: TMPDIR sandbox + env scrub + USERPROFILE
- **Rationale:** BUG-TEST-2, BUG-TEST-3, BUG-TEST-5 in one pass; closes C10.
- **Files:** `test.js` (`run()` `42-51`, `seedSamples` `702`, startup `24-33`).
- **Exact change:** (a) at startup create `const TESTTMP = path.join(ROOT, 'tmp')` and `mkdirSync`
  it. (b) In `run()`'s child env, set `TMPDIR`/`TEMP`/`TMP` to `TESTTMP`; and delete from the
  inherited env before applying overrides: `NO_UPDATE_NOTIFIER`, `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (+ lowercase), `CCBSL_UPDATE_BASE`,
  `CCBSL_UNATTENDED`, `CLAUDE_CONFIG_DIR` (keep `NODE_V8_COVERAGE` for TEST-11). (c) set `USERPROFILE`
  = the sandbox home whenever a test overrides `HOME`. (d) repoint `seedSamples` at `TESTTMP`. (e)
  simplify the conditional billing guard (`110`) into a plain assertion now that the env is scrubbed.
- **Dependencies:** none. **Global prerequisite — first wave.**
- **Parallelization:** with TEST-02 (same file, same region) → one worktree.
- **Acceptance criteria:**
  - `node --test` passes (124+ tests) both with and without a host `NO_UPDATE_NOTIFIER=1` set.
  - New REGRESSION (`REGRESSION: the suite never touches the host os.tmpdir()`): a `before()` plants
    `os.tmpdir()/ccbsl-usage-canary.jsonl`, `test.after()` asserts it still exists then unlinks. Red
    today (purge test deletes it), green after.
  - New REGRESSION (`REGRESSION: host NO_UPDATE_NOTIFIER does not leak into spawned tests`): set
    `process.env.NO_UPDATE_NOTIFIER='1'` (restore in `finally`), write a newer-version cache in a
    sandbox, assert the `⬆` badge still renders.
- **Tests:** the two REGRESSIONs above.
- **Edge cases:** a test that deliberately sets one of the scrubbed vars (e.g. `CCBSL_UPDATE_BASE` for
  update tests) — the scrub happens **before** applying `...env`, so explicit overrides win; verify
  the update tests still pass.
- **Rollback:** revert the `run()`/startup/`seedSamples` edits.

### TEST-02 — Isolate the default `SCRIPT` from the repo checkout
- **Rationale:** BUG-TEST-1.
- **Files:** `test.js` (`SCRIPT` `21`, startup).
- **Exact change:** at suite startup copy `statusline.js` **and** `CHANGELOG.md` (needed by
  `--whatsnew` at `1097`) into `path.join(ROOT, 'clean')` and point `SCRIPT` there. `scriptCopy()`
  keeps working for config-variant tests.
- **Dependencies:** none. **Global prerequisite — first wave;** with TEST-01 (same file).
- **Parallelization:** one worktree with TEST-01.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: the default test script is isolated from the repo checkout`):
    `assert(path.dirname(SCRIPT) !== __dirname && !fs.existsSync(path.join(path.dirname(SCRIPT),
    'statusline.config.json')))`. Fails before (dirname === repo), passes after.
  - The whole suite passes even with a `statusline.config.json` present in the repo root (simulate in
    the test's setup, then clean up).
- **Tests:** the REGRESSION above.
- **Edge cases:** `--whatsnew` test needs `CHANGELOG.md` next to the copy (hence copying it);
  `scriptCopy` tests unaffected.
- **Rollback:** repoint `SCRIPT` at `path.join(__dirname, 'statusline.js')`.

### TEST-03 — Gate `relaunchResume` on `CCBSL_NO_ACT`
- **Rationale:** BUG-TEST-4. Both a safety guard and the unblocker for guardian-runtime tests.
- **Files:** `statusline.js` (`relaunchResume` `1527`), `test.js`.
- **Exact change:** at the top of `relaunchResume` (`1528`): `if (!actAllowed()) { watchLog(sid,
  'CCBSL_NO_ACT: would relaunch ' + (profileDir ? 'cross-profile' : '--resume ' + sid)); process.exit(0); }`
  — mirrors `armWatcher`/`notify`.
- **Dependencies:** none. **Global prerequisite for guardian-runtime tests (TEST-05, GUARD-01/02).**
  Coordinate the `statusline.js` edit with the guardian worktree.
- **Parallelization:** shares `statusline.js` → worktree isolation.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: --watch under CCBSL_NO_ACT never spawns claudeBin`): `scriptCopy`
    with `claudeBin` pointed at a marker-writing stub, a due checkpoint, run `--watch`, assert exit 0,
    **no** marker file, and the watch log contains `would relaunch`. Fails before (marker written).
  - `node --test` green.
- **Tests:** the REGRESSION above.
- **Edge cases:** a real unattended relaunch (no `CCBSL_NO_ACT`) still spawns — do not gate that.
- **Rollback:** remove the guard (re-blocks watcher tests — do not).

### TEST-07 — Export `DEFAULTS`, `DEFAULT_ORDER`, `MODES`, `helpText`
- **Rationale:** prerequisite for [quality-gates.md](quality-gates.md) GATE-01..04 and useful for
  gap tests.
- **Files:** `statusline.js` (`module.exports` `1369-1374`).
- **Exact change:** add `DEFAULTS, DEFAULT_ORDER, MODES, helpText` to the exported object. All are
  pure data / a hoisted function declaration (`helpText` at `1378` is hoisted, so referencing it in
  the export at `1369` is valid). No behavior change — the CLI still never runs when required.
- **Dependencies:** none. **Prerequisite for the quality-gate track.**
- **Parallelization:** shares `statusline.js` → worktree isolation.
- **Acceptance criteria:**
  - `node --test` green; a smoke assertion in `test-unit.js`:
    `assert.ok(SL.DEFAULTS && typeof SL.helpText === 'function' && Array.isArray(SL.DEFAULT_ORDER))`.
  - `require('./statusline.js')` still does not run the CLI (the guard at `1368` is intact).
- **Tests:** the smoke assertion.
- **Edge cases:** none — additive export.
- **Rollback:** remove the four names from the export.

### TEST-05 — Guardian-runtime tests
- **Rationale:** the untested `runWatch`/`relaunchResume`/live `--disarm`/`--purge`.
- **Files:** `test.js`.
- **Exact change:** add (all verified feasible + synchronous):
  1. `--watch stands down when the transcript was written after the reset` (past `resets_at` +
     transcript mtime after it → exit 0, log `standing down`).
  2. `--watch exits when the checkpoint is missing / has no resets_at` (exit 1 + the two log lines
     `1567`/`1570`).
  3. `--watch fires via a stub claudeBin` — `scriptCopy` with `{claudeBin: stub, autopilotBuffer: 0}`,
     **with** the TEST-03 `CCBSL_NO_ACT` guard *off* but `claudeBin` a marker stub: assert the marker
     got `--resume <sid> -p`, the prompt contains `UNATTENDED`, the checkpoint is consumed
     (`clearSessionGuardState` on spawn `1548`), the pid file removed on exit.
  4. `live --disarm kills a real watcher`: spawn `node statusline.js --watch <sid>` with a far-future
     `resets_at` as a controlled child, wait for the `.watch.pid`, run `--disarm`, assert output
     `signalled 1 process(es)` and the child exits — covers `isOurWatcher`'s `ps` path.
  5. extend the `--purge` test to assert tmp sample/agent/git caches (now under `TESTTMP`) and the
     board dir are removed.
- **Dependencies:** TEST-01, TEST-03. Coordinate with GUARD-01/02 (which add their own watcher tests).
- **Parallelization:** `test.js` → worktree isolation; after the first wave.
- **Acceptance criteria:** all five pass; `node --test` `# fail 0`; test 4's controlled child is
  always cleaned up (kill in a `finally`).
- **Tests:** the five above.
- **Edge cases:** test 4 must not leave an orphan watcher if an assertion throws (wrap in
  try/finally with `process.kill`); TESTTMP redirection (TEST-01) makes test 5's tmp assertions valid.
- **Rollback:** delete the added tests.

### TEST-06 — Proxy + remaining unit coverage
- **Rationale:** zero coverage of `httpViaProxy`/`noProxy`; thin `fmtReset`/`dispWidth` coverage.
- **Files:** `test-unit.js`.
- **Exact change:** in-process, mirroring `test-unit.js:129-157`: (1) HTTP-proxy GET (local server
  as proxy, `process.env.HTTP_PROXY` around the call, restore in `finally`, assert absolute-URI path
  + Host header); (2) CONNECT rejection (a `net` server answering `407` to CONNECT, assert the error
  starts `proxy CONNECT`); (3) `NO_PROXY` bypass (dead-port proxy + `NO_PROXY=127.0.0.1` → direct
  fetch succeeds); (4) `fmtReset` relative combos (`1d2h`, `2d`, `2h30m`) and 12a/12p clock edges —
  drive via a `scriptCopy` render with `resetStyle:'relative'` in `test.js` if `fmtReset` cannot be
  parameterized in-process (it reads `CONFIG`); (5) `dispWidth` ZWJ-cluster case documenting the
  current `👩‍💻`→4 behavior so a future change is conscious.
- **Dependencies:** none (unit-level). Overlaps UPD-03/UPD-06 unit tests — coordinate so the redirect
  and `NO_PROXY` tests are not duplicated.
- **Parallelization:** `test-unit.js` → worktree isolation.
- **Acceptance criteria:** `node --test test-unit.js` green with the new cases; each local server is
  closed in a `finally`.
- **Tests:** the five above.
- **Edge cases:** port 0 (ephemeral) for every local server; restore env in `finally`.
- **Rollback:** delete the added unit tests.

### TEST-09 — Targeted black-box gap tests
- **Rationale:** close the precise coverage gaps listed in §1.
- **Files:** `test.js`.
- **Exact change:** one MR of small tests, each with an exact fixture: `reinjectOnCompact` path
  variant + absolute + >8000-char truncation (`1487-1489`); `cavemanBadge` suffix append / control-
  char strip / symlink refusal (`1147-1152`) + a bogus mode → no badge; `--board` off-notice + "no
  live sessions" (`1678-1680`); `latestTodos` full-scan (>524288-byte transcript, last TodoWrite
  before a huge tool_result → Stop hook still blocks); keep-working `{maxContinues:2}` cap + stuck
  reset on shrinking pending + hand-off phrases ("blocked:", "let me know") allow stop; retention
  sweeps via `utimesSync`-aged files (`365`, `573`); session-start `source:'clear'` injects nothing;
  bogus `--hook` event exits 0; `ANTHROPIC_AUTH_TOKEN` → `💳 api`; `writeLedger` refuses a
  non-`.claude*` CFG basename; `pickFreshProfile` head==85 boundary excluded.
- **Dependencies:** TEST-01 (hermetic). Some overlap the fixes in other plans (e.g.
  `reinjectOnCompact` path is also a shell-docs/guardian nicety) — these are *coverage* tests of
  existing behavior, so they can land independently.
- **Parallelization:** `test.js` → worktree isolation.
- **Acceptance criteria:** all pass; `node --test` `# fail 0`; no test writes outside the sandbox
  (validated by the TEST-01 canary).
- **Tests:** the list above.
- **Edge cases:** the 8000-char and 524288-byte fixtures should be generated programmatically, not
  committed.
- **Rollback:** delete the added tests.

### TEST-08 — CI: Node 18/20/22 matrix, non-root run, junit, hard shellcheck
- **Rationale:** README claims Node 18+ (C1) but CI only tests `node:22`; the read-only-settings
  regression (`test.js:482`) self-skips under uid 0 and GitLab node containers run as root; shellcheck
  is `allow_failure`.
- **Files:** `.gitlab-ci.yml`.
- **Exact change:** replace the single test job with `parallel:matrix` over `image:
  [node:18, node:20, node:22]` (grep confirms no post-18 API; the suite passes on 18.15.0). Run the
  suite as the image's `node` user (`chown -R node . && su node -c 'node --test'`) so the
  read-only-settings test executes. Add `node --test --test-reporter=junit > junit.xml` (Node 21+;
  fall back to TAP on node:18) with `artifacts:reports:junit`. For shellcheck: confirm green in one
  pipeline after [shell-docs.md](shell-docs.md) SHELL-01 lands, then delete `allow_failure: true`
  (`.gitlab-ci.yml:19`). Add a guard that no test is silently skipped in CI where it should run:
  `node --test 2>&1 | grep -q '# skipped 0'` (or assert skip-count via junit) — **except** the
  win32-only tests, which must stay skipped on Linux; scope the assertion accordingly.
- **Dependencies:** the hard-shellcheck flip depends on SHELL-01 (the SC2148 fix). The matrix/non-root
  parts are independent.
- **Parallelization:** edits only `.gitlab-ci.yml` → fully parallel with all code work. **Cannot be
  fully verified locally** (needs a pipeline); flag as owner-run.
- **Acceptance criteria:**
  - The pipeline is green on all three Node images.
  - The read-only-settings regression (`test.js:482`) executes (not skipped) in CI — confirmed via
    the junit skip count.
  - shellcheck blocks a merge (after SHELL-01).
- **Tests:** the pipeline itself.
- **Edge cases:** `--test-reporter=junit` unsupported on node:18 → fall back to TAP for that image
  only; `su node` needs the workdir chowned.
- **Rollback:** restore the single `node:22` job + `allow_failure`.

### TEST-10 — (optional) Shard `test.js` for wall-time
- **Rationale:** the measured 12.7s serial wall; file-level parallelism is the only isolation-safe
  speedup.
- **Files:** `test.js` → `test-render.js`, `test-install.js`, `test-guardian.js`, `test-update.js`;
  a shared `_tlib.js` (named to **avoid** the `test-*.js` auto-discovery pattern) holding
  `sandbox`/`scriptCopy`/`run`/`render`/`strip`/`baseInput`/`transcript`.
- **Exact change:** move the section blocks into the four files, `require('./_tlib.js')` for helpers.
  No per-test change, no sandbox sharing.
- **Dependencies:** **must** be after TEST-01/02/03 (sharding a non-hermetic suite multiplies the
  hazard).
- **Parallelization:** a large `test.js` reshuffle → its own worktree, done last.
- **Acceptance criteria:** `node --test` still reports the same total pass count, `# fail 0`, in
  measurably less wall time (`/usr/bin/time -p node --test` before/after); `_tlib.js` is **not**
  auto-discovered (confirm the total test count is unchanged, not inflated by helper "tests").
- **Tests:** the count/parity check.
- **Edge cases:** a test that assumed a specific run order within `test.js` (none found, but verify);
  `CHANGELOG.md`/clean-script setup must run in each file (move it into `_tlib.js`'s exported setup).
- **Rollback:** merge the four files back into `test.js`.

### TEST-11 — (optional) Subprocess-aware coverage in CI
- **Rationale:** `node --test --experimental-test-coverage` alone measures almost nothing because the
  suite spawns the product.
- **Files:** `.gitlab-ci.yml`.
- **Exact change:** `NODE_V8_COVERAGE=cov node --test && npx c8 report --temp-directory=cov
  --reporter=text-summary --include=statusline.js`. Children inherit `NODE_V8_COVERAGE` via `run()`'s
  env (keep it in TEST-01's passthrough allowlist). `c8` stays a CI-image-only `npx` tool (preserves
  C1 for the shipped product). Publish `coverage: /Statements\s*:\s*(\d+\.?\d*)%/` for the badge.
- **Dependencies:** TEST-01 (must keep `NODE_V8_COVERAGE` in the env allowlist).
- **Parallelization:** `.gitlab-ci.yml` → parallel.
- **Acceptance criteria:** the CI job prints a statement-coverage summary for `statusline.js`.
- **Tests:** the CI job.
- **Edge cases:** `c8` availability in the node image (use `npx --yes`).
- **Rollback:** remove the coverage job.

---

## 8. Area-level verification

Locally (sandboxed per C10 — though TEST-01 makes the suite itself hermetic once landed):
```
node --check test.js && node --check test-unit.js && \
node --test && \
node -e 'const os=require("os"),fs=require("fs"),p=require("path"); const c=p.join(os.tmpdir(),"ccbsl-usage-verify.jsonl"); fs.writeFileSync(c,"x"); require("child_process").execSync("node --test",{stdio:"ignore"}); if(!fs.existsSync(c)) throw "suite deleted host tmp!"; fs.unlinkSync(c)'
```
The last line proves TEST-01: the suite no longer touches host `os.tmpdir()`. CI verification
(TEST-08/11) is owner-run in a pipeline.

---

## 9. Risks & open questions for the human

- **TEST-08 needs a pipeline to verify** (Node matrix, non-root, shellcheck green, junit). It cannot
  be confirmed on the dev machine. Owner should run one pipeline after SHELL-01 lands and before
  flipping `allow_failure`.
- **The non-root CI change** (`su node`) may interact with GitLab runner specifics (cache dirs,
  artifact upload permissions). If it fights the runner, an acceptable fallback is to keep root but
  set `process.getuid` expectations in the read-only test to run via a dropped-privilege child —
  flagged for the owner.
- No paid runners assumed. No credentials. No migrations.
