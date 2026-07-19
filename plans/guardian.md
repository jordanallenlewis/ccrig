# guardian

The opt-in safety half of Rig: checkpoints, the `Stop`/`SessionStart`/`PreCompact` hooks, the
auto-resume watcher, forecast, and the ledger/board writers. Self-contained.

---

## 1. Current-state audit

**What it does.** The guardian reads only the stdin JSON + the transcript Claude Code already
writes, so the render path stays zero-network (C2). Two regions of `statusline.js`:

- **Render-adjacent (`372-852`):** transcript parsing (`readTranscriptTail` `396`, `scanTodos`
  `408`, `latestTodos` `422`, `latestUserText` `430`, `latestAssistantText` `445`,
  `computeInflightAgents` `474`); `writeCheckpoint` (`541`) / `readCheckpoint` (`580`) /
  `resumePromptFromCheckpoint` (`584`); `spawnDetached` (`622`) / `notify` (`631`) /
  `oncePerSession` (`640`); the ledger `writeLedger` (`656`) / `pickFreshProfile` (`683`); the board
  `writeBoard` (`669`); the forecast `recordSample` (`709`) / `burnRate` (`740`) / `forecastSeg`
  (`824`); `armWatcher` (`761`) / `armAutopilot` (`766`); `resumeHintSeg` (`796`).
- **Runtime (`1421-1659`):** `runHookStop` (`1448`, keep-working, loop-guarded, yields on a trailing
  question, fails open); `runHookSessionStart` (`1481`, inject+consume the checkpoint, supersede a
  stale watcher); `runHookPreCompact` (`1508`); `relaunchResume` (`1527`); `runWatch` (`1564`, reads
  the checkpoint **once**, fixes `target` once, polls wall-clock every 30s); `isOurWatcher` (`1603`);
  `runStatus`/`runDisarm`/`runPurge` (`1612-1658`).

**Health: good.** The design is careful (fails open, once-per-session markers, sleep-safe polling,
inspectable/killable watchers, epoch-rebased least-squares in `burnRate` to avoid float
cancellation). Coverage is strong for the hook decision logic and checkpoints; the **watcher
runtime is untested** because `relaunchResume` is not gated by `CCBSL_NO_ACT` (see
[tests-ci.md](tests-ci.md) TEST-03 — a prerequisite for GUARD tests).

**The refuted claim (important, stated honestly).** An auditor rated a "sidechain leak" as HIGH:
that `scanTodos`/`latestUserText`/`latestAssistantText` never skip `isSidechain:true` turns, so a
subagent's leftover todo could make keep-working block or a subagent's prompt become
`last_request`. **This was refuted and independently re-verified by the orchestrator:** on the audit
host, **0 of 1,483** files containing `"isSidechain":true` are main transcripts — every one lives in
a separate `<session-id>/subagents/**/*.jsonl` file. The main transcript that
`input.transcript_path` points at contains **no** `isSidechain` entries in the current Claude Code.
The auditor's repro used a synthetic transcript with inline sidechain turns, which does not match
reality. It is therefore **at most low-severity defense-in-depth** (against older/future Claude Code
transcript layouts), captured as GUARD-05 below, not a live bug.

---

## 2. Enhancement opportunities, ranked

| # | Title | Impact | Effort | Files |
|---|---|---|---|---|
| E1 | Re-arm on a second limit / window switch (GUARD-01) | medium | small | `statusline.js`, `test.js` |
| E2 | `runWatch` re-reads the checkpoint each tick (single source of truth) (GUARD-02) | medium | small | `statusline.js`, `test.js` |
| E3 | Validate `e.profile` in `pickFreshProfile` before it becomes `CLAUDE_CONFIG_DIR` (GUARD-03) | medium | small | `statusline.js`, `test.js` |
| E4 | `isOurWatcher` win32 cmdline check (GUARD-04) | medium | small | `statusline.js`, `test-unit.js` |
| E5 | Defense-in-depth: skip `isSidechain` in the transcript scanners (GUARD-05) | low | small | `statusline.js`, `test.js` |
| E6 | Use `isOurWatcher` in `--status`; preserve limit reason on PreCompact (GUARD-06) | low | small | `statusline.js` |

