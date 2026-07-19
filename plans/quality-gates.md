# quality-gates (cross-cutting — second directive)

Rig produces three authored output surfaces (the rendered status bar, CLI text, and docs). The
second directive is **active**: for each surface, a quality failure must be **mechanically impossible
to ship**, not caught by vigilance. This plan installs a **single new file, `test-gates.js`**, that
unifies the surface gates behind one evolving rule source and wires into the repo's existing check
command (`node --test`) and CI with **no `.gitlab-ci.yml` change** (Node's runner auto-discovers
`test-*.js`, exactly like `test-unit.js`). Self-contained.

---

## 1. Current-state audit

**There is no mechanical quality gate today.** The three surfaces are individually in decent shape
(the render bar has `--selftest` for wrap correctness; the docs are hand-kept clean of em-dashes and
AI-tells; CLI text is mostly aligned), but nothing *enforces* any of it, and **real drift exists
right now**:

- **Config-drift (surface-adjacent, C6):** `statusline.config.example.json` is missing `show.update`,
  `color.update` (220), `color.agents` (141) vs `DEFAULTS` (`statusline.js:93-167`); `updatePubkey`
  is read by code (`1081`) but is in neither `DEFAULTS` nor the example. *(Verified by orchestrator.)*
- **Flag-parity:** `README.md` never mentions `--status`, `--disarm`, or `--selftest`, though they
  are real and (for `--status`/`--disarm`) advertised as the guardian's "not a hidden daemon" safety
  valves. `helpText` omits `--auto`/`--force` which README *does* mention. *(Verified.)*
- **Docs-voice:** currently **clean** — a comment-stripping scan found zero em-dashes and zero
  AI-tell words in the four `.md` files and every `statusline.js` string literal. The 11 em-dashes in
  `statusline.js` are in **source comments**, outside the doctrine's stated scope (docs + CLI output).
  The gate must scope to `.md` + literals or it fails on day one.

Because these gates share a concern (the code is the SSOT; every derived surface must match or stay
within a stated voice), they belong in **one file with one rule source**, per the directive's "drive
toward a single shared rule/definition source so the gates don't drift apart."

---

## 2. Enhancement opportunities, ranked

| # | Title | Impact | Effort | Files |
|---|---|---|---|---|
| G1 | `test-gates.js` skeleton + the docs-voice + CLI-literal scanners (GATE-01) | high | medium | `test-gates.js`, `statusline.js` (export prereq) |
| G2 | example-config-vs-`DEFAULTS` parity gate (GATE-02) | high | small | `test-gates.js` |
| G3 | `CONFIG.<key>`-reads-exist-in-`DEFAULTS` gate (GATE-03) | medium | small | `test-gates.js` |
| G4 | README↔`helpText` flag-parity gate (GATE-04) | medium | small | `test-gates.js` |

---

## 3. Correctness audit

The gates *find* correctness/consistency defects; the gate code itself must be correct. The one
subtlety to get right (a real risk of a false-positive gate) is **scope**: the docs-voice + literal
scanners must exclude `statusline.js` **source comments** (the 11 intentional em-dashes) and scan
only `.md` files + string literals. GATE-01's literal walker must therefore strip `/* */` and `//`
comments before extracting `'…'`/`"…"`/`` `…` `` literals. If it does not, the gate is red on day one
against intended content — the classic "gate that cries wolf" failure. No other correctness concern;
the gates are pure file reads + regex + set comparisons.

---

## 4. Performance audit

`test-gates.js` is a handful of file reads + regex over small files (~10ms against the ~13s suite
wall). It spawns **no** subprocess (unlike `test.js`). Negligible; no performance concern. It does
**not** run on the render hot path (C3) — it is a test file.

---

## 5. Quality audit + gate plan (this IS the gate plan)

This plan is the second directive's deliverable. Definition of done: **a quality failure on any of
the three surfaces is mechanically impossible to ship** — every surface's failure mode has a
`test-gates.js` (or, for the bar, a `test-unit.js`/`--selftest`) assertion in `node --test`, and the
gates share one rule source.

**Surface → gate map:**

