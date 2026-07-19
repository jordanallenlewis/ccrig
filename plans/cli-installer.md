# cli-installer

The CLI layer, the install/uninstall/doctor machinery, and the config editor. This area has the
highest bug density in the repo and the two genuinely HIGH-severity correctness bugs, plus the
surface that caused a real destructive incident during the audit. Near-flagship depth. Self-contained.

---

## 1. Current-state audit

**What it does.** `statusline.js` is a linear argv dispatcher — no parser. `argv` is captured at
`1364`. A module-export guard (`1368-1376`) means `require()` exports helpers and never runs the
CLI. `--help`/`--version` exit early (`1411-1419`). One-shot modes dispatch in a fixed if-chain:
`--hook`/`--watch` (`1728-1729`, internal), `--status` (`1730`), `--disarm` (`1731`, reads the
**next** argv blindly as a sid), `--purge` (`1732`), `--board` (`1733`), `--sessions` (`1734`),
`--check-update`/`--update` (`1735-1736`), `--whatsnew` (`1737`), `--options` (`1774`). The
mutual-exclusion gate (`EXCLUSIVE`, `2128-2133`) sits **after** all of those and lists only
`--install`, `--install-guardian`, `--uninstall`, `--uninstall-guardian`, `--doctor`, `--config`,
`--demo`, `--selftest`, `--mode`, `--autopilot`, `--keep-working`.