---

## 3. Correctness audit

**BUG-GUARD-1 — a second limit in one session (window switch or watcher stand-down) never re-arms; the checkpoint goes stale.** *[medium; CONFIRMED — reproduced by verifier]*
- Path: `armAutopilot` (`766-785`) arms notify/watch via per-session `oncePerSession` markers
  (`'notified'` `782`, `'watch'` `784`) that cannot refresh; in resume mode the checkpoint **is**
  refreshed per-window (`774-776`) but the watcher is not re-armed and `runWatch` fixed its `target`
  once at arm time (`1566`, `1572`). So when the binding window switches within a session (5h resets,
  later the weekly window hits critical), the on-disk checkpoint moves to the new window/reset while
  the running watcher still fires at the **old** reset — auto-resuming into a still-capped account.
  In notify mode the checkpoint simply stays wrong. The stand-down path (`resumedManuallySince`,
  `1583`) also `process.exit(0)`s without `clearSessionGuardState`, blocking a later re-arm.
- Repro (verifier, sandboxed, resume mode + `autopilotWeekly:true`, same `session_id` across two
  renders): checkpoint refreshed `session/T1` → `weekly/T2`, but the `.watch` marker mtime was
  identical (watcher not re-armed); in notify mode the checkpoint still read `window=session,
  resets_at=T1` after the weekly-limit render.
- Fix: GUARD-01.

**BUG-GUARD-2 — `pickFreshProfile` trusts an unvalidated `profile` field that becomes `CLAUDE_CONFIG_DIR`.** *[low (defense-in-depth); CONFIRMED — reproduced by verifier; severity downgraded on review]*
- Path: `writeLedger` validates its own name against `/^\.claude(-[A-Za-z0-9._-]+)?$/` before writing
  (`659`), but `pickFreshProfile` reads back `e.profile` from every `*.json` in the shared
  `~/.claude-usage-ledger` **without** re-validating (`689-697`) and builds `dir: path.join(HOME,
  e.profile)` (`697`). In the failover path (`runWatch` → `fireIfIdle` → `relaunchResume`
  `1534-1536`) that dir becomes `env.CLAUDE_CONFIG_DIR`. A hostile ledger file with
  `"profile":"../../../../tmp/attacker-cfg"` escapes `HOME`.
- Repro (verifier): failover hint rendered `⤳ ../../../../tmp/attacker-cfg free 99%`;
  `path.join('/home/user','../../../../tmp/attacker-cfg') === '/tmp/attacker-cfg'`.
