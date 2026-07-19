# shell-docs

The shell tooling (`claude-profiles.sh`, `install.sh`) and every authored document, plus the
accuracy of those documents against the code. Self-contained.

---

## 1. Current-state audit

- **`claude-profiles.sh`** (89 lines, sourced, deliberately no shebang) — `_cc_profile_dir` /
  `_cc_profile_name` (`13-25`) and one dispatcher `claude-profile()` (`27-89`) with
  `list`/`use`/`run`/`new`/`current`/`remove`/`help`. Verified working end-to-end in bash and zsh via
  a sandboxed `HOME`.
- **`install.sh`** (7 lines) — execs `node statusline.js --install`; shellcheck-clean.
- **Docs** — `README.md` (227 lines), `SECURITY.md` (33), `CONTRIBUTING.md` (55), `CHANGELOG.md`
  (Keep-a-Changelog), `statusline.config.example.json` (51, hand-mirrored from `DEFAULTS`
  `statusline.js:93-167`).

**Accuracy cross-check (~20 claims against code + runs).** Most verify: warn 90 / critical 98
(`120`), `gitCacheMs` 2500 (`156`), ledger 6h staleness (`692`/`789`), board 1h prune (`1672`), 24h
update throttle (`892`), `process.execPath` install (`1854`), proxy/CA handling, doctor PATH check.
The CHANGELOG "119 tests" claim is **accurate at the v1.0.0 tag** (a `git archive` of v1.0.0 runs
119/119; HEAD runs 124/124) — the frozen entry is historically correct, no fix.

**Voice doctrine (plain voice, no em-dashes) HOLDS.** A comment-stripping scan found **zero**
em-dashes and zero AI-tell words (`delve`/`seamless`/`robust`/`comprehensive`/`empower`/`leverage`
etc.) in all four `.md` files and in every string literal of `statusline.js`. The 11 em-dashes in
`statusline.js` are in **source comments**, outside the doctrine's stated scope (docs + CLI output).
The only nit: "Hardened by many adversarial-review passes" (`CHANGELOG.md:89`) is unverifiable
puffery in an otherwise factual entry.

**Health: good.** Concrete weaknesses: the documented shellcheck gate **fails out of the box**
(SC2148); profile names are unvalidated (`rm -rf` can escape the namespace); README/SECURITY overclaim
what `--purge` removes; the example config drifts from `DEFAULTS`; `updatePubkey` is read by code but
appears in no SSOT; `helpText` omits `--auto`/`--force`; the SECURITY data map misplaces resume
tickets and omits two caches. **No mechanical gate exists for any doc invariant** — [quality-gates.md](quality-gates.md)
adds it; this plan lands the fixes that gate depends on being green.

---

## 2. Enhancement opportunities, ranked

| # | Title | Impact | Effort | Files |
|---|---|---|---|---|
| E1 | Fix the shell gate: `shellcheck shell=bash` + un-mask CI (SHELL-01) | high | small | `claude-profiles.sh`, `.gitlab-ci.yml` |
| E2 | Validate profile names in `claude-profiles.sh` (SHELL-02) | medium | small | `claude-profiles.sh`, `test.js` |
| E3 | `--purge` removes `statusline-error.log`; purge/uninstall wording made exact (SHELL-03) | medium | small | `statusline.js`, `README.md`, `SECURITY.md`, `test.js` |
| E4 | Fix the SECURITY.md on-disk data map (SHELL-04) | low | small | `SECURITY.md` |
| E5 | Sync `statusline.config.example.json` to `DEFAULTS` (SHELL-06) | low | small | `statusline.config.example.json` |
| E6 | `helpText` completeness: `--auto`, `--force` (SHELL-07) | low | small | `statusline.js` |
| E7 | `claude-profile remove` cleans the profile's ledger/board state (SHELL-05) | low | small | `claude-profiles.sh` |

