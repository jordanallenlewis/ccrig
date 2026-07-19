# perf

The per-2s render hot path and its filesystem/subprocess budget. This area's headline is a single
**measured, worthwhile** win (the git subprocess duty cycle); everything else is an explicit
"do-not-optimize, here is why" — the render is already startup-dominated and well-tuned.
Self-contained.

---

## 1. Current-state audit

**The hot path** (Claude Code runs it every ~2s): `loadConfig()` (`statusline.js:182-215`, reads
`statusline.config.json`) → stdin via `fs.readFileSync(0)` (`2324`) → `render`/`collectSegments`
(`1258-1339`, ~18 segments) → `wrapSegments` → stdout.

**Measured decomposition** (darwin arm64, Node v22.22.3, spawn-to-exit wall, medians): bare
`node -e ''` **47–55ms**; `statusline.js --version` (boot + parse/eval of the 137KB script + config
load) ~52.5ms; **full steady-state render 57–95ms** across batches (machine variance ±6ms). So **node
boot is ~75% of the render**, script parse/eval ~5ms, and all render JS ~8–12ms with **no single
script frame above the ~1.5ms sampling floor except git and the transcript parse**. Peak RSS 44.5MB
vs 40.2MB bare node, **flat even against a 100MB transcript** (tail caps).

**Complete per-render fs inventory** (instrumented, steady state, default config): **19 ops** —
script read (137KB), config read (ENOENT if none), stdin, `readdirSync(HOME)` + `statSync` per
`.claude*` dir (`detectProfiles:1165` via `profileSeg:1193`), `.ccbsl-update.json` read
(`readUpdateInfo:859`), `settings.json` read (`settingsVal:229` via the `oneM` check `1275`),
`guardian/<sid>.model` read (`downgradeSeg:512`), git cache stat+read (`gitSeg:1239-1241`),
transcript stat + agents-cache read **twice** (`inflightAgents:464` from `agentsSeg:1291` **and**
again as the `writeBoard` arg at `1304` even when `sessionBoard=false`), `.caveman-active` lstat
(`cavemanBadge:1142`), and 3 reads of the tiny usage-sample file (`recordSample:714` + `burnRate:742`
for both windows). **Zero writes at steady state; zero network** (C2, verified).

**The one material recurring cost: git cache misses.** `git status --porcelain=v2 --branch` measured
24.4ms (ccrig, small), 32.3ms (2k-file repo), 64.7ms (20k-file repo). Because the cache file's mtime
is only refreshed on a **miss** (`gitSeg:1239-1244`) and default `gitCacheMs=2500` vs the ~2s refresh
cadence, a live 7-render simulation at 2s intervals spawned git on **4 of 7** renders (57% duty
cycle), pushing those renders from ~62ms to ~91ms median (2k repo; ~110–125ms on 20k).

**Everything else the survey flagged is already mitigated and measured sub-ms:** `settingsVal`
re-read 0.026ms; `detectProfiles` `readdirSync` 0.119ms on a real 144-entry HOME; `contextPct` 256KB
fallback 0.151ms (only when stdin lacks `context_window`); the sample-file triple-read ~0.15ms;
`downgradeSeg` model-file read 0.04ms; `computeInflightAgents` size-cached + 768KB-capped (1.9ms cold,
0.037ms hit).

**Health: strong.** No correctness bugs. One worthwhile optimization, one hygiene fold, one docs
guard.

---

## 2. Enhancement opportunities, ranked

| # | Title | Impact | Effort | Files |
|---|---|---|---|---|
| P1 | Halve the git subprocess duty cycle: `gitCacheMs` 2500→10000 + `--no-optional-locks` (PERF-01) | high | small | `statusline.js`, `statusline.config.example.json`, `README.md`, `CHANGELOG.md`, `test.js` |
| P2 | Record the measured perf budget + bench recipe in CONTRIBUTING.md (PERF-03) | medium | small | `CONTRIBUTING.md` |
| P3 | Compute `inflightAgents` once per render (PERF-02) | low | small | `statusline.js` |

---

## 3. Correctness audit