- **Severity honesty (verifier's independent call):** this is **low**, not high. The ledger dir sits
  in the user's own `$HOME`; anyone who can write there can already write `~/.claude/settings.json`
  directly (inject hooks that run arbitrary commands) and read credentials — so redirecting
  `CLAUDE_CONFIG_DIR` grants no capability the attacker lacks. Rig "profiles" are not OS security
  principals, just different `CLAUDE_CONFIG_DIR` values under one user. It is also double-gated behind
  two opt-in flags (`ledger` + `autopilotFailover`, both off by default). Still worth the cheap fix
  as defense-in-depth and to stop the surprising HOME-escape.
- Fix: GUARD-03.

**BUG-GUARD-3 — `isOurWatcher` trusts any live PID on win32, so a recycled PID can be killed.** *[medium; CONFIRMED — code-decisive; Windows-only, cannot run on the macOS host]*
- Path: `isOurWatcher` (`1603-1610`) short-circuits `if (process.platform === 'win32') return true;`
  after only `pidAlive`. `.watch.pid` files survive reboots (`watchPidFile` `1563`; unlinked only on
  clean exit `1575`), Windows recycles PIDs aggressively, so on Windows `isOurWatcher(orphanPid, sid)`
  returns true and the callers — SessionStart supersede-kill (`1498`), `runDisarm` (`1639`),
  `runPurge` (`1650`) — `process.kill` (TerminateProcess) an unrelated process. POSIX is safe (the
  `ps -o command=` check requires both `--watch` and the sid). This is a C8 violation.
- Fix: GUARD-04 (shared with [xplatform.md](xplatform.md) XPLAT-03 — implement once).

Nothing else is a live bug: `burnRate`'s cancellation issue is already fixed (`749-753`), the
once-per-window checkpoint git snapshot does not run per-render (`armAutopilot` guards at `776`/`778`),
the Stop-hook question regex and loop guards are sound, `readTranscriptTail`'s half-cut first line is
safely dropped by `JSON.parse` throwing.

---

## 4. Performance audit

**On the hot path only via `collectSegments`' render-time calls** (`agentsSeg` → `inflightAgents`,
`downgradeSeg`, `resumeHintSeg`, `forecastSeg`), all already bounded and measured sub-ms:
`computeInflightAgents` is size-cached and 768KB-capped (~1.9ms only on a cache miss during active
work), `downgradeSeg`'s model-file read ~0.04ms, the sample-file reads ~0.15ms total. The
`writeCheckpoint` git exec runs **once per window** at critical usage, not per render (guarded).
**No guardian performance task.** One hygiene note owned by [perf.md](perf.md): `inflightAgents` is
computed twice per render (`agentsSeg` `1291` and the `writeBoard` arg `1304`) — fold into one call
only when already editing that region; it is below the 1ms bar.

Constraint for every GUARD task: none may add per-render work. GUARD-01/02/04 touch `armAutopilot`
and the watcher/runtime paths, which run at critical usage or in the detached watcher — **off** the
2s render path. GUARD-03 adds one regex test per ledger entry inside `pickFreshProfile`, which runs
only when `ledger`+`failover` are on and a limit is hit — off the hot path. GUARD-05 adds one
`o.isSidechain` check per parsed line in the transcript scanners; those already parse every tail
line, so it is free.

---

## 5. Quality audit + gate plan

This area owns no *authored* output surface (it emits machine-facing checkpoints and hook JSON, and
the resume-prompt text is functional instruction, not user-facing copy). **Quality-gate directive
skipped for this area** — the resume prompt's wording is covered by the existing
`resumePromptFromCheckpoint` unit test (`test-unit.js:113`) for correctness (attended vs unattended
vs cross-account), which is behavior, not taste. No scanner needed here.

---

## 6. Scope & non-goals

**In scope:** re-arm on window switch / second limit; watcher re-reads checkpoint each tick;
ledger-name validation; win32 `isOurWatcher` cmdline check; the sidechain defense-in-depth; `--status`
honesty + PreCompact reason preservation.

**Do NOT build / do NOT touch:**
- No change to the zero-network render guarantee (C2) — the ledger/board/forecast writers are already
  gated behind `live` + opt-in flags.
- No new autopilot modes, no weekly-resume-by-default (the days-long sleep is deliberately less
  reliable than the manual `SessionStart` restore).
- Do not "fix" the ZWJ/subagent nuance beyond GUARD-05's cheap guard — the real transcript layout
  makes it moot today.
- Do not make `writeCheckpoint`'s git snapshot per-render or move keep-working's full-file
  `latestTodos` rescan (`1455`) onto the render path.
- Do not add cross-profile *credential* handling — profiles are `CLAUDE_CONFIG_DIR`s, nothing more.

---

## 7. Implementation plan (fan-out-ready)