**Install wiring:** `settingsPathOf`/`readSettingsRaw`/`backupSettings` (`1777-1791`, single-slot
`.bak`); `writeSlashCommand` (`1795-1841`, bakes `__filename` into `commands/statusline-config.md`);
`installStatusLineInto` (`1844-1860`, unconditionally overwrites `settings.statusLine` at `1854`);
`runInstall` (`1861-1891`); guardian wiring (`1893-2002`; `stripGuardianHooks` at `1901` is surgical
and correctly preserves the user's own hooks); `uninstallFrom`/`runUninstall` (`2005-2047`) with the
`ownsStatusLine` heuristic at `2015`. `runDoctor` (`2050-2125`) checks node version, settings parse,
statusLine shape, **only double-quoted** absolute paths (`2078-2082`), config parse, git, guardian
wiring (`2096-2108`, no path checks inside hook commands), update cache, and a test render.

**Profile detection:** `detectProfiles` (`1165-1180`) treats every `~/.claude-*` directory as a
profile except two hardcoded `NON_PROFILE_DIRS` (`1158`).

**Setters:** `--autopilot`/`--keep-working`/`--mode` (`2136-2167`) validate values properly. `--demo`
(`2177-2200`) handles garbage `--cols`. The config editor `runConfigEditor` (`2268-2311`) buffers
piped lines and handles EOF/junk/out-of-range cleanly. `diffFromDefaults`/`saveConfig`
(`2249-2267`) persist a sparse diff with round-trip validation.

**Listings:** `runBoard` (`1664-1692`, prunes >1h files even when `sessionBoard` off — verified safe:
atomic writes, dir is exclusively ours), `runSessions` (`1694-1727`, `readHead` 16KB cwd scan,
POSIX-only `shellQuote` at `1661`).

**Health: good** structurally (atomic writes, sparse config, surgical hook stripping, backups before
destructive writes, 124-test suite), but the weaknesses cluster into a coherent set: **flag-gate
placement, an ownership-predicate asymmetry, doctor blind spots, single-slot backups, and silent
replacement/deletion of third-party status lines.**

**Output surface 2 read (CLI text):** `--help`/`--doctor` are in good shape (aligned columns,
clear `ok`/`FAIL`/`--` prefixes, honest network disclosure). Three failures: the `--install`
summary contradicts itself when a profile is skipped; `--purge`/`--disarm` never name their target
profile/dirs (the incident below would have been visible if they did); `--options` value columns
drift (hardcoded 8-space gaps).

---

## 2. Enhancement opportunities, ranked

| # | Title | Impact | Effort | Files |
|---|---|---|---|---|
| E1 | Hoist + complete the `EXCLUSIVE` gate (CLI-01) | high | small | `statusline.js`, `test.js` |
| E2 | One `isOurCmd` ownership predicate shared by uninstall/hook-strip/doctor (CLI-04) | high | small | `statusline.js` |
| E3 | Doctor: path-check hook commands, unquoted tokens, and the baked slash-command path (CLI-06) | high | small | `statusline.js`, `test.js` |
| E4 | Install: announce foreign-statusLine replacement + protect its backup (CLI-07) | medium | small | `statusline.js`, `test.js` |
| E5 | `detectProfiles` requires a Claude marker for non-active dirs (CLI-08) | medium | small | `statusline.js`, `test.js` |
| E6 | Destructive commands print their target profile header (CLI-09) | medium | small | `statusline.js`, `test.js` |
| E7 | Strict unknown-flag rejection on the manual fallthrough (CLI-10) | medium | small | `statusline.js`, `test.js` |
| E8 | `--options` column alignment via `pad()`; `--sessions` cwd recovery (CLI-11) | low | small | `statusline.js` |

---

## 3. Correctness audit

**BUG-CLI-1 — one-shot flags dispatch before the `EXCLUSIVE` gate: combined commands silently drop the second flag.** *[HIGH; CONFIRMED — reproduced by orchestrator]*
- Path: `--status`/`--disarm`/`--purge`/`--board`/`--sessions`/`--check-update`/`--update`/
  `--whatsnew` (`1728-1737`) and `--options` (`1774`) all run and `process.exit` **before** the
  `EXCLUSIVE` gate at `2128`, which also omits them from its list. `node statusline.js --purge
  --install` **purges and exits 0 without installing** — the user believes both happened. Worse,
  `--disarm` reads the next argv blindly (`1731`): `--disarm --purge` treats the string `'--purge'`
  as a session id, matches no watcher, prints `disarmed 0 watcher(s)`, and performs **neither**
  action while an armed watcher survives.
- Repro (orchestrator): `node statusline.js --purge --install` → `purged local guardian state (...)`,
  exit 0, no `settings.json` created.
- Fix: CLI-01.

**BUG-CLI-2 — uninstall ownership asymmetry: from a moved/re-downloaded copy, `--uninstall` removes the statusLine but leaves all three guardian hooks wired.** *[HIGH; CONFIRMED — code-decisive]*
- Path: `ownsStatusLine` (`2015`) matches the generic substring `'statusline.js'`, but
  `isGuardianHookCmd` (`1896`) requires `command.includes(__filename)` — the **exact path of the
  running copy**. Run `--uninstall` from a moved folder (or a re-download) and the statusLine is
  removed (name substring matches) while the Stop/SessionStart/PreCompact hooks are **not** (they
  point at the old path, which is not this `__filename`). Result: zombie hooks that keep firing
  against the old path forever; if the old copy was deleted, every stop/resume/compact spawns a
  failing node process. README promises full reversibility (C7); this breaks it. (Live-observed
  during the audit incident: a sandbox copy's `--uninstall` removed the real install's statusLine
  yet left its three hooks.)
- Fix: CLI-04 (the shared predicate) → CLI-02 uses it.

**BUG-CLI-3 — `--uninstall` deletes a LIVE third-party status line whose script merely happens to be named `statusline.js`.** *[medium; CONFIRMED — code-decisive + auditor repro]*
- Path: `ownsStatusLine` = `slCmd.includes(__filename) || slCmd.includes('statusline.js')` (`2015`).
  A user's own `~/bin/statusline.js` or another project's `statusline.js` matches the substring;
  `--uninstall` removes it and reports success, contradicting the code's own comment "never delete a
  third-party status line."
- Fix: CLI-04 + CLI-05.

**BUG-CLI-4 — `--doctor` false-passes on a dead UNQUOTED statusLine command ("All checks passed", exit 0).** *[medium; CONFIRMED — independently re-verified in a sandbox: unquoted dead `node /dead/.../statusline.js` command → "All checks passed", exit 0]*
- Path: the path check only extracts double-quoted tokens (`/"([^"]+)"/g`, `2078`). A command like
  `node /dead/path/statusline.js` yields zero quoted paths → `info 'no quoted absolute paths...'` →
  doctor exits 0 "All checks passed" while the status line is completely broken. (Control: the same
  path quoted is correctly caught.)
- Fix: CLI-06.

**BUG-CLI-5 — `--doctor` reports "guardian hooks wired" without checking the hook commands' paths exist.** *[medium; CONFIRMED — independently re-verified: all three hooks pointed at a nonexistent node path, doctor printed "ok guardian hooks wired (Stop, SessionStart, PreCompact) ... All checks passed", exit 0]*
- Path: doctor validates paths only inside `statusLine.command`; guardian hook commands
  (`2096-2108`) are never path-checked. After a node-version-manager upgrade the user re-runs
  `--install` (which fixes only `statusLine`), and doctor then shows "ok guardian hooks wired ... All
  checks passed" while every hook silently fails against a dead node path.
- Fix: CLI-06.

**BUG-CLI-6 — `--install` silently replaces a third-party statusLine, and a second run destroys the only backup of it.** *[medium; CONFIRMED — independently re-verified: first `--install` replaced a custom statusLine with no notice; second `--install` overwrote the single `.bak` slot, leaving the original unrecoverable]*
- Path: `installStatusLineInto` overwrites `settings.statusLine` unconditionally (`1854`) with no
  notice. `backupSettings` (`1787`) keeps a **single** `.bak` slot overwritten on every
  install/guardian-install/uninstall. So `--install; --install` (or `--install` then
  `--install-guardian`) leaves the user's original custom bar unrecoverable. (`--install-guardian`
  correctly preserves an existing statusLine at `1930-1932`; only `--install` stomps it.)