| Surface | Failure modes | Gate | Home |
|---|---|---|---|
| Rendered bar | saturation before 100%, CJK overflow, color/label mismatch | `bar()`/`dispWidth()` unit asserts + `--selftest` CJK case | [render-core.md](render-core.md) RENDER-04/03/05 |
| CLI text | contradictory summaries, unnamed destructive targets, column drift, banned tells in literals | `test.js` behavioral asserts + `test-gates.js` GATE-01 literal scan | [cli-installer.md](cli-installer.md) CLI-09/11 + GATE-01 |
| Docs + literals | em-dash, AI-tell vocab; config drift; flag parity | `test-gates.js` GATE-01/02/03/04 | this plan |

**The shared rule source:** GATE-01 defines the `BANNED` array (em-dash regex + AI-tell word regex)
**once**; both the `.md` scan and the literal scan consume it. Config-drift and flag-parity read the
**exported `DEFAULTS`/`helpText`** (the code SSOT), so they cannot drift from what the code actually
does. This is the "single evolving definition of bad" the directive requires.

---

## 6. Scope & non-goals

**In scope:** one new file `test-gates.js` with four gates; the one-line `statusline.js` export
prereq (shared with [tests-ci.md](tests-ci.md) TEST-07); the drift/flag *fixes* that make the gates
land green (owned by [shell-docs.md](shell-docs.md) SHELL-06/07 and [update.md](update.md) UPD-07 —
this plan depends on them, does not duplicate them).

**Do NOT build / do NOT touch:**
- No markdown-lint / prose-lint / spellcheck npm dependency (C1). Zero-dep regex only.
- No new CI job — `test-*.js` auto-discovery means `node --test` and the existing CI pick it up. (Add
  only a `node --check test-gates.js` line to `.gitlab-ci.yml` alongside the other `--check` lines,
  for a syntax gate — a one-line addition, not a new job.)
- No expansion of the banned-word list beyond the doctrine's stated tells — over-broad word lists
  produce false positives and get disabled. Keep it to the verified em-dash + the classic AI-tells.
- Do not scan `statusline.js` **comments** — only `.md` files and string literals (see §3).
- No auto-fixing — the gate *fails*; humans fix. (Auto-rewriting prose is out of scope and risky.)

---

## 7. Implementation plan (fan-out-ready)

**Fan-out summary:** GATE-01 creates `test-gates.js` and depends on the export prereq
([tests-ci.md](tests-ci.md) TEST-07). GATE-02/03/04 add tests **into** `test-gates.js` — they should
be built in the same worktree as GATE-01 (same new file) or strictly after it. **Each of GATE-02 and
GATE-04 must land in the same MR as its drift/flag fix** (SHELL-06/UPD-07 for GATE-02; SHELL-07 for
GATE-04) so the gate is **green on landing** — a red-on-arrival gate gets reverted. GATE-01 and GATE-03
are green immediately (the docs are already clean; the `CONFIG.<key>` check passes once `updatePubkey`
is added by UPD-07 — so GATE-03 also pairs with UPD-07).

**Prerequisite (blocks all four): [tests-ci.md](tests-ci.md) TEST-07** — export `DEFAULTS`,
`DEFAULT_ORDER`, `MODES`, `helpText` from `statusline.js`'s module block (`1369-1374`).

---

### GATE-01 — `test-gates.js` skeleton + docs-voice + CLI-literal scanners
- **Rationale:** freeze the (currently clean) voice doctrine mechanically across `.md` files and CLI
  string literals.
- **Files:** `test-gates.js` (new), depends on `statusline.js` export (TEST-07); add `node --check
  test-gates.js` to `.gitlab-ci.yml`.