**Fan-out summary:** all tasks edit `statusline.js`; GUARD-01/02 both touch the watcher/armAutopilot
region and should be developed together or sequenced (01 then 02) to avoid conflicts; GUARD-03,
GUARD-04, GUARD-05, GUARD-06 touch disjoint functions and can fan out under worktree isolation.
**Hard prerequisite: [tests-ci.md](tests-ci.md) TEST-03** (gate `relaunchResume` on `CCBSL_NO_ACT`)
must land first, or none of the watcher-runtime regression tests can run without spawning a real
`claude`.

---

### GUARD-01 — Re-arm on a second limit / window switch
- **Rationale:** BUG-GUARD-1.
- **Files:** `statusline.js` (`armAutopilot` `766-785`, `runWatch` stand-down `1583`), `test.js`.
- **Exact change:** in the `willResume` branch of `armAutopilot`, when the checkpoint is rewritten
  for a changed window/reset (`774-776`), first disarm the old watcher and clear the arming markers:
  read `watchPidFile(sid)`, if `isOurWatcher(pid,sid)` then `process.kill(pid)`, then
  `fs.unlinkSync` the `'watch'` and `'notified'` markers — before the `oncePerSession('watch'/
  'notified')` calls, so a fresh watcher/notification fires for the new schedule. In notify mode, key
  the `'checkpoint'`/`'notified'` markers on the window (append `.<which>` to the tag) or refresh the
  checkpoint like the resume path. In `runWatch`'s stand-down (`1583`), call
  `clearSessionGuardState(sid)` before `process.exit(0)`.
- **Dependencies:** TEST-03 (for the test). Independent of other GUARD tasks except GUARD-02 (same
  region).
- **Parallelization:** shares `statusline.js` (watcher region) with GUARD-02 → sequence 01→02 or one
  worktree for both.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: a second limit in a switched window re-arms/refreshes`): resume mode
    + `autopilotWeekly:true`; render session-critical (const `session_id`), capture the `.watch`
    marker mtime; render weekly-critical for the same session; assert `checkpoint.window === 'weekly'`
    **and** the `.watch` marker changed (re-armed). A notify-mode variant asserts the checkpoint
    window/`last_request` update on the second window. Fails today.
  - Existing autopilot tests (`test.js:883`, `:904`) still green.
- **Tests:** the REGRESSION above.
- **Edge cases:** the same window re-crossing critical (no re-arm needed — guard on
  `window/resets_at` unchanged, as `776` already does); a watcher that already exited (kill a dead
  pid → caught).
- **Rollback:** revert the re-arm block + the stand-down `clearSessionGuardState`.

### GUARD-02 — `runWatch` re-reads the checkpoint each tick
- **Rationale:** BUG-GUARD-1 defense-in-depth — a self-healing single source of truth so an
  already-running watcher honors a refreshed schedule even if re-arming (GUARD-01) is bypassed.
- **Files:** `statusline.js` (`runWatch` `1564-1599`), `test.js`.
- **Exact change:** move `readCheckpoint(sid)` and the `target = cp.resets_at*1000 + buffer`
  computation **into** `tick()` (`1586-1597`), re-reading on each 30s poll; if the checkpoint
  vanished, `process.exit(0)`. This picks up a refreshed `resets_at` and an `autopilotBuffer` config
  change without re-arming.
- **Dependencies:** TEST-03; land after/with GUARD-01 (same function region).
- **Parallelization:** shares the watcher region with GUARD-01 → sequence.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: a running watcher honors a refreshed reset time`): arm a watcher
    with a far-future `resets_at`, rewrite the checkpoint with a past `resets_at`, assert the next
    tick fires (via the TEST-03 stub `claudeBin`). Fails today (target fixed at arm time).
  - Existing watcher stand-down behavior preserved.
- **Tests:** the REGRESSION above (uses the stub `claudeBin` from TEST-03/TEST-05).
- **Edge cases:** checkpoint deleted mid-run (exit cleanly); `resets_at` removed from a rewritten
  checkpoint (treat as "no schedule," stand down).