- Fix: CLI-07.

**BUG-CLI-7 — `detectProfiles` wires foreign `~/.claude-*` tool directories as profiles, writing `settings.json` and `commands/` into them.** *[medium; CONFIRMED — auditor repro]*
- Path: any `~/.claude-*` dir except the two `NON_PROFILE_DIRS` (`1158`) is treated as a profile
  (`1165-1180`). Real tools use this namespace (`~/.claude-code-router`, `~/.claude-flow`, backup
  dirs). `--install` then creates `settings.json` + `commands/statusline-config.md` **inside another
  tool's state dir**, and the inflated count makes the `👤` badge appear for single-profile users.
- Fix: CLI-08.

**BUG-CLI-8 — `--uninstall` leaves the `/statusline-config` slash command (and update cache) behind when the statusLine is foreign.** *[low; CONFIRMED — auditor repro]*
- Path: `uninstallFrom` early-returns at `2017` when nothing removable is found, but the
  slash-command deletion (`2023`) and update-cache cleanup (`2024`) sit **after** it. A user who
  switched status lines and runs `--uninstall` to clean up keeps `commands/statusline-config.md`
  (so `/statusline-config` still appears) plus a stale `.ccbsl-update.json`.
- Fix: CLI-03 (part of the uninstall hardening).

**BUG-CLI-9 — `--install` summary claims "All your Claude profiles now show the bar" even when a profile was skipped, and exits 0.** *[low; CONFIRMED — auditor repro]*
- Path: `runInstall` (`1876-1879`) prints "N profile(s) wired, M skipped. All your Claude profiles
  now show the bar." — self-contradictory when M>0 — and exits 0 despite failures, while
  `runUninstall` exits 1 on any error (`2046`).
- Fix: CLI-09 (surface) + exit-code alignment.

---

## 4. Performance audit

**Not on the hot path.** Claude Code invokes with zero args, so `1364-2311` costs only ~20
`argv.includes()` scans over an empty array (sub-microsecond). `--sessions` over 300 transcripts
measured 0.089s wall — essentially the Node-startup floor; `readHead` caps per-file reads at 16KB
and only the newest 15 rows call `latestUserText`. **No performance task.** Do not cache session
listings or parallelize reads — zero perceptible gain on a manual command, added complexity for
nothing.

---

## 5. Quality audit + gate plan (this area owns output surface 2: CLI text)

- **Q1 — `--install` contradictory summary.** `1876-1879`. Remediation: CLI-09 — print the
  celebratory line only when `failed.length === 0`; otherwise "Wired N of M profiles; fix the
  skipped one(s) and re-run." Gate: a `test.js` REGRESSION asserting the output does **not** match
  `/All your Claude profiles now show the bar/` when a skip occurred.