**No correctness bugs in this area.** Checked: the git cache mtime logic is correct (miss refreshes,
hit serves), `strHash` keying is stable, the size-keyed agent cache is sound (append-only transcript →
unchanged size means unchanged result), the sample ring buffer's reset-detection and 40-line cap are
correct, RSS is flat under large transcripts. The one code-quality note is the duplicate
`inflightAgents` call (PERF-02), which is waste, not a bug.

One **surface-level politeness issue** that is correctness-adjacent: `gitProbe` (`1220`) and
`gitSnapshot` (`536-537`) spawn `git status` **without** `--no-optional-locks`, so a background
status-line process can take the index lock and write index refreshes into the user's repo every few
seconds; on a large repo a concurrent user-run `git rebase`/`commit` can transiently collide with the
probe's `index.lock`. Fixed as part of PERF-01 (cost-neutral).

---

## 4. Performance audit (the core of this plan)

### PERF-01 — the git duty cycle (the only worthwhile win)
- **Baseline (measured):** `git status` median 32.3ms (p90 37.8) on a 2k-file repo, 64.7ms on 20k,
  24.4ms on ccrig; bare subprocess overhead 6.1ms. **Duty cycle: 4 of 7 renders spawned git** in a
  live 2s-interval simulation at `gitCacheMs=2500` (instrumented preload counting `execSync`). Render
  median 62.5ms warm-cache vs 91.3ms miss (2k repo, n=30).
- **Target:** `<= 2 of 7` renders spawn git (measured: exactly 2/7 at `gitCacheMs=10000`), cutting
  average per-render git cost from ~18ms to ~9ms on a 2k repo (~37ms→~18ms on 20k), with branch/dirty
  staleness bounded at ~10–12s instead of ~2.5–4.5s.
- **Platform advantage exploited:** the change is a pure TTL widening (fewer subprocess spawns) plus
  `--no-optional-locks` (Git's own read-only mode — never takes the index lock, never writes an index
  refresh, and is marginally faster). No new machinery.
- **Proving command:** see PERF-01 acceptance below.

### Everything else — measured, bounded, NOT worth optimizing (stated so no one re-litigates it)
- **Node boot + 137KB parse/eval** (~52ms, the dominant term): rejected. `NODE_COMPILE_CACHE` saves
  only ~2.5ms, cannot be enabled from inside a single-file main module (the main module is compiled
  before user code runs), and injecting it into the installed `settings.json` command is
  platform-fragile (breaks on Windows cmd) for ~4%. A faster runtime violates C1.
- **`computeInflightAgents`** (768KB tail, 1.9ms cold): the size-keyed cache + 768KB cap already bound
  it; a streaming parser adds complexity for <2ms on a 60ms render. Leave it.
- **`settingsVal` / `detectProfiles` / `contextPct` fallback / sample-file reads:** all <0.2ms each;
  memoizing them is pure hygiene below the C3 bar — **do not build** a settings cache or profile cache.
- **Memory:** 44.5MB, flat; nothing silly.

---

## 5. Quality audit + gate plan

This area emits no authored surface. **Quality-gate directive skipped** — its output is the render
speed, gated by the perf budget in CONTRIBUTING.md (PERF-03) and the `--no-optional-locks` grep
guard. No scanner needed.

---

## 6. Scope & non-goals

**In scope:** the `gitCacheMs` default bump + `--no-optional-locks` on both git invocations; the
CONTRIBUTING.md perf-budget section + bench recipe; the duplicate-`inflightAgents` fold (only if
already editing that region).

**Do NOT build / do NOT touch:**
- No detached background git refresher — measured: a child node boot (~47ms) costs more total CPU
  than the ~32ms inline git it would hide.
- No `NODE_COMPILE_CACHE` injection — Windows-fragile, ~2.5ms, cannot be enabled from a single-file
  main module.
- No memoization of `settingsVal`/`detectProfiles`/sample reads — <0.3ms combined, complexity for
  nothing.
- No streaming transcript parser — the 768KB cap already bounds it at 1.9ms.
- Do not lower `gitCacheMs` below the render cadence (would re-spawn git every render); do not raise
  it so high that branch/dirty state feels stale (10s is the tuned sweet spot).