(`updatePubkey` in the SSOT and the SECURITY signing-doc fix live in [update.md](update.md) UPD-07;
the mechanical gates that lock all of this in live in [quality-gates.md](quality-gates.md).)

---

## 3. Correctness audit

**BUG-SHELL-1 — `shellcheck` fails on `claude-profiles.sh` (SC2148): the documented verify command and the CI shellcheck job are red on every run.** *[medium; CONFIRMED — reproduced by auditor]*
- Path: the file is sourced so it deliberately has no shebang, but it also has no
  `# shellcheck shell=bash` directive, so shellcheck cannot determine the target shell and exits 1
  with SC2148. `CONTRIBUTING.md:16` documents `shellcheck claude-profiles.sh install.sh` as a verify
  step (fails out of the box), and the `.gitlab-ci.yml` shellcheck job (`14-19`) fails on every
  pipeline, masked by `allow_failure: true` (training everyone to ignore the job).
- Repro (auditor): `shellcheck claude-profiles.sh` → SC2148, exit 1; with `# shellcheck shell=bash`
  prepended → exit 0, zero findings (shellcheck 0.11.0).
- Fix: SHELL-01.

**BUG-SHELL-2 — `claude-profile new`/`remove` accept slashed names and create/`rm -rf` directories outside the `.claude-*` namespace (even outside `$HOME`).** *[medium; CONFIRMED — reproduced by auditor]*
- Path: `_cc_profile_dir` (`13-18`) does no validation, so a name with `/` or `..` resolves outside
  `$HOME/.claude-*`. `claude-profile new 'x/../../victim'` (`58`, `mkdir -p`) creates a dir outside
  `$HOME`; `claude-profile remove 'x/../../victim'` (`71`, `rm -rf "$dir"`) recursively deletes it.
  The `default` refusal (`66`) is the only guard.
- Repro (auditor): `new "x/../../outside-victim"` created outside HOME; `remove` of the same deleted
  it (`DELETED-OUTSIDE-HOME`).
- Fix: SHELL-02.

**BUG-SHELL-3 — README/SECURITY overclaim "`--purge` deletes every local file it ever wrote": `statusline-error.log` is never deleted by any code path.** *[medium; CONFIRMED — reproduced by orchestrator]*
- Path: `README.md:67` says `--purge` "deletes every local file it ever wrote (checkpoints, tickets,
  caches)" and `SECURITY.md:8` ends its writes map with "Delete all of it with `--purge`". `runPurge`
  (`1648-1659`) deletes `guardian/`, `resume-tickets/`, the update cache, the ledger entry, the board
  dir, and tmp caches — but **never** `statusline-error.log` (written at `2328`, only read by doctor
  at `2120`), and neither `--purge` nor `--uninstall` removes it. The slash command and the various
  backups also survive `--purge`.
- Repro (orchestrator, sandboxed): after `--install`, `touch statusline-error.log`, `--purge`, then
  `--uninstall` → `statusline-error.log` remains after both.
- Fix: SHELL-03 (code + docs).

**BUG-SHELL-4 — `statusline.config.example.json` drifts from `DEFAULTS`.** *[low; CONFIRMED — reproduced by auditor + orchestrator]*
- Path: key-by-key diff against `DEFAULTS` (`93-167`): the example's `show` block (`5-23`) lacks
  `update` (`DEFAULTS.show.update:true` `100`); the `color` block (`46-50`) lacks `update:220` and
  `agents:141` (`164`); `profileLabels` (`45`) ships `{".claude":"work",".claude-personal":
  "personal"}` where `DEFAULTS` is `{}` (`160`) — copying the example verbatim (the README workflow,
  `168`) silently relabels the default profile badge to "work". Everything else matches exactly.
- Repro (orchestrator): confirmed `show.update` missing; value diffs otherwise none; order arrays
  equal.
- Fix: SHELL-06.