- **Q2 — destructive commands don't name their target.** `runPurge` (`1648`)/`runDisarm` (`1633`)
  print no profile/dirs; `runStatus` already prints `profile: <CFG>`. Remediation: CLI-09/CLI-06 —
  add the same header + list the removed dirs. Gate: `test.js` asserting `--purge` output contains
  the sandbox CFG path. (This is also a *safety* win: the audit incident would have been visible.)
- **Q3 — `--options` column drift.** `runOptions` (`1740-1773`) uses hardcoded 8-space gaps (7 for
  `autopilot buf` at `1755`). Remediation: CLI-11 — use the existing `pad()` (`1660`). Gate: a
  unit-style check that every `--options` descriptor starts at the same column.

These gates are `test.js`/unit assertions inside `node --test` (C9). The cross-surface docs-voice
scanner is in [quality-gates.md](quality-gates.md); CLI text is covered by its literal-scan
(surface 3) for banned tells, and by these behavioral assertions for structure.

---

## 6. Scope & non-goals

**In scope:** the flag-gate hoist + `--disarm` value validation; the unified ownership predicate;
doctor path-checking (hooks + unquoted + slash-command); install replacement notice + backup
protection; profile-marker gating; destructive-command headers; strict unknown-flag rejection;
`--options` alignment; `--sessions` cwd recovery.

**Do NOT build / do NOT touch:**
- No argv-parser dependency or subcommand framework (C1). The linear dispatcher is fine once the
  gate is hoisted.
- No Windows cmd/PowerShell quoting engine for `--sessions` output — that is display-only text; a
  doc note + the win32 branch in [xplatform.md](xplatform.md) XPLAT-06 covers it. Do not build a
  general cross-shell quoter here.
- No interactive y/N confirmation prompts on `--uninstall`/`--purge` — they would break scripted use
  (the installer one-liners, CI). The headers + warnings + backups below cover the risk.
- No config-editor feature growth (threshold editing, color pickers) — `/statusline-config` covers
  rich editing through Claude.
- No multi-slot timestamped backup manager — one-deep protection (CLI-07) is enough.
- Do **not** change `runBoard` pruning — verified safe (atomic writes, exclusively-ours dir,
  prune-when-off is desirable cleanup).
- Do **not** touch `stripGuardianHooks` (`1901`) — it is correctly surgical.

---

## 7. Implementation plan (fan-out-ready)

**Fan-out summary:** all tasks edit `statusline.js` → **worktree isolation required** for any
parallel development, with a merge sequence. The natural ordering:
- **CLI-04 (shared predicate) must land before CLI-02 and CLI-05** (they consume it).
- CLI-01, CLI-04, CLI-08, CLI-10 are otherwise independent of each other.
- CLI-06 (doctor) is independent but benefits from CLI-04 (reuses `isOurCmd`).
- CLI-03, CLI-07, CLI-09, CLI-11 are independent.
All regression tests depend on the hermetic harness ([tests-ci.md](tests-ci.md) TEST-01/02) being in
place first.

---

### CLI-01 — Hoist and complete the `EXCLUSIVE` gate; validate `--disarm`'s value
- **Rationale:** BUG-CLI-1.
- **Files:** `statusline.js`, `test.js`.
- **Exact change:** Move the `EXCLUSIVE`/`picked`/`exit 1` block (`2127-2133`) to **immediately
  above** the one-shot dispatch at `1728`. Extend the `EXCLUSIVE` array with `'--board'`,
  `'--sessions'`, `'--status'`, `'--disarm'`, `'--purge'`, `'--options'`, `'--update'`,
  `'--check-update'`, `'--whatsnew'`. Keep `'--hook'` and `'--watch'` **out** (installer-wired,
  never user-typed, early-return). In `runDisarm`'s dispatch (`1731`) validate the positional value:
  if it starts with `--` or fails `SID_RE` (`/^[A-Za-z0-9-]+$/`, defined at `392`), print
  `usage: --disarm [session-id]` and exit 1; a bare `--disarm` with no value stays valid (disarms
  all).
- **Dependencies:** none (test needs TEST-01/02).
- **Parallelization:** shares `statusline.js` → worktree isolation.
- **Acceptance criteria:**
  - `node --test` passes; existing exclusive-flag tests (`test.js:578`, `:584`) still green.
  - New REGRESSION (`REGRESSION: one-shot flags respect the exclusive gate`): `run(['--purge',
    '--install'])` → exit 1, output `/pick one of/`, and no `settings.json` written in the sandbox;
    `run(['--disarm','--purge'])` → exit 1. Fails today (exit 0, purge runs).
