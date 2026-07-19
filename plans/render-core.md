# render-core (FLAGSHIP)

The render pipeline is the whole product surface. This is the deepest plan; treat it as the
flagship. It is self-contained — everything an executor needs is restated here.

---

## 1. Current-state audit

**What it does.** Claude Code invokes `statusline.js` with a JSON blob on stdin every ~2s (and
after each message). The main path (`statusline.js:2313-2331`) reads stdin, `JSON.parse`s it inside
a try/catch that falls back to `input = {}`, then calls `render(input, getWidth() - CONFIG.reserveCols)`.
`render` (`1337-1339`) = `wrapSegments(collectSegments(input, width, gitOverride), width)`.

**Structure (real paths + line ranges):**
- **Config load** — `loadConfig` (`182-215`) deep-merges `statusline.config.json` over the
  `DEFAULTS` SSOT (`93-167`). It sanitizes `show`, `thresholds`, `color`, `profileLabels`, `order`,
  `mode` — but **not** `reserveCols` or `gitCacheMs`. `CONFIG` is module-global (`216`).
- **Width model** — `getWidth` (`282-289`): `COLUMNS` env → `/dev/tty` ioctl (`ttyWidth` `272-281`,
  fd-leak-safe) → `stdout.columns` → `100`. `dispWidth` (`234-245`) strips ANSI, treats VS16/ZWJ as
  0 cells, counts `cp >= 0x1F000` plus four hardcoded BMP symbols (`⚡ ☀ ⚠ ⏳`) as 2 cells,
  everything else as 1. `wrapSegments` (`248-260`) greedily packs segments into lines `<= width`
  joined by `SEP` (` │ `). `truncFolder` (`292-295`) trims a folder to fit via `f.slice`.
- **Primitives** — `bar` (`263-268`): clamps 0-100, `filled = Math.round(pct/100*width)`, color by
  `green`/`yellow` thresholds. `fmtReset` (`304-322`): `'clock'` (12-hour `10:40a`, dated when not
  today) or `'relative'` (`2h14m`); DST-safe (local `Date` getters). `usageSeg` (`325-331`).
- **Segment builders** — `collectSegments` (`1258-1335`) builds a name→string map for the 18
  segments in `DEFAULT_ORDER` (`89`): `profile update folder model downgrade effort flags context
  git agents caveman billing session weekly forecast resumeHint cost sessionName`, then filters by
  `CONFIG.order` and `mode` (`minimal` keeps `MINIMAL_KEEP` `:91`; `expanded` keeps all with
  content; `normal` honors per-segment `show` flags). Segment helpers of this area: `contextPct`
  (`1104-1129`, prefers `context_window.used_percentage`, else transcript-tail fallback with a
  `[1m]`→1M-token heuristic), `effortLevel` (`1132-1137`), `cavemanBadge` (`1140-1155`),
  `profileSeg` (`1193-1201`), `billingSeg` (`1205-1212`), `gitProbe`/`gitSeg` (`1217-1252`, porcelain
  v2, cached in tmp by `gitCacheMs`), plus the folder/model/flags/context/cost/sessionName inline
  builders in `collectSegments`.

**Interactions.** `collectSegments` also drives live side effects on the real render
(`gitOverride === undefined`): `maybeCheckUpdate`, `writeBoard`, `recordSample`, `writeLedger`
(`1302-1309`) and `resumeHintSeg`/`armAutopilot` (guardian; owned by [guardian.md](guardian.md)).
Those are out of scope here except where a render-core change must preserve the `live` gating.

**Health: good.** Strong test coverage (rendering, wrapping, hostile-config fuzz at `test.js:270`,
a width-bound test at `test.js:138`, `--selftest`). The weaknesses are concentrated and fixable:
width measurement is ASCII/emoji-only, two numeric config keys are unsanitized, and the input
fallback does not defend against valid-JSON `null` / non-object / hostile field types.

