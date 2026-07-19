# xplatform

A cross-cutting sweep of every platform-touching path (Windows / Linux / macOS), plus the Node
version floor. The audit host is macOS; Windows-only findings are marked **code-decisive** (proven by
tracing exact lines) rather than reproduced. Self-contained.

---

## 1. Current-state audit

Platform-touching surface of `statusline.js`:
- **HOME/CFG resolution** (`222-223`): `os.homedir()` throw-guarded, `USERPROFILE` fallback correct.
- **Terminal width** (`272-289`): `COLUMNS` → `/dev/tty` ioctl (`ttyWidth`, verified fd-leak-safe) →
  `stdout.columns` → `100`. Windows/containers fall through cleanly.
- **Desktop notify + detached spawns** (`622-638`): `osascript` / `notify-send` / PowerShell +
  BurntToast.
- **Watcher + PID files** (`1563-1610`), `--disarm`/`--purge` kill paths (`1633-1658`).
- **Folder-segment separator logic** (`1266-1271`): verified correct for win32 (checks both `/` and
  `\` boundary chars; `path.basename` is platform-appropriate at runtime).
- **Installer command strings** `"node" "script"` (`1854`, `1895`): the standard `cmd.exe /d /s /c`
  pattern — verified-by-citation OK.
- **Doctor** (`2078` `path.isAbsolute` runs under `path.win32` on Windows so `C:\` passes; `2105` uses
  `where` on win32). **Atomic JSON writes** (`861-864`). **`dispWidth`** (`234-245`). **`fmtReset`**
  (`304-322`, hardcoded 12h clock).

**Node floor.** `grep` finds **zero** post-18 APIs (no `replaceAll`/`structuredClone`/`.at`/
`findLast`/`Object.hasOwn`/`??=`); `crypto.verify(null,…)` ed25519 is Node 12+; `NODE_USE_SYSTEM_CA`
is ignored harmlessly on 18. Empirically the full suite + `--selftest` pass on Node 18.15.0. But CI
(`.gitlab-ci.yml`) tests only `node:22`, so the README "Node 18+" claim is unguarded (fixed in
[tests-ci.md](tests-ci.md) TEST-08 / XPLAT-07 below).

**Health: good.** Weaknesses concentrate on Windows (a **claimed** platform — the README ships a
PowerShell one-liner installer), where every win32 branch is best-effort and untested by CI, plus one
**all-platform** crash: `spawnDetached` has no `error` handler, so a missing notifier binary kills
the live render.

---

## 2. Enhancement opportunities, ranked

| # | Title | Impact | Effort | Files |
|---|---|---|---|---|
| E1 | CI Node-18 job so "Node 18+" is enforced (XPLAT-07 = [tests-ci.md](tests-ci.md) TEST-08's node:18 leg) | high | small | `.gitlab-ci.yml` |
| E2 | Zero-dep Windows toast via WinRT + `-EncodedCommand` (XPLAT-04) | medium | medium | `statusline.js`, `README.md` |
| E3 | `resetStyle: 'clock24'` for 24-hour-locale users (XPLAT-09) | medium | small | `statusline.js`, `statusline.config.example.json`, `README.md` |
| E4 | README Windows guidance for the POSIX-only pieces (XPLAT-08) | low | small | `README.md` |

(The bug-fix tasks below carry most of the value; several are shared fixes owned jointly with other
plans — see the dedup notes.)

---

## 3. Correctness audit

**BUG-XPLAT-1 — `spawnDetached` has no `error` handler: a missing notifier binary crashes the live render at critical usage.** *[HIGH; CONFIRMED — reproduced by orchestrator, all platforms]*
- Path: `spawnDetached` (`622-630`) spawns + unrefs with no `'error'` listener. `spawn` ENOENT is
  delivered **asynchronously** as an `'error'` event **after** the top-level try/catch (`2322-2330`)
  has finished, so it is an unhandled `'error'`: the render process dies (exit 1, stderr noise) and no
  `statusline-error.log` is written. Trigger: `notify()` (`631-638`) fires under guardian
  autopilot notify/resume at critical usage on any machine whose notifier binary is absent —
  `notify-send` is missing on most headless/WSL/minimal Linux, exactly the platform+moment the
  guardian exists for.
- Repro (orchestrator): a bare `spawn('definitely-not-a-binary', ..., {detached:true})` with no error
  handler → `Unhandled 'error' event ... ENOENT`, exit 1. Confirmed the render path hits this via
  `notify` when `PATH` lacks the notifier.
- Fix: XPLAT-01. **This is the single highest-severity cross-platform bug** — a one-line fix with
  outsized impact (it protects the render at the exact moment it matters).

**BUG-XPLAT-2 — `test.js` sandboxes `HOME` but not `USERPROFILE`: running the suite on Windows rewires the developer's real Claude profiles.** *[high for Windows contributors; CONFIRMED — code-decisive]*
- Same finding as [tests-ci.md](tests-ci.md) BUG-TEST-5. **Fix owned by [tests-ci.md](tests-ci.md)
  TEST-01** (mirror `USERPROFILE` from `HOME` in `run()`). Listed here for the cross-platform map; no
  separate task.

**BUG-XPLAT-3 — `isOurWatcher` returns `true` for ANY alive PID on win32: `--disarm`/`--purge`/SessionStart can TerminateProcess an innocent recycled PID.** *[medium; CONFIRMED — code-decisive; C8 violation]*
- Same finding as [guardian.md](guardian.md) BUG-GUARD-3. **Fix owned by [guardian.md](guardian.md)
  GUARD-04** (a `Get-CimInstance` cmdline check, fail closed). Listed here; no separate task.

**BUG-XPLAT-4 — `notify()` on win32 builds a PowerShell `-Command` string with `JSON.stringify`: `$(…)`/backtick/`\"` in a session name interpolate or execute; and BurntToast is absent on stock Windows so the ping silently never fires.** *[medium; CONFIRMED — code-decisive]*
- Path: `636-637` embed title/msg inside PowerShell **double quotes** via `JSON.stringify`.
  PowerShell double-quoted strings interpolate `$var` and execute `$(subexpression)`; backslash is
  **not** an escape, so the `\"` that `JSON.stringify` emits terminates the string into code position.
  `msg` includes `cp.session_name` (`relaunchResume:1552`) — transcript-derived, not authored here.
  Separately, `New-BurntToastNotification` is a third-party module absent on stock Windows, so with
  `2>$null` + ignored stdio, autopilot "notify" mode's entire deliverable is a silent no-op on
  default Windows — undocumented.
- Repro (orchestrator, string reconstruction): a session name `Fix $(Get-Date) bug` produces
  `... -Text "Claude Code auto-resumed","Fix $(Get-Date) bug: ..."` with the `$()` unescaped inside
  double quotes (execution requires Windows).
- Fix: XPLAT-04 (rewrite as `-EncodedCommand` + env-carried payload; simultaneously a WinRT toast so
  it actually fires). Also closes the injection and the silent no-op.

**BUG-XPLAT-5 — `dispWidth` counts CJK/East-Asian-Wide as 1 cell.** *[low/medium; CONFIRMED — reproduced by orchestrator]*
- **Same root cause as [render-core.md](render-core.md) BUG-RC-3.** **Fix owned by
  [render-core.md](render-core.md) RENDER-03** (the `glyphWidth` helper covers the EA-Wide ranges).
  **Do NOT implement here** — verify RENDER-03's ranges include the CJK/Hangul/kana/fullwidth blocks
  and add any `test-unit.js` CJK assertions there.

**BUG-XPLAT-6 — `--sessions` prints a POSIX single-quoted `cd '…' &&` resume command that fails in cmd.exe / PowerShell 5.1.** *[low; CONFIRMED — reproduced by auditor]*
- Path: `shellQuote` (`1661`) is POSIX-only; `runSessions` prints `cd ' + shellQuote(cwd) + ' &&
  claude --resume …` (`1724`) on every platform. In cmd.exe single quotes are literal and drive
  changes need `cd /d`; in PowerShell 5.1 `&&` is a parse error. `writeResumeTicket` (`359`) uses
  double quotes so it survives (minus the `/d` nuance).
- Fix: XPLAT-06.

**BUG-XPLAT-7 — `writeJsonAtomic` strands its `.tmp` file when `renameSync` fails (recurring EPERM risk on Windows).** *[low; CONFIRMED — reproduced by auditor]*
- Path: `writeJsonAtomic` (`861-864`) wraps mkdir+write+rename in one try/catch that returns false
  without unlinking the pid-unique `.tmp`. On Windows `renameSync`-over-existing throws EPERM when the
  target is concurrently open (a second render reading the update cache every ~2s, or AV), and because
  tmp names are pid-unique, each failure leaves a new orphan; `--purge` does not sweep `*.tmp` in CFG.
- Repro (auditor): made the cache path a directory so rename must fail → an orphan
  `.ccbsl-update.json.<pid>.tmp` remained.
- Fix: XPLAT-07b (below).

**BUG-XPLAT-8 — doctor's autopilot check uses `where claude` on win32, which finds `.cmd` shims that `spawn()` cannot execute.** *[low; CONFIRMED — code-decisive]*
- Path: `runDoctor` (`2105`) checks `where claude` and reports "auto-resume can relaunch", but
  `relaunchResume` spawns `claudeBin()` without a shell (`1544`); on Windows `CreateProcess` resolves
  only `.exe`/`.com`, so an npm `claude.cmd` shim is found by `where` yet un-spawnable — the watcher's
  relaunch fails at fire time (gracefully logged at `1549`) after doctor said it would work.
- Fix: XPLAT-08b (below).

---

## 4. Performance audit

**Not on the hot path.** The render is Node-startup-dominated (~70% of ~60–95ms). Every fix here is
confined to `--disarm`/`--purge`/`--doctor`/hooks/notify — **off** the 2s render path.
**Constraint (C3): do NOT add any per-render platform probing** — no win32 cmdline check, no shim
detection, on the render path. XPLAT-01's one-line `error` handler is free (it only attaches a
listener). **No performance task.**