- **Tests:** the REGRESSION above.
- **Edge cases:** `--mode minimal` (a value-taking flag) must not be read as two exclusive flags —
  the gate already handles `--mode` correctly; verify `--disarm <sid>` alone still works.
- **Rollback:** move the gate back below the dispatch; revert the array + `--disarm` validation.

### CLI-04 — Single `isOurCmd` ownership predicate
- **Rationale:** BUG-CLI-2, BUG-CLI-3 share a root cause: `statusLine` and hook matching use
  different breadth. Unify them.
- **Files:** `statusline.js`.
- **Exact change:** add near `isGuardianHookCmd` (`1896`):
  ```js
  // does this settings command belong to THIS tool? our exact file, OR a stale reference to a
  // now-missing path ending in statusline.js (a moved/partial install), never a live foreign script.
  function isOurCmd(cmd) {
    if (typeof cmd !== 'string') return false;
    if (cmd.includes(__filename)) return true;
    const paths = [...cmd.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const bare = cmd.split(/\s+/);
    for (const t of paths.concat(bare)) {
      if (/(^|[\/\\])statusline\.js$/.test(t)) {
        try { if (!fs.existsSync(t)) return true; } catch { return true; } // stale ours
        return false;                                                       // exists & not us → foreign
      }
    }
    return false;
  }
  ```
  Then: `isGuardianHookCmd` becomes `isOurCmd(h.command) && h.command.includes('--hook')`;
  `ownsStatusLine` (`2015`) becomes `isOurCmd(slCmd) || slCmd === ''` (keep the documented
  empty-command-is-ours behavior at `2011-2012`); doctor's "points at a different script" info
  (`2075`) uses `!isOurCmd(cmd)`.
- **Dependencies:** none. **Unblocks CLI-02 and CLI-05.**
- **Parallelization:** shares `statusline.js` → worktree isolation; land before CLI-02/CLI-05.
- **Acceptance criteria:** `node --test` passes; existing uninstall tests (`test.js:457`, `:471`,
  `:1078`, `:1090`) still green.
- **Tests:** covered by CLI-02/CLI-05 regressions.
- **Edge cases:** a command with `statusline.js` inside an `sh -c` body; a Windows path with
  backslashes (the regex handles both separators); a command-less `{type:'static'}` statusLine
  (stays "ours").
- **Rollback:** inline the old predicates back.

### CLI-02 — `--uninstall` removes the guardian hooks even from a moved copy
- **Rationale:** BUG-CLI-2. Consumes CLI-04's `isOurCmd`.
- **Files:** `statusline.js`, `test.js`.
- **Exact change:** with `isGuardianHookCmd` now using `isOurCmd` (CLI-04), the hook stripping
  already matches by name-or-stale, so a moved-copy uninstall strips them. Verify `uninstallFrom`
  (`2005`) and `runUninstall` (`2028`) need no further change beyond CLI-04. Add the regression.
- **Dependencies:** CLI-04.
- **Parallelization:** worktree isolation; after CLI-04.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: --uninstall from a moved copy removes the guardian hooks too`):
    install-guardian with copy A (in `dirA`), `--uninstall` with copy B (in `dirB`), assert
    `settings.hooks` has no Stop/SessionStart/PreCompact group containing `--hook`. Fails today.
  - `node --test` passes.
- **Tests:** the REGRESSION above.
- **Edge cases:** copy A still exists on disk (then `isOurCmd` says foreign for A's path — but A's
  hooks were wired with A's `__filename`; the name-match with stale-check: A exists so it is
  "foreign," meaning we would NOT strip. **Decision:** the intended breadth is "our tool by name,"
  so guardian-hook stripping should match by name regardless of existence — keep the
  `--hook`-substring + name-match, and accept that two *different installs of this same tool* both
  count as ours (they are). Document this in a comment: uninstall removes any Rig hook, not only the
  running copy's.) Re-verify the test asserts removal when A still exists too.
- **Rollback:** revert with CLI-04.

### CLI-05 — `--uninstall`/`--install` leave a LIVE foreign `statusline.js` untouched
- **Rationale:** BUG-CLI-3. Consumes CLI-04.
- **Files:** `statusline.js`, `test.js`.
- **Exact change:** `ownsStatusLine` via `isOurCmd` (CLI-04) now returns false for a *live* foreign
  `~/bin/statusline.js`, so `--uninstall` prints the existing "third-party status line was left
  untouched" line (`2037`) instead of deleting it.
- **Dependencies:** CLI-04.
- **Parallelization:** worktree isolation; after CLI-04.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: --uninstall leaves a LIVE third-party statusline.js untouched`):
    settings point at an existing `<home>/bin/statusline.js`; run `--uninstall`; assert `statusLine`
    survives and output matches `/left untouched/`. Fails today.
  - `node --test` passes.