- **Rollback:** move the read/compute back above `tick`.

### GUARD-03 — Validate `e.profile` in `pickFreshProfile`
- **Rationale:** BUG-GUARD-2 (defense-in-depth).
- **Files:** `statusline.js` (`pickFreshProfile` `683-701`), `test.js`.
- **Exact change:** after parsing each ledger entry (`689`), reject any whose `e.profile` does not
  match the `writeLedger` regex `/^\.claude(-[A-Za-z0-9._-]+)?$/` (`continue`). As belt-and-braces,
  confirm `path.resolve(HOME, e.profile)` starts with `HOME + path.sep` before using it. Apply the
  same guard to the display path (`failoverHint` `787` / `profileLabelOf` `702`).
- **Dependencies:** none (test needs TEST-01/02).
- **Parallelization:** disjoint function → worktree isolation, fully parallel.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: failover ignores a ledger entry with a traversal profile name`):
    `ledger:true`, write `~/.claude-usage-ledger/.claude-evil.json` with
    `profile:'../../etc'` and headroom; assert render output contains no `⤳`/`free`. Positive
    control: a valid `.claude-spare` still surfaces. Fails today.
  - Existing ledger tests (`test.js:1031`) still green.
- **Tests:** the REGRESSION above.
- **Edge cases:** an absolute-path `profile` (rejected by the regex — it does not start with
  `.claude`); the current profile itself (already skipped by `e.profile === here` at `690`).
- **Rollback:** remove the regex/resolve guard.

### GUARD-04 — `isOurWatcher` win32 cmdline verification
- **Rationale:** BUG-GUARD-3 (C8). **This is the same fix as [xplatform.md](xplatform.md) XPLAT-03 —
  implement once, referenced by both.**
- **Files:** `statusline.js` (`isOurWatcher` `1603-1610`), `test-unit.js`.
- **Exact change:** replace the `if (process.platform === 'win32') return true;` short-circuit with a
  real cmdline check: `execFileSync('powershell', ['-NoProfile','-Command','(Get-CimInstance
  Win32_Process -Filter "ProcessId=' + Number(pid) + '").CommandLine'], {encoding:'utf8',
  timeout:3000})` and return `cmd.includes('--watch') && cmd.includes(sid)` (pid is `Number`-coerced,
  sid is `SID_RE`-validated, so the filter string is injection-safe). Fail closed (return false) on
  any error, mirroring the POSIX branch. To make it unit-testable, extract the cmdline-match decision
  into a pure exported helper `watcherCmdMatches(cmdline, sid)` = `cmdline.includes('--watch') &&
  cmdline.includes(sid)`.
- **Dependencies:** none.
- **Parallelization:** disjoint function → worktree isolation.
- **Acceptance criteria:**
  - `node --test` passes on POSIX (the win32 branch is not exercised, but `watcherCmdMatches` is).
  - `test-unit.js`: `watcherCmdMatches('node statusline.js --watch abc', 'abc') === true`;
    `watcherCmdMatches('node other.js', 'abc') === false`;
    `watcherCmdMatches('node --watch xyz', 'abc') === false`.
  - A win32-only `test.js` REGRESSION (`{ skip: process.platform !== 'win32' }`): a decoy process's
    pid in `guardian/<sid>.watch.pid`, run `--disarm <sid>`, assert the decoy is still alive and
    output says `signalled 0 process(es)`.
- **Tests:** the unit + skipped-win32 regression.
- **Edge cases:** `Get-CimInstance` unavailable (older Windows) → error → fail closed (return false,
  so we never kill — safe); a PID that is genuinely ours (matches).
- **Rollback:** restore the `return true` short-circuit (C8 violation returns — do not).

### GUARD-05 — Defense-in-depth: skip `isSidechain` turns in the transcript scanners
- **Rationale:** the refuted "sidechain leak." Not a live bug in the current Claude Code (main
  transcripts carry no `isSidechain`), but a one-line guard makes the scanners correct even if a
  future/older Claude Code inlines sidechain turns. Cheap, free at runtime.
- **Files:** `statusline.js` (`scanTodos` `410`, `latestUserText` `433`, `latestAssistantText`
  `448`), `test.js`.
- **Exact change:** immediately after each `JSON.parse` in those three scanners, add
  `if (o && o.isSidechain) continue;`. (Optional consolidation: a `mainChainObjs(lines)` generator
  yielding `!o.isSidechain` objects, routed through all three — do this only if touching the region
  anyway.)
- **Dependencies:** none.
- **Parallelization:** disjoint functions → worktree isolation.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: guardian ignores an inline subagent (isSidechain) turn`): build a
    transcript where the main todos are all completed and a later inline
    `{type:'assistant', isSidechain:true, message:{content:[{type:'tool_use', name:'TodoWrite',
    input:{todos:[{content:'sub', status:'pending'}]}}]}}` exists; assert the Stop hook (keepWorking
    on) returns empty (allow stop). Fails before, passes after.
  - `node --test` still green (real main transcripts unaffected — they have no `isSidechain`).