**Rendered-surface quality read** (second directive, surface 1). Ran `--demo --cols 30/50/80` in a
sandbox. The bar is well-designed: color-coded, wraps cleanly, the near-limit warning survives into
minimal mode. Three *mechanical* taste failures, not stylistic: (a) the usage bar saturates to
"full" at ~94% because of `Math.round`, so it cannot distinguish 94% from 100% — exactly the range a
limit indicator exists for; (b) width miscounts overflow narrow terminals for non-ASCII names; (c)
the bar fill turns red at `pct > yellow` (80) while the label only escalates at `warn` (90), so
81–89% shows a red bar next to calm dim text. These are the surface's quality-gate scope.

---

## 2. Enhancement opportunities, ranked

| # | Title | Impact | Effort | Files |
|---|---|---|---|---|
| E1 | Sanitize `reserveCols` + `gitCacheMs` in `loadConfig` (fixes RENDER-01) | high | small | `statusline.js`, `test.js` |
| E2 | Guard the main path + hostile field types against crash-to-error-banner (RENDER-02) | high | small | `statusline.js`, `test.js` |
| E3 | One cell-accurate `glyphWidth(cp)` powering `dispWidth` + `truncFolder` (RENDER-03) | high | medium | `statusline.js`, `test-unit.js`, `test.js` |
| E4 | Reserve the last bar block for true 100% (RENDER-04) | medium | small | `statusline.js`, `test-unit.js` |
| E5 | Align the usage-bar color with the label escalation (RENDER-05) | low | small | `statusline.js`, `test-unit.js` |

---

## 3. Correctness audit

All four are CONFIRMED. Severities are the orchestrator's independent call.

**BUG-RC-1 — `reserveCols` unsanitized → non-numeric value disables wrapping (one giant overflowing line).** *[medium; CONFIRMED — reproduced by orchestrator + verifier]*
- Path: `loadConfig` (`182-215`) never coerces `reserveCols`; the main path computes
  `getWidth() - CONFIG.reserveCols` (`2325`). A hand-edited `statusline.config.json` with
  `"reserveCols": "oops"` yields `width = NaN`; `wrapSegments`' guard `curW + add > width` is always
  false against `NaN`, so every segment lands on one unwrapped line. A negative value inflates width
  past the real terminal.
- Minimal repro (sandboxed): copy `statusline.js` to a scratch dir, write
  `statusline.config.json` = `{"reserveCols":"oops"}` next to it, pipe a normal input at
  `COLUMNS=40`. Observed: a single 178-char line into a 40-col terminal, exit 0.
- The existing hostile-config fuzz (`test.js:270-285`) does **not** catch this: it only asserts exit
  0 and that `Opus 4.8` is present, both true for the broken line.
- Fix: RENDER-01.

**BUG-RC-2 — valid-JSON `null` (and hostile field types) crash the render into the error banner.** *[low; CONFIRMED — reproduced by orchestrator + verifier]*
- Path: `let input = {}; try { input = JSON.parse(...) } catch {}` (`2322-2324`). `JSON.parse('null')`
  succeeds and returns `null`, overwriting the `{}` fallback. `render(null)` → `collectSegments`
  reads `input.workspace` (`1266`) → `TypeError`. The outer catch (`2326-2329`) writes
  `statusline-error.log` and prints `statusline error: run node statusline.js --doctor` instead of a
  bar. (Top-level number/string/array do **not** crash — property access yields `undefined` — only
  `null`/`undefined` do.) Related: a truthy non-string `model.display_name` (e.g. `123`) reaches
  `model.replace` (`1274`) and throws the same way; `session_name` similarly at `1324-1325`.
- Repro (sandboxed): `printf 'null' | ... node statusline.js` → error banner + a `statusline-error.log`
  containing `TypeError: Cannot read properties of null (reading 'workspace')`. And
  `{"model":{"display_name":123}}` → `TypeError: model.replace is not a function`.
- Fix: RENDER-02.