- **Exact change:** create `test-gates.js` (zero-dep, `node:test` + `node:assert` + `fs`):
  ```js
  'use strict';
  const test = require('node:test'); const assert = require('node:assert');
  const fs = require('fs'); const path = require('path');
  const SL = require('./statusline.js');
  const R = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
  const DOCS = ['README.md','SECURITY.md','CONTRIBUTING.md','CHANGELOG.md'];
  // the ONE shared rule source (extend here; both scanners consume it)
  const BANNED = [
    { re: /—/, name: 'em-dash' },
    { re: /\b(delv(?:e|es|ing)|seamless(?:ly)?|robust(?:ly|ness)?|comprehensive(?:ly)?|empowers?|empowering|leverag(?:e|es|ed|ing)|streamlin(?:e|ed|ing)|effortless(?:ly)?|cutting[- ]edge|game[- ]?chang\w*|blazing(?:ly)?|supercharged?)\b/i, name: 'AI-tell' },
  ];
  function scanLines(label, text) {
    const hits = [];
    text.split('\n').forEach((line, i) => { for (const b of BANNED) if (b.re.test(line)) hits.push(`${label}:${i+1} ${b.name}: ${line.trim().slice(0,80)}`); });
    return hits;
  }
  test('docs: no em-dash or AI-tell vocabulary', () => {
    const hits = DOCS.flatMap((f) => scanLines(f, R(f)));
    assert.strictEqual(hits.length, 0, 'banned tells in docs:\n' + hits.join('\n'));
  });
  test('CLI output: no banned tells in statusline.js string literals (comments excluded)', () => {
    let src = R('statusline.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // strip block + line comments
    const lits = src.match(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g) || [];
    const hits = []; for (const lit of lits) for (const b of BANNED) if (b.re.test(lit)) hits.push(`${b.name}: ${lit.slice(0,80)}`);
    assert.strictEqual(hits.length, 0, 'banned tells in CLI literals:\n' + hits.join('\n'));
  });
  ```
  Add `node --check test-gates.js` to `.gitlab-ci.yml` next to the other `--check` lines.
- **Dependencies:** TEST-07 (the `require('./statusline.js')` uses exports in later gates; GATE-01
  itself only needs the require to not run the CLI — the guard at `1368` already ensures that).
- **Parallelization:** new file → fully parallel with everything except its own GATE-02/03/04.
- **Acceptance criteria:**
  - `node --test` discovers and passes `test-gates.js` (both GATE-01 tests green **today** — verified
    the docs + literals are clean).
  - Deliberately inserting an em-dash into a `.md` file makes the docs test fail with a `file:line`
    message (verify once, then revert).
  - The line-comment strip must not corrupt URLs (`https://`) inside literals — the regex only strips
    `//` **outside** a string; verify a literal containing `https://gitlab.com/...` is still scanned
    and does not trip the comment stripper (test with the real README URLs present).
- **Tests:** the two gate tests are self-testing; add a `node --test` run.
- **Edge cases:** a literal spanning a template with `${}` (the regex treats the whole backtick span
  as one literal — fine); an apostrophe inside a double-quoted literal (handled by the alternation);
  the comment stripper must preserve `://` in URLs (the `[^:]` guard before `//` handles `https://`).
- **Rollback:** delete `test-gates.js` + the `--check` line.

### GATE-02 — example-config-vs-`DEFAULTS` parity
- **Rationale:** C6 — the example is a hand-mirrored copy that drifts (real drift exists now).
- **Files:** `test-gates.js`. **Lands with [shell-docs.md](shell-docs.md) SHELL-06 + [update.md](update.md) UPD-07** (which fix the drift so this is green).
- **Exact change:** add a test that flattens the exported `SL.DEFAULTS` and
  `JSON.parse(R('statusline.config.example.json'))` (ignoring `_`-prefixed keys), asserts **identical
  key sets both directions** and **identical values**, with an explicit
  `ALLOW_DIFFERENT = new Set(['profileLabels'])` (the example intentionally documents sample labels
  in its `_comment`, and ships `{}` to match `DEFAULTS` after SHELL-06). Also assert the example's
  `order` array deep-equals `SL.DEFAULT_ORDER`.
  ```js
  function flatten(o, p, out) { for (const k of Object.keys(o)) { if (k.startsWith('_')) continue;
    const key = p ? p+'.'+k : k; const v = o[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out); else out[key] = Array.isArray(v)?JSON.stringify(v):v; } return out; }
  ```
- **Dependencies:** TEST-07 (exports); SHELL-06 + UPD-07 (the fixes). **Must merge together.**
- **Parallelization:** same file as GATE-01 → one worktree.
- **Acceptance criteria:**
  - Green **after** SHELL-06/UPD-07: identical key sets (minus `profileLabels`) and values; `order`
    equal.
  - Failing a value (e.g. reverting `color.update`) makes the gate report the exact drifting key path.