**BUG-SHELL-5 — `helpText` omits `--auto` and `--force`, which README references and points to `--help` for.** *[low; CONFIRMED — reproduced by auditor]*
- Path: `README.md:43` says "Run `node statusline.js --help` for the full flag list"; `README.md:95`
  documents `--install-guardian --auto` and `README.md:136` documents `--update --force`; both flags
  are real (`1959`, `1031`) but `helpText` (`1378-1410`) lists neither.
- Fix: SHELL-07.

**BUG-SHELL-6 — SECURITY.md data map misplaces resume tickets and omits the git temp cache + the error log.** *[low; CONFIRMED — reproduced by auditor]*
- Path: `SECURITY.md:8` places resume tickets under `guardian/` — they actually live at
  `$CLAUDE_CONFIG_DIR/resume-tickets/` (`341`). The same sentence names only two of the three temp
  caches, omitting the git-state cache `ccsl-git-*` (`1237`), and the writes map never mentions
  `statusline-error.log` (`2328`), the slash-command file (`1795`), or the settings/config/script
  backups.
- Fix: SHELL-04.

---

## 4. Performance audit

**Not applicable.** No hot-path code here. `claude-profiles.sh` runs interactively at human
cadence; the docs are static. No performance task. (The one perf-relevant doc addition — recording
the measured render budget in CONTRIBUTING.md — is owned by [perf.md](perf.md) PERF-03.)

---

## 5. Quality audit + gate plan (this area owns output surface 3: authored docs + CLI literals)

**Current state: clean** (see §1 — zero em-dashes, zero tell-words in `.md` + literals). The gap is
that nothing *enforces* it. **Remediation + gate:** the fixes above bring the docs to full accuracy;
the mechanical gate is `test-gates.js` in [quality-gates.md](quality-gates.md), which this plan feeds
with the drift/flag fixes so the gate lands **green**:

- **Gate 1 (docs-voice):** per-line em-dash + AI-tell scan over the four `.md` files. Already clean;
  the gate freezes it. Optional: soften `CHANGELOG.md:89` puffery (owner call).
- **Gate 3 (CLI literals):** the same scan over `statusline.js` string literals only (comments
  excluded — the 11 em-dashes there are by choice). Already clean.
- **Gate for SHELL-01:** `test-gates.js` also asserts line 1 of `claude-profiles.sh` matches
  `/^# shellcheck shell=bash/`, so the directive cannot be dropped.
- **Gate for SHELL-06/UPD-07:** `test-gates.js` Gate 2 (example-vs-`DEFAULTS` parity) — this plan's
  SHELL-06 fixes the drift so that gate is green on landing.

All gates are `test-gates.js` (auto-discovered by `node --test`, C9). Wiring detail is in
[quality-gates.md](quality-gates.md); this plan's job is to make each gate green when it lands.

---

## 6. Scope & non-goals

**In scope:** the shellcheck directive + CI un-mask; profile-name validation; `--purge` error-log
removal + honest purge/uninstall wording; the SECURITY data-map fix; the example-config sync;
`helpText` completeness; `claude-profile remove` ledger cleanup.

**Do NOT build / do NOT touch:**
- No `rename`/`clone`/`copy-settings` profile subcommands (no demonstrated demand; surface growth
  against "plan deep, build lean").
- No PowerShell port of `claude-profiles.sh` (CONTRIBUTING lists it as a contributor invitation, not
  core work; the Windows guidance doc note is [xplatform.md](xplatform.md) XPLAT-08).
- No markdown-lint / prose-lint npm dependency (C1) — the zero-dep `test-gates.js` scanner is the
  right-sized gate.
- No build-time generation of the example config from `DEFAULTS` (there is no build step; the parity
  test is the gate).
- Do not rewrite the docs' voice — it is already clean; only fix factual accuracy.

---

## 7. Implementation plan (fan-out-ready)