---

## 7. Implementation plan (fan-out-ready)

**Fan-out summary:** PERF-01 edits `statusline.js` (`DEFAULTS` `156` + `gitProbe` `1220` +
`gitSnapshot` `537`) plus the example/README/CHANGELOG + a test; PERF-03 edits only
`CONTRIBUTING.md` (fully parallel); PERF-02 edits `collectSegments` (only bundle it with other
`collectSegments` work). **The `DEFAULTS` line-region edit (PERF-01) collides with RENDER-01's
`loadConfig` sanitization and UPD-07's `updatePubkey` addition** — all three touch the `DEFAULTS`
block near lines 155–160; coordinate them in one worktree or a strict merge sequence.

---

### PERF-01 — Git duty cycle: `gitCacheMs` 2500→10000 + `--no-optional-locks`
- **Rationale:** the one measured render win; also fixes the index-lock politeness issue.
- **Files:** `statusline.js` (`DEFAULTS.gitCacheMs` `156`, `gitProbe` `1220`, `gitSnapshot` `537`),
  `statusline.config.example.json`, `README.md`, `CHANGELOG.md`, `test.js`.
- **Exact change:** (a) `statusline.js:156`: `gitCacheMs: 2500` → `gitCacheMs: 10000`. (b) `gitProbe`
  (`1220`): change the command to `git --no-optional-locks status --porcelain=v2 --branch`. (c)
  `gitSnapshot` (`537`): same flag on its `git status --porcelain` (the checkpoint path). (d)
  hand-mirror the new default + comment into `statusline.config.example.json` (C6) and the README
  config table (`206` area, which documents `gitCacheMs`). (e) a `CHANGELOG.md` `[Unreleased]` entry
  noting the staleness tradeoff (~10s vs ~4.5s worst case) and that the old value is one config line
  away. Note `rev-parse HEAD` in `gitSnapshot` (`536`) does not take the index lock, so it needs no
  flag.
- **Dependencies:** none. **`DEFAULTS` edit coordinates with RENDER-01 + UPD-07** (same block).
- **Parallelization:** shares `statusline.js` (`DEFAULTS`, `gitProbe`, `gitSnapshot`) → worktree
  isolation; merge-coordinate the `DEFAULTS` line.
- **Acceptance criteria:**
  - `node --test` + `--selftest` green; existing git tests (`test.js:642`, `:662`) still green.
  - New REGRESSION (`REGRESSION: fresh git cache is served without a git subprocess`): write a
    poisoned cache file `ccsl-git-<strHash(cwd)>.json` (`strHash` `1216`, path pattern `1237`) with
    `{"branch":"CACHED-SENTINEL","ahead":0,"behind":0,"dirty":0}` and a fresh mtime into a
    **TESTTMP-scoped** sandbox (so it does not touch real tmp — depends on [tests-ci.md](tests-ci.md)
    TEST-01), render with `cwd` pointing at a real git repo, assert output shows `CACHED-SENTINEL`
    (proves a fresh cache is served without spawning git).
  - Grep guard (feeds a `--selftest` assertion or a `test-gates.js` line): `gitProbe`'s built command
    string contains `--no-optional-locks`, so a future edit cannot silently drop it.
  - Duty-cycle proof (owner-run, not a CI gate): the 7×`sleep 2` instrumented loop counting `execSync`
    returns `<= 2` at `gitCacheMs=10000`.
- **Tests:** the cache-sentinel REGRESSION; the `--no-optional-locks` grep guard.
- **Edge cases:** `gitCacheMs=0` in a user config (RENDER-01 keeps 0 valid → cache off → git every
  render, the user's explicit choice); a repo where `--no-optional-locks` is unsupported (Git < 2.15,
  ancient — the flag is 2015-era, safe; if truly absent, `git` errors and `gitProbe` returns null →
  no git segment, degrades cleanly).
- **Rollback:** revert the default to 2500 and drop the flag (docs + changelog too).