- **Tests:** the REGRESSION above.
- **Edge cases:** the foreign script does not exist (then it is treated as stale-ours — acceptable,
  it is a dead entry); our own install (`__filename`) still removed.
- **Rollback:** revert with CLI-04.

### CLI-06 — Doctor: path-check hook commands, unquoted tokens, and the baked slash-command path
- **Rationale:** BUG-CLI-4, BUG-CLI-5, and the stale-slash-command blind spot.
- **Files:** `statusline.js`, `test.js`.
- **Exact change:** extract the quoted-paths check (`2078-2082`) into
  `checkCmdPaths(cmd) → {checked, missing}`; when no quoted tokens exist, fall back to
  whitespace-split absolute tokens (`path.isAbsolute(t) && !t.startsWith('-')`). Apply it to:
  (a) `statusLine.command` as today; (b) every guardian hook command matching `isGuardianHookCmd`
  inside the wired-hooks branch (`2102`), FAILing with `fix: re-run --install-guardian`; (c) the
  script path baked into `slashCommandPath(CFG)` content — read the file, extract the line after
  `The script is:`, FAIL with `fix: re-run --install` if that path is missing.
- **Dependencies:** benefits from CLI-04 but does not require it.
- **Parallelization:** worktree isolation.
- **Acceptance criteria:**
  - Three new REGRESSIONs, each asserting exit 1: dead unquoted `statusLine` command
    (`/do not exist/`); dead node path inside guardian hooks
    (`/do not exist|re-run --install-guardian/`); stale slash-command path (`/re-run --install/`).
    All fail today.
  - Existing doctor tests (`test.js:495`, `:504`, `:513`, `:524`, `:533`, `:1135`) still green.
- **Tests:** the three REGRESSIONs.
- **Edge cases:** an `sh -c '...'` wrapper command (the existing test `test.js:524` must stay green —
  prefer quoted tokens when any exist, only fall back to whitespace-split when there are none); a
  Windows `C:\...` path inside quotes (already handled by `path.isAbsolute` under `path.win32`).
- **Rollback:** revert `checkCmdPaths` extraction and the three call sites.

### CLI-07 — `--install`: announce foreign-statusLine replacement and protect its backup
- **Rationale:** BUG-CLI-6.
- **Files:** `statusline.js`, `test.js`.
- **Exact change:** (a) in `installStatusLineInto` (`1844`), when an existing
  `settings.statusLine.command` is present and `!isOurCmd(...)` (CLI-04) and not empty, capture it in
  the result; in `runInstall` (`1869`) print `--  replaced existing status line: <cmd> (kept in
  <backup>)`. (b) in `backupSettings` (`1787`): do **not** overwrite an existing `.bak` whose
  content contains no `statusline.js` reference (i.e. a pristine pre-Rig backup) — instead write a
  one-deep `settings.json.bak.1` for the current content, preserving the original `.bak`.