**Fan-out summary:** SHELL-01, SHELL-02, SHELL-05 edit `claude-profiles.sh`/`.gitlab-ci.yml` and are
independent of the `statusline.js` worktrees — fully parallel. SHELL-03 edits `statusline.js` +
docs (coordinate the `statusline.js` edit with other code worktrees). SHELL-04, SHELL-06, SHELL-07
are small doc/example/help edits — parallel, but SHELL-06 must land **with or before**
[quality-gates.md](quality-gates.md) GATE-02 so that gate is green, and SHELL-07 must land with
GATE-04 (flag parity).

---

### SHELL-01 — `shellcheck shell=bash` directive + un-mask the CI job
- **Rationale:** BUG-SHELL-1.
- **Files:** `claude-profiles.sh` (line 1), `.gitlab-ci.yml` (`19`).
- **Exact change:** insert `# shellcheck shell=bash` as **line 1** of `claude-profiles.sh` (verified:
  shellcheck 0.11.0 then exits 0). Delete `allow_failure: true` from the shellcheck job
  (`.gitlab-ci.yml:19`) so it gates merges. (The CI flip must be confirmed green in a pipeline —
  coordinate with [tests-ci.md](tests-ci.md) TEST-08, which also touches the shellcheck job.)
- **Dependencies:** none locally; the `allow_failure` removal is owner-verified in a pipeline.
- **Parallelization:** independent file → fully parallel.
- **Acceptance criteria:**
  - `shellcheck claude-profiles.sh install.sh` exits 0 (C9). If shellcheck is not installed locally,
    `npx --yes shellcheck ...` or the CI job.
  - `test-gates.js` (GATE, when it lands) asserts line 1 matches `/^# shellcheck shell=bash/`.
- **Tests:** the shellcheck run; the GATE assertion.
- **Edge cases:** the directive must be line 1 (before any code) for shellcheck to honor it.
- **Rollback:** remove the directive + restore `allow_failure` (leaves the job red-but-soft).

### SHELL-02 — Validate profile names in `claude-profiles.sh`
- **Rationale:** BUG-SHELL-2 (data-loss hazard).
- **Files:** `claude-profiles.sh` (near `_cc_profile_dir` `13`; the `use`/`run`/`new`/`remove`
  branches), `test.js`.
- **Exact change:** add a POSIX validator next to `_cc_profile_dir`:
  `_cc_valid_name() { case "$1" in ''|*/*|*..*|-*|.*) return 1;; esac; }` and call it first in the
  `use`/`run`/`new`/`remove` branches with `_cc_valid_name "$1" || { echo "invalid profile name
  '$1' (letters, digits, . _ - only)"; return 1; }`. Pure `case`, identical in bash and zsh.
- **Dependencies:** none.
- **Parallelization:** independent file → parallel.
- **Acceptance criteria:**
  - New REGRESSION in `test.js` (`REGRESSION: claude-profile rejects slashed/dot-dot profile names`):
    `spawnSync('bash', ['-c', 'source .../claude-profiles.sh; claude-profile new "x/../../evil"'])`
    with a sandbox `HOME`, assert non-zero exit and that nothing was created outside
    `$HOME/.claude-*`; repeat with `zsh -c`. Fails before, passes after.
  - `shellcheck` still clean (SHELL-01).
- **Tests:** the REGRESSION above (bash + zsh).
- **Edge cases:** a legitimate name with a dot in the middle (`work.2`) — the `.*` pattern only
  rejects a **leading** dot, so `work.2` is allowed; a leading `-` (rejected, would look like a
  flag).
- **Rollback:** remove `_cc_valid_name` + its calls.