- **Tests:** the REGRESSION above.
- **Edge cases:** an object without `isSidechain` (unchanged); a real main transcript (no behavior
  change — verified: zero `isSidechain` in main transcripts).
- **Rollback:** remove the three guard lines.

### GUARD-06 — `--status` honesty + preserve the limit reason on PreCompact
- **Rationale:** two low-severity polish items.
- **Files:** `statusline.js` (`runStatus` `1623`, `writeCheckpoint` `549-551`).
- **Exact change:** (a) in `runStatus` (`1623-1624`), replace `pid && pidAlive(pid)` with
  `isOurWatcher(pid, sid)` so a recycled-PID orphan is not reported `ARMED`. (b) in `writeCheckpoint`,
  when `resets_at` is inherited from an existing limit checkpoint (`551`), also keep that
  checkpoint's `reason` (or set `reason` to `'pre-compact (limit armed)'`), so a PreCompact after a
  limit-critical checkpoint does not make the resume prompt say "context was just compacted" instead
  of "interrupted by a usage limit."
- **Dependencies:** GUARD-04 (for the improved `isOurWatcher`).
- **Parallelization:** worktree isolation.
- **Acceptance criteria:**
  - `node --test` passes; existing `--status` (`test.js:760`) and PreCompact (`test.js:939`) tests
    still green.
  - Optional new test asserting a PreCompact after a limit checkpoint keeps `reason` matching
    `/limit/`.
- **Tests:** keep existing green; optional reason-preservation test.
- **Edge cases:** a PreCompact with no prior checkpoint (normal `'pre-compact'` reason).
- **Rollback:** revert both edits.

---

## 8. Area-level verification

Sandboxed (C10), **after TEST-03 has landed**:
```
node --check statusline.js && \
node statusline.js --selftest && \
node --test
```
`node --test` must report `# fail 0` including the new GUARD REGRESSIONs. The win32-only GUARD-04
regression will show as skipped on POSIX (`# skipped` > 0 is expected here for that one test only).

---

## 9. Risks & open questions for the human

- **The sidechain question depends on the Claude Code transcript layout,** which Anthropic controls
  and could change. GUARD-05 is cheap insurance; the owner should know it is insurance, not a fix for
  an observed bug. If Anthropic ever inlines sidechain turns into the main transcript, GUARD-05
  becomes load-bearing.
- **GUARD-04 shells out to PowerShell on Windows per `isOurWatcher` call.** That call happens only in
  `--disarm`/`--purge`/`--status`/SessionStart-supersede — never on the render path — so the ~tens of
  ms cost is fine. Confirm the owner is OK with a PowerShell dependency for the win32 watcher check
  (it is already used for win32 `notify`).
- No paid services, credentials, or migrations.