- **Dependencies:** CLI-04 (for `isOurCmd`).
- **Parallelization:** worktree isolation.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: replacing a foreign status line is announced and its backup
    survives a second install`): settings have `my-custom-bar`; first `--install` output matches
    `/replaced existing status line/`; after a second `--install`, **some** backup file still
    contains `my-custom-bar`. Both assertions fail today.
  - Existing install tests (`test.js:367`, `:429`, `:439`, `:447`) still green.
- **Tests:** the REGRESSION above.
- **Edge cases:** first-ever install (no prior settings — no `.bak`, no notice); re-install of our
  own bar (no notice, normal single-slot `.bak`).
- **Rollback:** revert the notice + the backup-protection branch.

### CLI-08 — `detectProfiles` requires a Claude marker for non-active dirs
- **Rationale:** BUG-CLI-7.
- **Files:** `statusline.js`, `test.js`.
- **Exact change:** in `detectProfiles` (`1165-1180`), for dirs **other than** the active `CFG`,
  add only if the dir contains a Claude marker: `fs.existsSync(path.join(p,'settings.json')) ||
  fs.existsSync(path.join(p,'.credentials.json')) || fs.existsSync(path.join(p,'projects'))`.
  Keep `NON_PROFILE_DIRS` (`1158`) as a fast reject. In `runInstall` only, print
  `--  skipped ~/.claude-foo: no Claude settings found (wire it explicitly with
  CLAUDE_CONFIG_DIR=... --install --this-profile)` for skipped candidates.
- **Dependencies:** none.
- **Parallelization:** worktree isolation.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: --install does not wire a marker-less .claude-* directory`): create
    `<home>/.claude-code-router` (empty), run `--install`, assert no `settings.json` under it and
    output does not match `/code-router/`. Fails today. Complements `test.js:407`.
  - The all-profiles test (`test.js:382`) still green (its `.claude-personal` has a marker or is the
    active target — verify the fixture creates a marker; if not, update the fixture to add one).
- **Tests:** the REGRESSION above.
- **Edge cases:** the active `CFG` is always included even without a marker (it is the explicit
  target); a `~/.claude-backup-2025` with a stray `settings.json` inside would still match (accepted
  — it looks exactly like a profile).
- **Rollback:** revert the marker check.

### CLI-03 — `--uninstall` cleans the slash command + update cache even when the statusLine is foreign
- **Rationale:** BUG-CLI-8.
- **Files:** `statusline.js`, `test.js`.
- **Exact change:** hoist the two cleanup try-blocks (`2023-2024`) **above** the early return at
  `2017` — both files are unconditionally ours regardless of statusLine ownership. Report
  `--  removed /statusline-config command` when the file existed.
- **Dependencies:** none (independent of CLI-04/05, but touches the same `uninstallFrom` — coordinate
  the merge).
- **Parallelization:** worktree isolation; merge alongside CLI-02/CLI-05 carefully (same function).
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: --uninstall removes the slash command even when the status line is
    foreign`): install, then point statusLine at a foreign bar, then `--uninstall`; assert
    `commands/statusline-config.md` is gone. Fails today.
- **Tests:** the REGRESSION above.
- **Edge cases:** no slash command present (no-op, no error).
- **Rollback:** move the cleanup back below the early return.

### CLI-09 — Honest `--install` summary + aligned exit codes + skip notes
- **Rationale:** BUG-CLI-9, Q1.
- **Files:** `statusline.js`, `test.js`.
- **Exact change:** in `runInstall` (`1876-1879`): print "All your Claude profiles now show the bar."
  only when `failed.length === 0`; else "Wired N of M profiles; fix the skipped one(s) and re-run."
  Exit 1 when `failed.length && okd.length` (partial) — or document exit-0-means-at-least-one in
  `helpText`; **decision:** exit 1 on any skip, matching `runUninstall`'s policy (`2046`). In
  `uninstallFrom` (`1981`), return a note for `invalid`/`notObject` state so `runUninstall` prints
  `--  skipped <profile>: settings.json unreadable`.
- **Dependencies:** none.
- **Parallelization:** worktree isolation.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: --install summary does not claim all profiles wired when one was
    skipped`): a second profile with corrupt `settings.json`; assert output does **not** match
    `/All your Claude profiles now show the bar/`, matches `/of 2|skipped/`, and exit code 1. Fails
    today (exit 0, celebratory line).