### SHELL-03 — `--purge` removes `statusline-error.log`; exact purge/uninstall wording
- **Rationale:** BUG-SHELL-3 (C7 honesty).
- **Files:** `statusline.js` (`runPurge` `~1653`), `README.md` (`67`), `SECURITY.md` (`8`), `test.js`.
- **Exact change:** add `try { fs.unlinkSync(path.join(CFG, 'statusline-error.log')); } catch {}` in
  `runPurge` — the error log is pure state, squarely inside purge's contract (not config-gated,
  matches the existing behavior of removing state files). Reword `README.md:67` to enumerate honestly
  ("deletes all state it wrote: checkpoints, tickets, caches, the error log; your `statusline.config.json`,
  settings backups, and the script itself stay") and `SECURITY.md:8` to match, stating precisely what
  `--purge` vs `--uninstall` each remove.
- **Dependencies:** none (coordinate the `statusline.js` edit with the CLI worktree — `runPurge` is
  also touched by [cli-installer.md](cli-installer.md) CLI-11's profile header).
- **Parallelization:** shares `statusline.js` + `runPurge` with CLI-11 → sequence or one worktree.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: --purge removes statusline-error.log`): sandbox, write
    `CFG/statusline-error.log`, `run(['--purge'])`, assert `!fs.existsSync(elog)`. Fails before.
  - `node --test` green; the doc wording is review-checked (and the docs-voice gate keeps it clean).
- **Tests:** the REGRESSION above.
- **Edge cases:** no error log present (no-op); `--purge` is single-profile (uses `CFG`) — the doc
  wording should not imply it spans profiles (it does not, unlike install/uninstall).
- **Rollback:** revert the unlink + doc edits.

### SHELL-04 — Fix the SECURITY.md on-disk data map
- **Rationale:** BUG-SHELL-6.
- **Files:** `SECURITY.md` (`8`).
- **Exact change:** rewrite the Writes bullet: guardian state under `$CLAUDE_CONFIG_DIR/guardian/`
  (checkpoints, PID files, counters, model-tier state, logs); resume tickets at
  `$CLAUDE_CONFIG_DIR/resume-tickets/`; the update cache; burn-rate, subagent, **and git-state**
  caches in the temp dir; `statusline-error.log` on a render crash; the `/statusline-config` command
  file and `settings.json.bak` written by install; then state precisely what `--purge` vs
  `--uninstall` each remove (kept in sync with SHELL-03's wording).
- **Dependencies:** SHELL-03 (share the exact purge/uninstall wording).
- **Parallelization:** doc-only → parallel.
- **Acceptance criteria:** the data map matches the code (reviewer-checked against the write sites
  `341`, `1237`, `2328`, `1795`, `1789`); docs-voice gate stays green.
- **Tests:** no mechanical test for prose accuracy (reviewer-checked); the SHELL-03 purge test carries
  the mechanical part.
- **Edge cases:** none.
- **Rollback:** revert the SECURITY.md paragraph.

### SHELL-06 — Sync `statusline.config.example.json` to `DEFAULTS`
- **Rationale:** BUG-SHELL-4 (C6).
- **Files:** `statusline.config.example.json`.
- **Exact change:** add `"update": true` to the `show` block; add `"update": 220` and `"agents": 141`
  to the `color` block; set `"profileLabels": {}` and move the work/personal sample into the
  `_comment` string (e.g. `profileLabels example: {".claude":"work"}`). After this the example equals
  `DEFAULTS` exactly (except intentionally-empty `profileLabels`), so GATE-02 can demand value
  equality. Also add `"updatePubkey": ""` here to match UPD-07's `DEFAULTS` addition.
- **Dependencies:** must land **with or before** [quality-gates.md](quality-gates.md) GATE-02 (else
  the gate is red on landing). Coordinate the `updatePubkey` line with UPD-07.
- **Parallelization:** independent file → parallel (but sequence with GATE-02's arrival).
- **Acceptance criteria:**
  - `JSON.parse(statusline.config.example.json)` succeeds; a manual flatten-and-diff against
    `DEFAULTS` shows identical key sets (ignoring `_`-prefixed keys) and identical values except
    `profileLabels`.
  - GATE-02 (when it lands) is green.
- **Tests:** GATE-02.
- **Edge cases:** the `order` array must stay identical to `DEFAULT_ORDER` (`89`) — verify no segment
  is missing.
- **Rollback:** revert the example edits.

### SHELL-07 — `helpText` completeness: `--auto`, `--force`
- **Rationale:** BUG-SHELL-5.
- **Files:** `statusline.js` (`helpText` `1378-1410`).
- **Exact change:** add two lines to `helpText`:
  `  --auto               with --install-guardian: hands-free relaunch (autopilot resume)` after the
  `--install-guardian` line, and `  --force              with --update: apply even when the remote
  is not newer` near the `--update` line.
- **Dependencies:** must land **with** [quality-gates.md](quality-gates.md) GATE-04 (README↔help flag
  parity) so the gate is green; coordinate with [cli-installer.md](cli-installer.md) CLI-10's `KNOWN`
  set and [update.md](update.md) UPD-05's `--dismiss-update` help line (one canonical flag list).
- **Parallelization:** shares `statusline.js` (`helpText`) with UPD-05/CLI-10 → sequence or one
  worktree for the help-text edits.
- **Acceptance criteria:**
  - `node statusline.js --help | grep -c -- '--auto\|--force'` returns 2.
  - GATE-04 green (every README flag appears in `helpText`, allowlisting `--hook`/`--watch`).
- **Tests:** GATE-04.
- **Edge cases:** keep `--hook`/`--watch` **out** of `helpText` (internal, allowlisted in the gate).
- **Rollback:** remove the two lines.

### SHELL-05 — `claude-profile remove` cleans the profile's Rig state
- **Rationale:** a removed profile can linger in cross-profile failover hints for up to the 6h
  staleness window (`692`).
- **Files:** `claude-profiles.sh` (the `remove` branch, `71`).
- **Exact change:** after `rm -rf "$dir"`, also
  `rm -f "$HOME/.claude-usage-ledger/.claude-$1.json"` (and, harmlessly, any board files for that
  profile if identifiable). Guarded by SHELL-02's name validation so `$1` is safe.
- **Dependencies:** SHELL-02 (name validation must precede this so `$1` is safe to interpolate).
- **Parallelization:** independent file → parallel, after SHELL-02.
- **Acceptance criteria:** `shellcheck` clean; a manual check that `remove work` deletes
  `~/.claude-usage-ledger/.claude-work.json` when present.
- **Tests:** optional extension of the SHELL-02 regression asserting the ledger file is gone.
- **Edge cases:** no ledger entry present (`rm -f` is a no-op); the default profile is already
  refused (`66`).
- **Rollback:** remove the extra `rm -f`.

---

## 8. Area-level verification

```
shellcheck claude-profiles.sh install.sh && \
node --check statusline.js && \
node --test && \
node -e 'const d=JSON.parse(require("fs").readFileSync("statusline.config.example.json","utf8")); if(!("update" in d.show)) throw "example still missing show.update"'
```
(If `shellcheck` is absent locally, use `npx --yes shellcheck ...` or rely on the CI job.) The
`node --test` run must include the SHELL-02 (bash + zsh) and SHELL-03 REGRESSIONs, `# fail 0`.

---

## 9. Risks & open questions for the human

- **`CHANGELOG.md:89` puffery ("Hardened by many adversarial-review passes")** — soften or keep? It is
  the one unverifiable claim in an otherwise factual release entry. Owner call; the docs-voice gate
  does not flag it (it is not an em-dash or a banned word).
- **The `allow_failure` removal (SHELL-01)** must be verified green in a real pipeline before merge —
  coordinate with [tests-ci.md](tests-ci.md) TEST-08. If shellcheck flags something in `install.sh`
  too (untested locally), fix or `# shellcheck disable` with a comment before flipping the gate.
- No paid services, credentials, or migrations.