**BUG-RC-3 — `dispWidth` undercounts CJK/Fullwidth/several BMP emoji → wrap guarantee breaks.** *[medium; CONFIRMED — reproduced by orchestrator + verifier]*
- Path: `dispWidth` (`234-245`) only widens `cp >= 0x1F000` and four BMP symbols. East Asian Wide /
  Fullwidth ranges render 2 terminal cells but count 1: CJK ideographs, Hangul, kana, fullwidth
  forms, and common Emoji_Presentation BMP glyphs (`✅` etc.). Since `wrapSegments` measures with
  `dispWidth`, a segment built from a CJK folder/branch/session name is measured at ~half its true
  width and overruns the terminal — the exact overflow `--selftest` exists to prevent.
- Repro (orchestrator, in-process): `dispWidth('中文目录') = 4` (true 8), `dispWidth('ＡＢ') = 2`
  (true 4), `dispWidth('한글') = 2` (true 4), `dispWidth('日本語') = 3` (true 6). `dispWidth('🤖') = 2`
  (correct).
- Fix: RENDER-03. This is the **same root cause** as the xplatform CJK finding (XPLAT-05) — fix it
  once here; do not double-implement.

**BUG-RC-4 — `truncFolder` slices UTF-16 code units (lone surrogate) and never shortens wide names.** *[low; CONFIRMED — reproduced by verifier]*
- Path: `truncFolder` (`292-295`) gates on `f.length` (UTF-16 code units) and does
  `f.slice(-(max-1))`. (a) a folder with astral/emoji chars is cut mid-surrogate-pair, emitting a
  lone surrogate a terminal renders as `�`; (b) a CJK folder whose code-unit length `<= max` is
  never truncated even though its cell width is ~2×, compounding BUG-RC-3.
- Repro: `truncFolder('😀😀😀😀😀', 6)` → `'…\ude00😀😀'` (contains lone low surrogate `0xDE00`);
  `truncFolder('非常に長いフォルダ名です', 14)` returns the full 24-cell string unchanged.
- Fix: RENDER-03 (shares the `glyphWidth` helper).

Nothing else in this area is a bug: `fmtReset` is DST-safe, `bar` clamps correctly, `gitProbe`
handles detached HEAD and porcelain v2 quirks, `ttyWidth` is fd-leak-safe, `loadConfig` restores
null'd-out sections.

---

## 4. Performance audit

**On the hot path? Yes — this IS the hot path,** but it is already well-tuned. Measured
(darwin arm64, Node v22.22.3, 20–30 spawns, medians): bare `node -e ''` ~47–55ms; full render
~57–95ms wall. **~75% of the wall is fixed Node interpreter boot**, which a spawned single-file
script cannot avoid. Script-attributable JS is ~8–12ms; no single frame above the ~1.5ms sampling
floor except the git subprocess (owned by [perf.md](perf.md)) and the size-capped transcript parse
(owned by [guardian.md](guardian.md)). Peak RSS ~44.5MB, flat even against a 100MB transcript
(tail caps).

**Conclusion: no render-core performance task.** The width fix (RENDER-03) adds a handful of range
comparisons per glyph — O(chars), sub-microsecond, well under C3's 1ms bar. **Acceptance
constraint on RENDER-03:** the new `glyphWidth` must be a flat integer-comparison function (no
regex, no table allocation per call, no per-call array building) so it stays off the perf budget.
Proving command if doubted: `node -e 'const m=require("./statusline.js"); let t=process.hrtime.bigint(); for(let i=0;i<100000;i++) m.dispWidth("中文a🤖branch/name"); console.log(Number(process.hrtime.bigint()-t)/1e6+"ms/100k")'` in a sandbox — expect < 50ms for 100k calls.

---

## 5. Quality audit + gate plan (this area owns output surface 1: the rendered bar)

**Failures (concrete, with the fix and the mechanical gate):**

- **Q1 — the usage bar saturates before 100%.** `bar` (`263-268`) uses `Math.round`, so an 8-wide
  bar shows all 8 blocks at `>= 93.75%` and a 10-wide at `>= 95%`. Verified: `bar(94,8)` and
  `bar(99,8)` both render 8 filled blocks. For a *limit* indicator the 94→100% band is the one that
  matters. Remediation: RENDER-04 (reserve the final block for true 100%). Gate: `test-unit.js`
  asserting `bar(94,8)` has `< 8` filled and `bar(100,8)` has exactly 8.