---

## 5. Quality audit + gate plan

The win32 `notify()` output is a *machine* notification, not an authored surface, but XPLAT-04's
extracted `notifySpec()` helper enables a **mechanical injection gate**: a `test-unit.js` assertion
that the win32 command contains **no characters from the title/msg payload** (data travels only via
env), so any future string-concat regression fails the unit suite. That is the quality-gate
deliverable for this area's one output-shaped surface. Everything else here is correctness, covered
by `node --test` (C9).

---

## 6. Scope & non-goals

**In scope:** the `spawnDetached` error handler; the win32 notify rewrite (injection + real toast);
`--sessions`/resume-ticket platform-aware `cd`; `writeJsonAtomic` tmp cleanup; doctor's win32 shim
detection; `resetStyle: 'clock24'`; README Windows guidance; the CI Node-18 leg (shared with
tests-ci).

**Do NOT build / do NOT touch:**
- No full `wcwidth`/Unicode tables (the EA-Wide ranges in RENDER-03 cover the real cases; C1).
- No Windows CI runner (GitLab shared Windows runners are slow; the `USERPROFILE` fix + unit gates
  carry the weight). Reassess only if the owner has a Windows runner.
- **No change to `statusline.js`'s HOME resolution** — `os.homedir()` is the correct product behavior;
  the *tests* were the bug (fixed in TEST-01).