- **Tests:** the parity test.
- **Edge cases:** `profileLabels` (allowed to differ — `{}` in DEFAULTS, sample in `_comment`);
  nested objects (`show`, `thresholds`, `color`) flattened by dotted path; arrays compared as JSON.
- **Rollback:** delete the test.

### GATE-03 — every `CONFIG.<key>` the code reads exists in `DEFAULTS`
- **Rationale:** C6 — `updatePubkey` is read but absent from the SSOT; catch the next such orphan
  mechanically.
- **Files:** `test-gates.js`. **Pairs with [update.md](update.md) UPD-07** (adds `updatePubkey` to
  `DEFAULTS`).
- **Exact change:** add a test that regexes `/CONFIG\.([A-Za-z_]\w*)/g` over `R('statusline.js')`,
  collects the captured top-level keys, and asserts each is a key of `SL.DEFAULTS` (allow a small
  documented allowlist if any key is legitimately dynamic — none known today).
- **Dependencies:** TEST-07; UPD-07 (so `updatePubkey` is present → green).
- **Parallelization:** same file → one worktree.
- **Acceptance criteria:** green after UPD-07; adding a `CONFIG.somethingNew` read without adding it
  to `DEFAULTS` fails the gate with the key name.
- **Tests:** the reads-in-DEFAULTS test.
- **Edge cases:** `CONFIG.thresholds.usage` (only the top-level `thresholds` is checked — nested
  access is fine since `thresholds` is a DEFAULTS key); `CONFIG.color[k]` dynamic access (the regex
  captures `color`, which is in DEFAULTS).
- **Rollback:** delete the test.

### GATE-04 — README↔`helpText` flag parity
- **Rationale:** the "full flag list" pointer must be true; catch missing docs mechanically.
- **Files:** `test-gates.js`. **Lands with [shell-docs.md](shell-docs.md) SHELL-07** (adds
  `--auto`/`--force` to help) and the README additions of `--status`/`--disarm`/`--selftest`.
- **Exact change:** add a test: `const helpFlags = new Set(SL.helpText().match(/--[a-z][a-z-]+/g))`;
  `const readmeFlags = new Set(R('README.md').match(/--[a-z][a-z-]+/g))`; with
  `ALLOWLIST = new Set(['--hook','--watch'])` (internal, intentionally undocumented), assert every
  `helpFlag` not in the allowlist appears in `readmeFlags`, **and** every `readmeFlag` not in the
  allowlist appears in `helpFlags`. Report the offending flags on failure.
- **Dependencies:** TEST-07; SHELL-07 + the README flag additions (so it is green). Coordinate the one
  canonical flag list with [cli-installer.md](cli-installer.md) CLI-10's `KNOWN` set and
  [update.md](update.md) UPD-05's `--dismiss-update`.
- **Parallelization:** same file → one worktree.
- **Acceptance criteria:** green after SHELL-07 + README updates; removing `--selftest` from README
  (or `--auto` from help) fails the gate naming the flag.
- **Tests:** the parity test.
- **Edge cases:** a flag mentioned in README prose as part of a longer token (the `--[a-z][a-z-]+`
  regex matches whole flags only); `--cols` (a value modifier, appears in both — fine);
  `--dismiss-update` (if UPD-05 lands, it must be in both).
- **Rollback:** delete the test.

---

## 8. Area-level verification

```
node --check test-gates.js && \
node --test test-gates.js && \
node --test
```
All green. To prove the gates bite: temporarily insert an em-dash into `README.md` and revert
`color.update` in the example, run `node --test test-gates.js`, confirm two failures with precise
locations, then revert both.

---

## 9. Risks & open questions for the human

- **The banned-word list is a taste boundary.** The list is deliberately narrow (verified tells). If
  the owner wants it broader or narrower, edit the single `BANNED` array in `test-gates.js` — that is
  the one rule source by design. Flagged so the owner knows where the knob is.
- **GATE-02/03/04 are red until their paired fixes land** (SHELL-06, UPD-07, SHELL-07). The roadmap
  sequences each gate into the same MR as its fix; do not merge a gate ahead of its fix or CI goes
  red. This is the one hard ordering constraint of the quality track.
- No paid services, credentials, or migrations. The gate is a zero-dep test file.