- **Q2 — non-ASCII overflow.** Covered by BUG-RC-3/RENDER-03. Gate: extend `--selftest` (`2206`)
  with a CJK folder/branch case and add a `test.js` REGRESSION rendering a CJK folder at
  `COLUMNS=30` asserting no `│`-bearing line exceeds a cell-accurate width.
- **Q3 — color/label escalation mismatch (81–89%).** `usageSeg` (`325-331`): the bar turns red at
  `pct > yellow` (80) while the label bolds red + `⚠` only at `pct >= warn` (90). A red bar beside
  calm dim text is inconsistent hierarchy. Remediation: RENDER-05 — drive the usage bar's color off
  the `warn` escalation point so bar and label escalate together (decided: change the bar, not the
  label; the label's 90% threshold is the documented one). Gate: `test-unit.js` asserting the
  colored `usageSeg` output at 85% contains no red (`203`) escape.

**How the gate wires in:** these are `bar()`/`dispWidth()` unit assertions in `test-unit.js` and a
render REGRESSION + `--selftest` extension — all inside `node --test` (C9), which CI already runs.
No new file needed for this surface; the shared cross-surface scanner lives in
[quality-gates.md](quality-gates.md).

---

## 6. Scope & non-goals

**In scope:** `loadConfig` numeric-key sanitization; main-path input guard + hostile-field
coercion; a single cell-accurate `glyphWidth` powering `dispWidth` and `truncFolder`; the bar
100%-reservation; the usage-bar color alignment; the matching tests and `--selftest` extension.

**Do NOT build / do NOT touch:**
- **No full `wcwidth`/Unicode property tables.** Ten East Asian Wide/Fullwidth ranges + the common
  Emoji_Presentation BMP set cover the real cases at zero dependency (C1). A complete Unicode table
  is bloat.
- **No grapheme-cluster segmentation / `Intl.Segmenter`.** ZWJ sequences (`👩‍💻`) currently
  over-count; that is *safe* (it only wraps early) and not worth a segmentation engine. Document the
  behavior in a unit test; do not "fix" it.
- **No change to `getWidth`/`ttyWidth`** — verified fd-leak-safe and correct across platforms.
- **No new segments, no new display modes, no color-theming UI.** `/statusline-config` already
  covers rich editing.
- **Do not touch the `live`/`gitOverride` side-effect gating** in `collectSegments` (`1300-1313`) —
  that is guardian/update territory; a render-core edit must preserve it exactly.
- Do not move any width work off the hot path into a cache — it is already sub-ms.

---

## 7. Implementation plan (fan-out-ready)

**Fan-out summary:** RENDER-01, RENDER-02, RENDER-03, RENDER-04, RENDER-05 are **five independent
tasks** that all edit `statusline.js` (and most add tests). They can be developed in parallel
**only under git-worktree isolation**, because they touch the same file; the coordinator must then
merge in the order 01 → 02 → 03 → 04 → 05 (each merge re-runs `node --test`). If not using
worktrees, sequence them. RENDER-03 is the largest; the other four are tiny. None depends on any
other area **except** their regression tests depend on the hermetic harness ([tests-ci.md](tests-ci.md)
TEST-01/02) being in place first.

---

### RENDER-01 — Sanitize `reserveCols` and `gitCacheMs` in `loadConfig`
- **Rationale:** BUG-RC-1. A hand-edited non-numeric/negative value silently disables wrapping or
  inflates width.
- **Files:** `statusline.js` (`loadConfig` `182-215`), `test.js`.
- **Exact change:** in `loadConfig`, after the existing `color` sanitization loop and before
  `return merged`, add:
  ```js
  const rc = Number(merged.reserveCols);
  merged.reserveCols = (Number.isFinite(rc) && rc >= 0) ? Math.floor(rc) : DEFAULTS.reserveCols;
  const gc = Number(merged.gitCacheMs);
  merged.gitCacheMs = (Number.isFinite(gc) && gc >= 0) ? Math.floor(gc) : DEFAULTS.gitCacheMs;
  ```
  Mirrors the existing threshold/color coercion pattern. (Note: if [perf.md](perf.md) PERF-01 changes
  `DEFAULTS.gitCacheMs`, this code is unaffected — it reads `DEFAULTS.gitCacheMs` by reference.)
- **Dependencies:** none (its regression test needs TEST-01/02).
- **Parallelization:** shares `statusline.js` with all RENDER-* and other code plans → worktree
  isolation.
- **Acceptance criteria:**
  - `node --test` passes (C9), `node statusline.js --selftest` passes.
  - New REGRESSION in `test.js` (`REGRESSION: a non-numeric reserveCols does not disable wrapping`):
    `scriptCopy(dir, {reserveCols:'oops'})`, render at `cols 50`, assert every stripped line
    containing `│` has `dispWidth <= 50`. Fails before, passes after.
  - Hostile-config fuzz (`test.js:270`) still green.
- **Tests:** the new REGRESSION above; `node --test`.
- **Edge cases:** `reserveCols: -5` (must clamp to default, not widen); `gitCacheMs: 0` (valid — must
  stay 0, meaning "no cache"); `reserveCols: 2.7` (floor to 2).
- **Rollback:** revert the added lines; behavior returns to unsanitized.

### RENDER-02 — Guard the main path against `null`/non-object stdin and hostile field types
- **Rationale:** BUG-RC-2. Valid-JSON `null` and a non-string `model.display_name` crash the whole
  render into the error banner.
- **Files:** `statusline.js` (main path `2322-2325`; `collectSegments` `1273-1276`, `1324-1325`),
  `test.js`.
- **Exact change:**
  1. Main path, after the parse try/catch: `if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};`
  2. In `collectSegments`, coerce model to a string at the source (`1273`):
     `let model = String((input.model && (input.model.display_name || input.model.id)) || 'Claude');`
  3. Guard `session_name` (`1324`): `const name = typeof input.session_name === 'string' ? input.session_name : '';`
  Keep the top-level catch as the last resort.
- **Dependencies:** none (test needs TEST-01/02).
- **Parallelization:** shares `statusline.js` → worktree isolation.
- **Acceptance criteria:**
  - `node --test` + `--selftest` pass.
  - New REGRESSION (`REGRESSION: hostile stdin degrades per-segment, never to the error banner`):
    render a family `[ 'null', '42', '"str"', '[]', '{"model":{"display_name":123}}',
    '{"workspace":42}', '{"session_name":99}' ]`; for each assert exit 0, output does **not** contain
    `statusline error`, and **no** `statusline-error.log` was written in the sandbox CFG. (This also
    closes the tests-ci gap TEST-06/hostile-stdin.)
- **Tests:** the REGRESSION above; `node --test`.
- **Edge cases:** `model` absent entirely (→ `'Claude'`); `model.id` present but `display_name`
  numeric; `session_name` an object.
- **Rollback:** revert the three guards.

### RENDER-03 — One cell-accurate `glyphWidth(cp)` powering `dispWidth` and `truncFolder`
- **Rationale:** BUG-RC-3 + BUG-RC-4 (same root cause: measuring in code units / missing wide
  ranges). Consolidate into one helper so a future consumer cannot reintroduce the drift.
- **Files:** `statusline.js` (`dispWidth` `234-245`, `truncFolder` `292-295`), `test-unit.js`,
  `test.js`, and `--selftest` (`2206`).
- **Exact change:**
  1. Add a pure helper near `dispWidth`:
     ```js
     // terminal cell width of a single codepoint: 0 (combining), 2 (wide/fullwidth/emoji-presentation), else 1
     function glyphWidth(cp) {
       if (cp === 0xFE0F || cp === 0x200D) return 0;                 // VS16 / ZWJ
       if (cp >= 0x1F000) return 2;                                  // astral emoji & symbols
       if (cp === 0x26A1 || cp === 0x2600 || cp === 0x26A0 || cp === 0x23F3) return 2; // ⚡ ☀ ⚠ ⏳
       // East Asian Wide / Fullwidth (the ranges that actually occur in names)
       if ((cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0x303E) ||
           (cp >= 0x3041 && cp <= 0x33FF) || (cp >= 0x3400 && cp <= 0x4DBF) ||
           (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0xAC00 && cp <= 0xD7A3) ||
           (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE4F) ||
           (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6)) return 2;
       return 1;
     }
     ```
  2. `dispWidth` becomes: strip ANSI, then `for (const ch of s) w += glyphWidth(ch.codePointAt(0));`
  3. `truncFolder` becomes cell-aware — iterate codepoints from the tail budgeting by
     `glyphWidth`, never slicing a surrogate, prefix `'…'` when trimmed:
     ```js
     function truncFolder(f, max) {
       if (max < 2) return f;
       const chars = [...f];
       let w = 0; for (const ch of chars) w += glyphWidth(ch.codePointAt(0));
       if (w <= max) return f;
       const budget = max - 1;                         // room for the leading '…'
       let acc = 0; const kept = [];
       for (let i = chars.length - 1; i >= 0; i--) {
         const cw = glyphWidth(chars[i].codePointAt(0));
         if (acc + cw > budget) break;
         acc += cw; kept.unshift(chars[i]);
       }
       return '…' + kept.join('');
     }
     ```
  4. Export `glyphWidth` alongside `dispWidth` in the module block (`1369-1374`) for unit tests.
  5. Extend `--selftest` cases (`2208-2223`) with a CJK folder input so its existing overflow check
     exercises wide glyphs.
- **Dependencies:** none. **This is the same fix as xplatform XPLAT-05 — do not implement twice;**
  XPLAT-05 becomes "verify RENDER-03 covers it."
- **Parallelization:** shares `statusline.js` → worktree isolation. Largest task; give it its own
  worktree.
- **Acceptance criteria:**
  - `node --test` + `--selftest` pass.
  - `test-unit.js` `dispWidth` test extended: `dispWidth('漢字')===4`, `dispWidth('ＡＢ')===4`,
    `dispWidth('한글')===4`, `dispWidth('日本語')===6`, `dispWidth('✅')===2`, and the existing
    ASCII/emoji/ZWJ assertions unchanged. Add a `glyphWidth` case documenting ZWJ→0 and `👩‍💻`
    over-count (conscious, per non-goals).
  - New `test-unit.js` `truncFolder` cases: `truncFolder('😀😀😀😀😀',6)` contains **no** UTF-16 code
    unit in `0xD800-0xDFFF`; a long CJK name is shortened to fit its **cell** budget.
  - New `test.js` REGRESSION: render a CJK folder at `COLUMNS=30`, assert no stripped `│`-bearing
    line exceeds 30 cells (measured with the fixed `dispWidth`).
  - Perf guard (C3): the 100k-call microbench in §4 completes < 50ms.
- **Tests:** the unit + regression cases above; `node --test`; the perf microbench.
- **Edge cases:** halfwidth kana (`0xFF61-0xFF9F`) is **1** cell — must stay 1 (the `0xFF00-0xFF60`
  range deliberately excludes it); a string of only combining marks; `max < 2` in `truncFolder`.
- **Rollback:** revert `dispWidth`/`truncFolder`/`glyphWidth`; the export line is harmless to keep.

### RENDER-04 — Reserve the last bar block for true 100%
- **Rationale:** Q1. `Math.round` makes the usage bar read full at ~94%.
- **Files:** `statusline.js` (`bar` `263-268`), `test-unit.js`.
- **Exact change:** in `bar`, replace `const filled = Math.round((pct / 100) * width);` with:
  ```js
  const filled = pct >= 100 ? width : Math.min(width - 1, Math.floor((pct / 100) * width));
  ```
- **Dependencies:** none.
- **Parallelization:** shares `statusline.js` → worktree isolation.
- **Acceptance criteria:**
  - `node --test` + `--selftest` pass.
  - `test-unit.js` `bar` test extended: `bar(94,8)` has `< 8` filled blocks; `bar(100,8)` has exactly
    8; `bar(0,10)` has 0; `bar(50,10)` has 5 (existing assertions stay green — note `bar(50,10)` is
    now `floor(5)=5`, unchanged).
- **Tests:** extended `bar` unit test.
- **Edge cases:** `width = 1` (99% → `min(0, floor(0.99))=0`; 100% → 1 — acceptable); `pct` slightly
  over 100 (clamped upstream to 100 → full).
- **Rollback:** restore `Math.round`.

### RENDER-05 — Align the usage-bar color with the label escalation
- **Rationale:** Q3. 81–89% shows a red bar beside calm text.
- **Files:** `statusline.js` (`usageSeg` `325-331`, `bar` `263-268`).
- **Exact change:** the usage bar should not go red until the label does (`warn`, default 90). The
  simplest correct change that does not disturb the context bar (which legitimately reds at
  `yellow`): pass the usage `warn` value into the bar's color decision only for `usageSeg`. Concrete:
  add an optional 4th arg to `bar(pct, width, t, redAt)` where `redAt` defaults to `t.yellow`; in
  `usageSeg` call `bar(pct, 8, t, warnAtOf(t))`. In `bar`, color = `pct <= t.green ? green : pct < redAt ? yellow : red` (so yellow now spans up to `warn`). Leave the context-bar call
  (`collectSegments:1288`) unchanged so it keeps its `green/yellow` behavior.
- **Dependencies:** none. (Cosmetic; lowest priority — may be deferred without blocking anything.)
- **Parallelization:** shares `statusline.js` → worktree isolation.
- **Acceptance criteria:**
  - `node --test` + `--selftest` pass; the existing `usage bars render` test (`test.js:113`) still
    green.
  - New `test-unit.js` (or extend `bar`): `usageSeg`/`bar` colored output at 85% contains no red
    (`\x1b[38;5;203m`) escape; at 91% it does.
- **Tests:** the color assertion above.
- **Edge cases:** a config with `warn` below `yellow` (odd but legal) — the `redAt` arg just follows
  `warn`; document that the bar tracks `warn`.
- **Rollback:** drop the 4th arg; `bar` reverts to `t.yellow` threshold.

---

## 8. Area-level verification

Run from the repo root, in a sandboxed shell per C10 (`env HOME=<sb> CLAUDE_CONFIG_DIR=<sb>/.claude
TMPDIR=<sb>/tmp CCBSL_NO_ACT=1`):

```
node --check statusline.js && \
node statusline.js --selftest && \
node --test && \
node -e 'const m=require("./statusline.js"); if(m.dispWidth("日本語")!==6) throw "CJK width regressed"; if((m.bar(94,8).match(/█/g)||[]).length>=8) throw "bar saturates <100"'
```
All must exit 0. The `--test` run must still report `# pass` ≥ its pre-change count plus the new
tests, `# fail 0`.

---

## 9. Risks & open questions for the human

- **RENDER-05 is a taste call.** The chosen direction (bar tracks `warn`, so 81–89% is yellow not
  red) is defensible but reverses today's "bar leads text by one tier." If the author *prefers* the
  bar to lead as an early-warning cue, RENDER-05 should instead **document** the gap (a comment at
  `usageSeg`) rather than change behavior. Flagged for the owner; lowest priority regardless.
- **`glyphWidth` range completeness (RENDER-03).** The ten ranges cover the names that actually
  occur (CJK, Hangul, kana, fullwidth). Rare wide scripts (e.g. some Yijing/Tangut astral blocks) are
  already caught by the `>= 0x1F000` rule; other exotic BMP wide chars are out of scope by the
  no-full-table non-goal. Confirm the owner is comfortable with "common cases, zero dependency" over
  "every Unicode wide char."
- No paid services, credentials, or migrations involved in this area.