- **Tests:** the REGRESSION above.
- **Edge cases:** all profiles succeed (celebratory line, exit 0); all fail (existing "install
  failed" path, exit 1).
- **Rollback:** revert the summary + exit-code change.

### CLI-10 — Strict unknown-flag rejection on the manual fallthrough
- **Rationale:** a human typo (`--instal`, `--this-profile` alone) currently renders the bar
  silently when stdin is piped, instead of erroring.
- **Files:** `statusline.js`, `test.js`.
- **Exact change:** just before the render fallthrough (`2316`), add: build
  `const KNOWN = new Set([... every flag from helpText + '--cols','--this-profile','--auto',
  '--force','--hook','--watch'])`; if `argv.some(a => a.startsWith('--') && !KNOWN.has(a))` then print
  `unknown flag: <a>` + a one-line help hint and `exit 1`. **Zero hot-path cost** — Claude Code
  always invokes with `argv.length === 0`, so this branch is never entered on the render path (C3).
- **Dependencies:** none (but the `KNOWN` set overlaps the quality-gates flag-parity list — keep one
  canonical flag list; see [quality-gates.md](quality-gates.md) GATE-04, which reads `helpText`).
- **Parallelization:** worktree isolation.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: an unknown flag errors instead of rendering`): `run(['--instal'],
    {stdin:'{}'})` → exit 1, output `/unknown flag/`.
  - Existing zero-arg render (`test.js:68`) and every real flag still work (spot-check `--demo`,
    `--help`, `--version`, `--this-profile` combined with `--install`).
- **Tests:** the REGRESSION above.
- **Edge cases:** `--cols 80` (value, not a flag — `80` does not start with `--`, fine);
  `--this-profile` alone with piped stdin (now errors — acceptable, it is meaningless alone).
- **Rollback:** remove the guard block.

### CLI-11 — `--options` column alignment + `--sessions` cwd recovery + destructive headers
- **Rationale:** Q2, Q3, BUG bundle of low-severity CLI-text polish.
- **Files:** `statusline.js`.
- **Exact change:** (a) in `runOptions` (`1740-1773`) replace hardcoded space gaps with
  `pad(value, 10)` (the `pad` helper exists at `1660`). (b) in `runSessions` (`1714`) bump
  `readHead(p, 16384)` to `65536` so a large first record still yields cwd; when still none, annotate
  the row `(run from its project dir)`. (c) add a `profile: <CFG>` header line to `runPurge` (`1648`)
  and `runDisarm` (`1633`), and have `runPurge` list the concrete dirs it removed (`guardDir()`,
  `resume-tickets`, `boardDir()`).
- **Dependencies:** none.
- **Parallelization:** worktree isolation.
- **Acceptance criteria:**
  - `node --test` passes; existing `--options` (`test.js:552`, `:1144`), `--sessions` (`test.js:1283`),
    `--purge` (`test.js:760`) tests still green.
  - New assertion: `--purge` output contains the sandbox CFG path (Q2 gate).
  - Optional: an `--options` alignment check (every descriptor column starts at the same index).
- **Tests:** the `--purge`-names-target assertion; keep the others green.
- **Edge cases:** `--options` with very long profile-label JSON (pad only the value column, let the
  trailing description wrap naturally).
- **Rollback:** revert the three formatting changes.

---

## 8. Area-level verification

Sandboxed (C10):
```
node --check statusline.js && \
node statusline.js --selftest && \
node --test && \
sh -c 'env HOME=$SB/home CLAUDE_CONFIG_DIR=$SB/home/.claude TMPDIR=$SB/tmp CCBSL_NO_ACT=1 node statusline.js --purge --install; test $? -eq 1'
```
The last line proves CLI-01 (combined one-shot + exclusive flag now exits 1). `node --test` must
report `# fail 0` with the new REGRESSION count.

---

## 9. Risks & open questions for the human

- **CLI-02 breadth decision (flagged).** Should `--uninstall` strip guardian hooks belonging to *any*
  Rig install (match by name), or only the running copy? The plan chooses **any Rig install** (so a
  moved-copy uninstall is total), which is the correct fix for the reversibility promise but means
  if a user deliberately runs two Rig copies wired to two profiles, uninstalling from one profile
  only touches that profile's `settings.json` anyway (profiles are separate files), so there is no
  real collision. Confirm the owner agrees "our tool by name" is the right ownership breadth.
- **CLI-09 exit-code change** makes `--install` exit 1 on a partial success. If the owner relies on
  `--install` exiting 0 in the one-line installers even when a secondary profile is broken, keep exit
  0 and only fix the *wording*. Flagged; low stakes.
- No paid services, credentials, or irreversible migrations. All changes are reversible edits to a
  single file plus tests.