- No notification libraries / npm deps (C1).
- No per-render platform probing (C3).
- Do not reimplement RENDER-03's `glyphWidth` here (XPLAT-05 dedup).

---

## 7. Implementation plan (fan-out-ready)

**Fan-out summary:** XPLAT-01, XPLAT-04, XPLAT-06, XPLAT-07b, XPLAT-08b, XPLAT-09 edit disjoint
functions in `statusline.js` → worktree isolation, parallel with a merge sequence. XPLAT-07 (CI node:
18) edits only `.gitlab-ci.yml` (do it inside [tests-ci.md](tests-ci.md) TEST-08). XPLAT-08 (README
Windows note) is doc-only. **XPLAT-01 is the highest priority — schedule it in the first wave with
the other HIGH bugs.** The two Windows-only regression tests (`{ skip: process.platform !== 'win32'
}`) need [tests-ci.md](tests-ci.md) TEST-01 (hermetic) first; the win32 unit assertions do not.

---

### XPLAT-01 — Add an `error` handler to `spawnDetached`
- **Rationale:** BUG-XPLAT-1. Highest-impact one-liner in the repo.
- **Files:** `statusline.js` (`spawnDetached` `627`), `test.js`.
- **Exact change:** add `child.on('error', () => {});` immediately before `child.unref();` (`627`).
  Silent no-op is the documented intent ("best-effort ... never throw"). This also future-proofs
  `armWatcher` and `maybeCheckUpdate`, which use the same helper.