### PERF-03 — Record the perf budget + bench recipe in CONTRIBUTING.md
- **Rationale:** protect the hot path from well-meaning feature PRs; also codify the sandboxed bench
  invocation so a future benchmark cannot leak writes into the real `~/.claude` (the audit's own
  incident mechanism).
- **Files:** `CONTRIBUTING.md`.
- **Exact change:** add a "Performance budget" section stating: bare node boot ~47ms is the floor;
  script parse/eval +5ms; full steady render +8–12ms of JS with 19 fs ops and zero writes/network;
  git cache-miss +24–65ms by repo size; transcript work capped at 768KB/1.9ms. State the rule already
  implicit in the code: **no new per-render work above ~1ms without a cache, every cache keyed by
  mtime/size (C3)**. Include the one-liner bench recipe (a `spawnSync` loop, 30 iters, report median)
  **run only in a sandbox** (`env HOME=<sb> CLAUDE_CONFIG_DIR=<sb>/.claude TMPDIR=<sb>/tmp
  CCBSL_NO_ACT=1`) so it never mutates real state — mirror `test.js:29-55`. Note the hazard explicitly:
  a render without those env overrides writes to the real `~/.claude` and real tmp.
- **Dependencies:** none. Docs-voice gate applies.
- **Parallelization:** doc-only → fully parallel.
- **Acceptance criteria:** the section exists and passes the docs-voice gate; reviewer-checked that
  the numbers match §1/§4.
- **Tests:** the docs-voice gate.
- **Edge cases:** none.
- **Rollback:** remove the section.

### PERF-02 — Compute `inflightAgents` once per render
- **Rationale:** `collectSegments` calls `inflightAgents` twice (`agentsSeg` `1291` and the
  `writeBoard` arg `1304`), the second even when `sessionBoard=false`. Saves 2 fs ops + ~0.04ms —
  **below the C3 bar**, so do this **only if already editing `collectSegments`** for another reason.
- **Files:** `statusline.js` (`collectSegments` `1291`, `1304`).
- **Exact change:** hoist `const agents = DEMO_AGENTS ? [] : inflightAgents(input.transcript_path);`
  before `1291`; pass the list into `agentsSeg` (add an optional arg) and `agents.length` into
  `writeBoard`.
- **Dependencies:** none; low priority. Do not schedule as a standalone PR.
- **Parallelization:** shares `collectSegments` with render-core/guardian render-time edits → fold
  into whichever worktree touches `collectSegments`.
- **Acceptance criteria:** `node --test` green; the existing agents test (`test.js:789`) still green;
  an fs-op count (instrumented) shows one `ccbsl-agents` read, not two.
- **Tests:** keep existing green; optional op-count check.
- **Edge cases:** `DEMO_AGENTS` set (the demo path — pass `[]`); a transcript-less input (returns
  `[]`).
- **Rollback:** revert to the two separate calls.

---

## 8. Area-level verification

Sandboxed (C10), after [tests-ci.md](tests-ci.md) TEST-01 (for the TESTTMP-scoped cache test):
```
node --check statusline.js && \
node statusline.js --selftest && \
node --test && \
node -e 'const s=require("fs").readFileSync("statusline.js","utf8"); if(!/--no-optional-locks/.test(s)) throw "missing --no-optional-locks"; if(!/gitCacheMs:\s*10000/.test(s)) throw "gitCacheMs not bumped"'
```
The optional duty-cycle proof (owner-run): a 7-render `sleep 2` loop with an `execSync`-counting
`--require` preload, asserting `<= 2` git spawns.

---

## 9. Risks & open questions for the human

- **`gitCacheMs` 10000 makes branch/dirty state up to ~10–12s stale** (vs ~4.5s today). For most
  users the git segment changes rarely between renders, so this is invisible; a user who watches the
  dirty count tick live during rapid commits would notice the lag. The old value is one config line
  away and documented. Confirm the owner is comfortable with the staleness/CPU tradeoff (the plan
  judges it clearly worth it; it is the single measured render win).
- No paid services, credentials, or migrations. PERF-01 is a config-default change (revertible) plus a
  cost-neutral git flag; PERF-03 is docs; PERF-02 is optional hygiene.