- **Dependencies:** none (test needs TEST-01/02). **First wave.**
- **Parallelization:** shares `statusline.js` → worktree isolation.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: a missing notifier binary never crashes the live render`):
    `scriptCopy(dir, {autopilot:'notify', updateCheck:false})`; render a 99%-five_hour input (with
    `session_id` + `resets_at`) with `PATH` pointed at an empty dir and `CCBSL_NO_ACT` **unset**
    (so `notify` actually spawns) + `NO_UPDATE_NOTIFIER=1`; assert exit 0 and output does not contain
    `Unhandled 'error'`. Fails today (exit 1). *(Verified in a sandbox: exit 1 → exit 0 with the
    handler.)*
  - `node --test` + `--selftest` green.
- **Tests:** the REGRESSION above.
- **Edge cases:** a notifier that exists but fails later (still swallowed); the update-check child
  spawn (also protected now).
- **Rollback:** remove the one line (re-exposes the crash — do not).

### XPLAT-04 — Zero-dep Windows toast via WinRT + `-EncodedCommand`; extract `notifySpec()`
- **Rationale:** BUG-XPLAT-4 (injection + silent no-op).
- **Files:** `statusline.js` (`notify` `631-638`), `README.md`, `test-unit.js`.
- **Exact change:** extract a pure `notifySpec(platform, title, msg) → {cmd, args, env}`. For win32,
  build a small PowerShell script that loads
  `[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]`,
  reads `$env:CCBSL_N_TITLE`/`$env:CCBSL_N_MSG`, and shows a toast; pass it as
  `powershell -NoProfile -EncodedCommand <Buffer.from(script,'utf16le').toString('base64')>` with
  title/msg in the spawn env (never in code position). darwin/linux branches unchanged (osascript /
  notify-send). `notify()` calls `notifySpec` and `spawnDetached(spec.cmd, spec.args, {env: {...})`.
  Silent-degrade on any error (XPLAT-01 handles the ENOENT). Document the Windows toast behavior in
  README's guardian section.
- **Dependencies:** XPLAT-01 (the error handler must be in place so a WinRT failure degrades
  silently). Extraction is behavior-preserving on POSIX.
- **Parallelization:** shares `statusline.js` → worktree isolation; after XPLAT-01.
- **Acceptance criteria:**
  - `node --test` green; POSIX `notify` behavior unchanged (the osascript/notify-send args are
    byte-identical).
  - New `test-unit.js` (`notifySpec win32 puts data in env, not code`): for `platform='win32'` with a
    title/msg containing `$(Get-Date)`, backtick, and `"`, assert `args` uses `-EncodedCommand`,
    base64-decoding it as utf16le yields a script referencing `$env:CCBSL_N_TITLE` (not the literal
    payload), and `env` carries the verbatim strings. (This is the injection gate.)
  - macOS/linux `notifySpec` assertions confirm the existing args shape.
- **Tests:** the `notifySpec` unit test.
- **Edge cases:** WinRT unavailable (very old Windows) → the script errors → silent no-op (acceptable,
  same as today's BurntToast-absent case, but now injection-safe); empty title/msg.
- **Rollback:** inline the old `notify` body (re-exposes the injection — prefer keeping).

### XPLAT-06 — Platform-aware `cd` in `--sessions` and the resume ticket
- **Rationale:** BUG-XPLAT-6.
- **Files:** `statusline.js` (`runSessions` `1724`, `writeResumeTicket` `359`), `test.js`.
- **Exact change:** in `runSessions`, on win32 emit `cd /d "' + cwd.replace(/"/g,'') + '" && claude
  --resume ' + sid`; keep the POSIX `shellQuote` form otherwise. Apply the same `cd /d "..."` on
  win32 in `writeResumeTicket`.
- **Dependencies:** none. Coordinate with [cli-installer.md](cli-installer.md) CLI-11 which also edits
  `runSessions` (the `readHead` bump) → sequence or one worktree.
- **Parallelization:** shares `runSessions` with CLI-11 → sequence.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: --sessions resume command is runnable on this platform`): seed a
    transcript (pattern `test.js:1283`); assert output matches `/cd \/d "/` when
    `process.platform==='win32'` else `/cd '/`. The win32 branch is exercised only on Windows CI, but
    the POSIX branch keeps passing everywhere.
- **Tests:** the REGRESSION above.
- **Edge cases:** a cwd containing a double-quote on Windows (stripped by `.replace(/"/g,'')` — lossy
  but safe; document it); no cwd found (no `cd` prefix, per CLI-11's annotation).
- **Rollback:** restore the single POSIX form.

### XPLAT-07b — `writeJsonAtomic` unlinks its tmp on failure
- **Rationale:** BUG-XPLAT-7.
- **Files:** `statusline.js` (`writeJsonAtomic` `861-864`), `test.js`.
- **Exact change:** declare `tmp` before the try; split the catch to unlink it:
  ```js
  function writeJsonAtomic(file, obj) {
    let tmp;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
      fs.renameSync(tmp, file);
      return true;
    } catch { try { if (tmp) fs.unlinkSync(tmp); } catch {} return false; }
  }
  ```
  Optionally add `*.tmp` sweeping to `runPurge`.
- **Dependencies:** none.
- **Parallelization:** disjoint → worktree isolation.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: writeJsonAtomic never strands tmp files`): make
    `sb.cfg/.ccbsl-update.json` a **directory** (so rename must fail), run `--check-update` with a
    local `CCBSL_UPDATE_BASE`, assert `fs.readdirSync(sb.cfg).every(f => !f.endsWith('.tmp'))`. Fails
    before (orphan `.tmp`), passes after.
  - `node --test` green.
- **Tests:** the REGRESSION above.
- **Edge cases:** the write succeeds (no tmp to clean); mkdir fails (tmp undefined, guarded).
- **Rollback:** revert to the single-catch form.

### XPLAT-08b — Doctor flags a win32 `.cmd`/`.bat` claude shim
- **Rationale:** BUG-XPLAT-8.
- **Files:** `statusline.js` (`runDoctor` `2105`), `test.js`.
- **Exact change:** on win32, after the `where` success, parse its first output line; if it ends in
  `.cmd`/`.bat`/`.ps1`, downgrade to `bad('claudeBin resolves to a shell shim (…) that auto-resume
  cannot spawn directly', 'set "claudeBin" in config to the claude .exe path')`. POSIX unchanged.
- **Dependencies:** none.
- **Parallelization:** shares `runDoctor` with [cli-installer.md](cli-installer.md) CLI-06 → sequence
  or one worktree.
- **Acceptance criteria:**
  - New win32-only REGRESSION (`{ skip: process.platform !== 'win32' }`): `scriptCopy` with
    `{autopilot:'resume'}`, a dir with a stub `claude.cmd` on `PATH`, run `--doctor`, assert `/shim/`
    and exit 1. Skipped on POSIX.
  - Existing doctor tests still green.
- **Tests:** the skipped-win32 regression.
- **Edge cases:** a real `claude.exe` (no downgrade); `where` returning multiple lines (check the
  first).
- **Rollback:** revert the shim check.

### XPLAT-09 — `resetStyle: 'clock24'` for 24-hour-locale users
- **Rationale:** `fmtReset` (`304-322`) hardcodes a 12-hour `10:40a`; 24-hour-locale users want
  `10:40`.
- **Files:** `statusline.js` (`fmtReset` `304-322`), `statusline.config.example.json`, `README.md`.
- **Exact change:** add a third `resetStyle` value `'clock24'` rendering
  `${String(d.getHours()).padStart(2,'0')}:${mm}` (dated `M/D HH:MM` when not today). **Config-gated,
  default unchanged (`'clock'`)** — C4. Mirror the new value into `statusline.config.example.json`
  (line 28) and the README options table by hand (C6). Update the `--options` reset-style choices
  line (`1748`) to list `clock | clock24 | relative`.
- **Dependencies:** none. C4/C6 gate.
- **Parallelization:** shares `statusline.js` (`fmtReset`) → worktree isolation.
- **Acceptance criteria:**
  - New test (`resetStyle clock24 renders 24-hour times`): via a `scriptCopy` render with
    `{resetStyle:'clock24'}` and a fixed future `resets_at`, assert output matches `/\b\d{2}:\d{2}\b/`
    and not the `a`/`p` suffix.
  - Existing `clock` and `relative` tests (`test.js:113`, `:128`) still green.
  - GATE-02 (example-vs-DEFAULTS) stays green (the example gains no new *default* key — `resetStyle`
    already exists; the new *value* is documented in the `_comment`/README, not a schema change).
- **Tests:** the clock24 test.
- **Edge cases:** midnight (`00:00`), noon (`12:00`); dated form when not today.
- **Rollback:** remove the `clock24` branch + doc mentions.

### XPLAT-07 — CI node:18 leg
- **Rationale:** enforce the Node 18+ claim.
- **This is [tests-ci.md](tests-ci.md) TEST-08's node:18 matrix leg** — implement it there, not
  separately. Listed here only to close the cross-platform map. Acceptance: the pipeline is green on
  `node:18` (verified: the suite passes on 18.15.0 today).

### XPLAT-08 — README Windows guidance for POSIX-only pieces
- **Rationale:** `claude-profiles.sh` (source-only, bash/zsh) and the `--sessions` copy-paste assume
  a POSIX shell; the README's PowerShell installer path is correct but never says so.
- **Files:** `README.md`.
- **Exact change:** two sentences — in Install ("the profile switcher assumes bash/zsh; on Windows set
  `$env:CLAUDE_CONFIG_DIR` in PowerShell") and in `--sessions` ("on Windows PowerShell 5.1 run the
  `cd` and `claude` commands separately"). Pure docs.
- **Dependencies:** none. Docs-voice gate applies (keep it clean).
- **Parallelization:** doc-only → parallel.
- **Acceptance criteria:** docs-voice gate green; reviewer-checked accuracy.
- **Tests:** the docs-voice gate.
- **Edge cases:** none.
- **Rollback:** revert the two sentences.

---

## 8. Area-level verification

Sandboxed (C10):
```
node --check statusline.js && \
node statusline.js --selftest && \
node --test && \
node -e 'const{spawn}=require("child_process"); const c=spawn("definitely-not-real-xyz",[],{detached:true,stdio:"ignore"}); c.on("error",()=>{}); c.unref(); setTimeout(()=>process.exit(0),150)'
```
The last line proves the `spawnDetached` pattern (XPLAT-01) survives ENOENT. Windows-specific
behavior (XPLAT-04/06/08b) is verified by the win32-skipped tests in CI once a Windows job exists;
until then, code-decisive + the `notifySpec` unit assertions.

---

## 9. Risks & open questions for the human

- **Windows is a claimed platform with no CI.** The plan does not add a Windows runner (slow, and the
  owner may not have one). The `USERPROFILE` test fix + the win32-skipped regressions + the
  `notifySpec` injection unit test are the mechanical coverage; genuine Windows verification is
  owner-run. **Open question:** does the owner have (or want) a Windows CI runner? If yes, un-skip the
  win32 tests there.
- **XPLAT-04 (WinRT toast)** is the one medium-effort item. If the owner would rather not maintain a
  PowerShell/WinRT snippet, the minimum viable fix is the **injection** part alone (`-EncodedCommand`
  + env payload, keeping BurntToast as the shower) — the silent-no-op-on-stock-Windows is then a
  documented limitation, not a fix. Flagged for the owner to choose full toast vs injection-only.
- No paid services or migrations. `resetStyle: 'clock24'` is the only new (config-gated, default-off)
  behavior in this area.
