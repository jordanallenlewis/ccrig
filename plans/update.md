# update

The self-update subsystem: the once-a-day version check, `--update` (download/validate/swap or
`git pull`), a zero-dependency HTTP(S)+proxy stack, and an optional Ed25519 signature gate.
Self-contained.

---

## 1. Current-state audit

**What it does** (`statusline.js:854-1101`):
- **Render-path pieces:** `updateCacheFile`/`readUpdateInfo` (`858-859`); `writeJsonAtomic`
  (`861-864`, pid-unique tmp + rename); `updateSeg` (`878-887`, shows the `⬆` badge from the cached
  check, suppressed by `seen` / 30-day staleness / `NO_UPDATE_NOTIFIER`); `maybeCheckUpdate`
  (`890-898`, once-a-day stamp-then-spawn of a detached `--check-update` child). The render itself is
  zero-network (C2): it reads the cache once (`collectSegments:1263`).
- **Zero-dep network stack:** `fetchText` (`902-905`, local-path branch for `CCBSL_UPDATE_BASE`
  mirrors), `noProxy` (`906-909`), `httpGetText` (`910-941`, redirect-follow to depth 5, 6MB cap with
  a settled-guard, 7s timeouts), `httpViaProxy` (`943-984`, CONNECT tunnel with leftover-byte
  unshift for https, absolute-URI GET for http, Basic proxy auth).
- **Appliers:** `parseRemoteVersion`/`parseChangelogTop` (`987-998`); `runCheckUpdate` (`1001-1015`);
  `isOurGitClone` (`1019-1027`); `runUpdate` (`1030-1080`); `updatePubkey`/`verifyUpdate`
  (`1081-1094`); `runWhatsnew` (`1096-1101`).

**Verified strengths.** The 6MB cap fires exactly once and terminates; a mid-body socket destroy
delivers exactly one error (no hang, no double-fire); the signed-update gate applies a valid sig and
refuses a tampered payload and garbage `.sig`; backup pruning is mtime-safe on macOS/Node 22
(`copyFileSync` does not preserve mtime, so the fresh backup sorts newest); a failed check preserves
`seen`/`latest`/`notes`; `diffFromDefaults` keeps the non-`DEFAULTS` `updatePubkey` key across
`saveConfig`.

**Health: good.** The weaknesses are a dead staleness guard, a spawn-storm on an unwritable config
dir, three low-severity network/matching hardenings, a missing repair path, and a **documentation
SSOT drift**: `SECURITY.md:17` and `README.md:138` claim no release signature exists while the
Ed25519 `updatePubkey` gate is fully implemented and tested (`test.js:1321`), and `updatePubkey`
appears in neither `DEFAULTS` (C6) nor the example config.

---

## 2. Enhancement opportunities, ranked

| # | Title | Impact | Effort | Files |
|---|---|---|---|---|
| E1 | Fix the signing-docs SSOT drift + add `updatePubkey` to `DEFAULTS`/example (UPD-07) | high | small | `SECURITY.md`, `README.md`, `statusline.js`, `statusline.config.example.json` |
| E2 | Fail closed when the throttle stamp can't be written (UPD-02) | medium | small | `statusline.js`, `test-unit.js` |
| E3 | Fix the dead 30-day staleness guard (`lastSuccessAt`) (UPD-01) | medium | small | `statusline.js`, `test.js` |
| E4 | `--dismiss-update` command (UPD-05) | medium | small | `statusline.js`, `README.md`, `test.js` |
| E5 | Harden `httpGetText` redirects (scheme allowlist, no downgrade) (UPD-03) | low | small | `statusline.js`, `test-unit.js` |
| E6 | Anchor `isOurGitClone`'s remote regex (UPD-04) | low | small | `statusline.js`, `test.js` |
| E7 | `NO_PROXY *.example.com` + drop dead clause (UPD-06) | low | small | `statusline.js`, `test-unit.js` |
| E8 | `--update --force` re-applies the current version (repair) (UPD-08) | low | small | `statusline.js`, `test.js` |
| E9 | Strict `parseRemoteVersion` x.y.z (UPD-09) | low | small | `statusline.js`, `test-unit.js` |

---

## 3. Correctness audit

**BUG-UPD-1 — failed daily checks defeat the 30-day stop-nagging guard: a version you can never fetch nags forever.** *[medium; CONFIRMED — reproduced by verifier]*
- Path: `updateSeg` suppresses the badge when `checkedAt` is >30 days old (`884`, comment `875-876`),
  but `runCheckUpdate` writes `checkedAt: Date.now()` **unconditionally even on a failed fetch**
  (`1006`), and `maybeCheckUpdate`'s throttle stamp (`895`) refreshes `checkedAt` daily before every
  attempt. So the staleness guard can never trigger: a stale cached `latest` (repo moved, corporate
  block) keeps the `⬆` badge alive indefinitely. The failure message "Nothing changed." (`1007`) is
  also false (`checkedAt`/`source` did change).
- Repro (verifier): seed a 40-day-old cache with `latest:'99.0.0'` (badge correctly suppressed); run
  `--check-update` with `CCBSL_UPDATE_BASE` pointing at a nonexistent dir (fails); render again →
  `⬆ v99.0.0 update` reappears — a failed check resurrected the badge.
- Fix: UPD-01.

**BUG-UPD-2 — `maybeCheckUpdate` ignores stamp-write failure: an unwritable config dir spawns a network-touching checker on every ~2s render.** *[medium; CONFIRMED — reproduced by verifier]*
- Path: the once-a-day throttle exists only in the cache file. `maybeCheckUpdate` stamps via
  `writeJsonAtomic` (`895`) but ignores its boolean return, then unconditionally
  `spawnDetached`s the `--check-update` child (`897`). `writeJsonAtomic` swallows all errors and
  returns false (`863`). If `CFG` is unwritable (root-owned `.claude` after a sudo install, disk
  full, transient EPERM under Windows AV), the stamp never persists, so **every render spawns a fresh
  detached node child that does a real HTTPS GET** — violating C2's "only the once-a-day child may
  touch the network" and leaking processes.
- Repro (verifier): control (writable CFG, 3 renders) → 1 spawn; read-only CFG, 3 renders → 3 spawns.
- Fix: UPD-02.

**BUG-UPD-3 — `httpGetText` follows redirects to any scheme: https→http downgrade allowed, `file://` Location becomes a localhost:80 GET.** *[low; CONFIRMED — independently re-verified with a local redirecting server]*
- Path: the redirect branch (`922-925`) builds `next = new URL(location, url)` and recurses with no
  scheme check (`fetchText`'s `/^https?:\/\//` guard `903` applies only to the *first* url). A 30x
  `Location: file:///etc/hosts` parses, then dials localhost:80 with path `/etc/hosts`; an
  https→http downgrade is followed silently. Exploitation needs a malicious/compromised origin or
  MITM'd TLS, and `runUpdate`'s gates (VERSION marker, shape check, `node --check`, optional
  signature) bound the blast radius — but the network layer should refuse, not mangle.
- Repro (auditor): a local 302→`file:///etc/hosts` produced an ECONNREFUSED localhost dial (followed,
  not refused).
- Fix: UPD-03.

**BUG-UPD-4 — `isOurGitClone` matches `ccrig` as a substring anywhere in `git remote -v`: `--update` git-pulls an unrelated repo.** *[low; CONFIRMED — reproduced by verifier]*
- Path: `isOurGitClone` (`1025`) returns true when
  `/ccrig|claude-code-(better-)?status-line/` matches the remote listing as a bare substring. A user
  who vendors `statusline.js` (tracked) into a repo whose remote merely contains `ccrig` — e.g.
  `gitlab.com/mccrigan/dotfiles.git` — sends `--update` down the `git pull --ff-only` path (`1032`)
  on that unrelated repo.
- Repro (verifier): a tracked repo with an `mccrigan` remote took the git-pull path; a `someuser`
  control correctly took the download path.
- Fix: UPD-04.

**BUG-UPD-5 — `NO_PROXY '*.example.com'` entries are silently ignored (plus a duplicated dead clause).** *[low; CONFIRMED — independently re-verified: `NO_PROXY=*.example.com` still routed the request through the proxy stub]*
- Path: `noProxy` (`906-908`) matches `*` (global), exact host, `.example.com` suffix, and bare-domain
  suffix — but the common curl/Go-style `*.example.com` form matches none, so an explicitly-excluded
  host is still sent through the proxy. Line `908` also tests `host === p` twice (dead code).
- Repro (auditor): `NO_PROXY=example.com` → 0 proxy hits; `NO_PROXY=*.example.com` → 1 hit (ignored).
- Fix: UPD-06.

**BUG-UPD-6 — `--update --force` cannot re-apply the current version (no repair path).** *[low; CONFIRMED — independently re-verified: `--update --force` against an equal-version remote exits "already at vX; nothing to apply" before consulting `--force`]*
- Path: `runUpdate` exits "already at vX; nothing to apply." when `latest === VERSION` (`1049`)
  **before** consulting `--force` (`1050`). `--force` is advertised as the override but only works
  for downgrades; a user whose standalone copy was locally edited/corrupted (still reporting the
  current VERSION) has no supported repair path.
- Fix: UPD-08.

Not bugs: `runCheckUpdate`'s cache merge correctly preserves `seen`; the CONNECT-tunnel leftover
unshift is correct; the 6MB cap + settled-guard are sound; `verifyUpdate` refuses tampered payloads.

---

## 4. Performance audit

**Contributes no measurable render cost.** `readUpdateInfo` is a single ~200-byte cache read once
per render (`1263`), measured ~25µs (~0.04% of a 60ms render). `maybeCheckUpdate`'s stamp is a
once-a-day write; all network work is confined to the detached child (C2). **No performance task.**
The only performance-relevant change is UPD-02, which *removes* a pathological per-render spawn
storm — a correctness fix that also protects the hot path. Do not add caching or memoization here.

---

## 5. Quality audit + gate plan

This area emits some CLI text (`--check-update`, `--update`, `--whatsnew` messages). Those strings
are covered by the cross-surface literal scan in [quality-gates.md](quality-gates.md) (surface 3 —
banned em-dashes/tells). One concrete copy fix belongs here: **BUG-UPD-1's "Nothing changed." message
is false** and should become accurate ("update check failed; the cached version info is unchanged")
as part of UPD-01. No dedicated scanner beyond the shared one.

---

## 6. Scope & non-goals

**In scope:** the docs/SSOT signing drift + `updatePubkey` in `DEFAULTS`/example; fail-closed stamp;
the `lastSuccessAt` staleness fix; `--dismiss-update`; redirect scheme allowlist; anchored
git-clone regex; `NO_PROXY` wildcard + dead-clause removal; the `--force` repair path; strict
`parseRemoteVersion`.

**Do NOT build / do NOT touch:**
- No auto-apply of updates without an explicit `--update` (C7 trust model; SECURITY.md's core
  promise).
- No minisign dependency (C1) — the shipped Ed25519 gate via `node:crypto` is the mechanism; fix the
  docs to describe *it*, do not add a tool.
- No TLS-to-proxy (HTTPS proxy) support, no CIDR/port-aware `NO_PROXY`, no resumable downloads — rare,
  and against C1/hot-path minimalism.
- Do not change the `git pull --ff-only` strategy (it prevents destructive merges) — only fix the
  detection (UPD-04).
- Do not weaken any `runUpdate` gate (VERSION marker, shape check, `node --check`, signature).

---

## 7. Implementation plan (fan-out-ready)

**Fan-out summary:** UPD-01, UPD-02, UPD-03, UPD-04, UPD-05, UPD-06, UPD-08, UPD-09 all edit disjoint
functions in `statusline.js` and can fan out under worktree isolation with a merge sequence. UPD-07
also edits `SECURITY.md`/`README.md`/`statusline.config.example.json` (no code-file conflict with the
others except the one-line `DEFAULTS` addition — coordinate that line with RENDER-01/PERF-01 which
also edit `DEFAULTS`/`loadConfig`). All regression tests need the hermetic harness
([tests-ci.md](tests-ci.md) TEST-01/02); UPD-03/06/09 unit tests use the existing in-process HTTP
harness pattern (`test-unit.js:129-157`).

---

### UPD-07 — Fix the signing-docs SSOT drift; add `updatePubkey` to the config SSOT
- **Rationale:** the docs deny a shipped feature; a live config key exists in no SSOT (C6).
- **Files:** `SECURITY.md` (`17`), `README.md` (`138`), `statusline.js` (`DEFAULTS` `~155`),
  `statusline.config.example.json`.
- **Exact change:** (a) add `updatePubkey: ''` to `DEFAULTS` next to `updateCheck` with a one-line
  comment pointing at the signing instructions already in the header (`78-82`); this is
  behavior-neutral (`diffFromDefaults` already preserves the key). (b) add `"updatePubkey": ""` to
  the example config. (c) rewrite `SECURITY.md:17`'s trust-anchor paragraph to describe the opt-in
  pinned-key model (Ed25519 via `updatePubkey`, refuses a download without a valid `statusline.js.sig`)
  and the `openssl` commands from the header; drop the "minisign is planned" sentence. (d) add one
  sentence to README's trust note (`138`) naming the knob.
- **Dependencies:** none. Its `DEFAULTS` edit shares a line region with RENDER-01/PERF-01 → coordinate
  the merge (all three add lines near `155`).
- **Parallelization:** worktree isolation for the `statusline.js` line; docs edits are independent.
- **Acceptance criteria:**
  - `node --test` passes (the new key is behavior-neutral; existing config tests green).
  - After this + [quality-gates.md](quality-gates.md) GATE-02/03 land, the drift gate is green:
    `updatePubkey` now exists in `DEFAULTS` and the example.
  - Manual: `grep -n updatePubkey SECURITY.md README.md statusline.config.example.json` all hit.
- **Tests:** covered by GATE-02/03; add nothing new here.
- **Edge cases:** a user config without `updatePubkey` (unchanged — empty default means "unsigned,
  TLS-only," today's behavior).
- **Rollback:** revert the four edits.

### UPD-02 — Fail closed when the throttle stamp can't be written
- **Rationale:** BUG-UPD-2 (C2 violation: a spawn/network storm).
- **Files:** `statusline.js` (`maybeCheckUpdate` `890-898`, `module.exports` `1369-1374`),
  `test-unit.js`.
- **Exact change:** gate the spawn on the stamp: change `895-897` so that if
  `writeJsonAtomic(updateCacheFile(), ...)` returns false, `return` before spawning. Export
  `maybeCheckUpdate` (return a boolean "did it spawn") for unit-testability.
- **Dependencies:** none.
- **Parallelization:** disjoint function → worktree isolation.
- **Acceptance criteria:**
  - New `test-unit.js` (`REGRESSION: maybeCheckUpdate does not spawn when the throttle stamp cannot
    be written`): point `CLAUDE_CONFIG_DIR` at a chmod-555 dir + `CCBSL_UPDATE_BASE` at an empty local
    dir; assert `maybeCheckUpdate(null)` returns false / does not spawn; companion assert
    `writeJsonAtomic` returns false on a read-only dir. `{ skip: process.getuid?.() === 0 }` (chmod is
    a no-op for root). Fails before, passes after.
  - `node --test` green.
- **Tests:** the unit test above.
- **Edge cases:** writable CFG (spawns once, throttle works — the existing behavior); root user
  (test skipped).
- **Rollback:** revert the gating; export line harmless to keep.

### UPD-01 — Fix the dead 30-day staleness guard with `lastSuccessAt`
- **Rationale:** BUG-UPD-1.
- **Files:** `statusline.js` (`runCheckUpdate` `1001-1015`, `updateSeg` `878-887`,
  `maybeCheckUpdate` `895`), `test.js`.
- **Exact change:** in `runCheckUpdate`'s `finish()`, set
  `lastSuccessAt: latest ? Date.now() : (prev.lastSuccessAt || null)`; keep `checkedAt` as the
  throttle field. Base `updateSeg`'s staleness test (`884`) on `lastSuccessAt` (falling back to
  `checkedAt` for old caches: `const stale = info.lastSuccessAt != null ? info.lastSuccessAt :
  info.checkedAt`). Ensure `maybeCheckUpdate`'s stamp (`895`) does **not** set `lastSuccessAt` (it
  merges `info`, so simply don't add the field). Correct the false "Nothing changed." message
  (`1007`) to "update check failed (offline, blocked, or behind a proxy); the cached version info is
  unchanged."
- **Dependencies:** none (coordinate the `maybeCheckUpdate` edit with UPD-02 — same function).
- **Parallelization:** shares `maybeCheckUpdate` with UPD-02 → sequence UPD-02 then UPD-01, or one
  worktree.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: the update badge stays suppressed after a failed check refreshes a
    40-day-old cache`): write cache `{latest:'99.0.0', checkedAt:now-40d, lastSuccessAt:now-40d}`,
    run `--check-update` with a nonexistent `CCBSL_UPDATE_BASE`, render, assert output has no `⬆`.
    Fails before (badge shown), passes after.
  - Existing update-badge tests (`test.js:1162`, `:1243`) still green (they set `checkedAt` fresh;
    with no `lastSuccessAt` they fall back to `checkedAt`, so a fresh cache still shows the badge —
    verify the fallback preserves this).
- **Tests:** the REGRESSION above.
- **Edge cases:** an old cache with no `lastSuccessAt` (falls back to `checkedAt` — same as today);
  a successful check (sets both).
- **Rollback:** revert the field + the staleness base.

### UPD-05 — `--dismiss-update` command
- **Rationale:** `updateSeg`'s comment implies a dismissal mechanism (`875`, `883`) but the only
  writer of `seen` is `runUpdate` (`1071`); a user who deliberately skips a version can only silence
  the badge by disabling checks entirely. Matters more given the (now-fixed) staleness guard.
- **Files:** `statusline.js` (near `--check-update` `1735`), `README.md`, `test.js`.
- **Exact change:** add a `--dismiss-update` one-shot branch (follow the `--whatsnew` pattern `1096`):
  read the cache, `writeJsonAtomic` with `seen = info.latest`, print what was dismissed. Add it to
  `helpText` (`1378`), the README command table, and the `EXCLUSIVE` list / `KNOWN` flags (coordinate
  with [cli-installer.md](cli-installer.md) CLI-01/CLI-10).
- **Dependencies:** benefits from CLI-01 (the hoisted gate) but can land independently.
- **Parallelization:** worktree isolation.
- **Acceptance criteria:**
  - New test (`--dismiss-update writes seen and hides the badge`): seed a newer-version cache, run
    `--dismiss-update`, render, assert no `⬆`.
  - `node --test` green; `helpText` includes `--dismiss-update` (feeds GATE-04 flag parity).
- **Tests:** the test above.
- **Edge cases:** no cache yet (print "nothing to dismiss"); `latest === VERSION` (no-op).
- **Rollback:** remove the branch + doc/help lines.

### UPD-03 — Harden `httpGetText` redirects
- **Rationale:** BUG-UPD-3.
- **Files:** `statusline.js` (`httpGetText` redirect branch `922-925`), `test-unit.js`.
- **Exact change:** after computing `next` (`924`), parse it and require `/^https?:$/` on the
  protocol, and refuse an https→http downgrade: `finish(new Error('unsupported redirect'))`
  otherwise.
- **Dependencies:** none.
- **Parallelization:** disjoint region → worktree isolation.
- **Acceptance criteria:**
  - New `test-unit.js` (`httpGetText refuses a redirect to file:// and https→http downgrade`): a
    local http server (pattern `test-unit.js:129-141`) serving `302 Location: file:///etc/hosts`;
    assert the callback receives `/unsupported redirect/` and no localhost connection is attempted.
    Fails before.
  - Existing `fetchText` redirect test (`test-unit.js:129`) — a normal http→http 302 — still passes.
- **Tests:** the unit test above.
- **Edge cases:** a same-scheme http→http redirect on a `CCBSL_UPDATE_BASE` http mirror (allowed);
  relative Location (resolved against the current url, still http(s)).
- **Rollback:** revert the scheme check.

### UPD-04 — Anchor `isOurGitClone`'s remote regex
- **Rationale:** BUG-UPD-4.
- **Files:** `statusline.js` (`isOurGitClone` `1025`), `test.js`.
- **Exact change:** replace `/ccrig|claude-code-(better-)?status-line/` with a path-segment-anchored
  form: `/[\/:](ccrig|claude-code-(better-)?status-line)(\.git)?(\s|$)/m`.
- **Dependencies:** none.
- **Parallelization:** disjoint → worktree isolation.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: --update in a repo whose remote merely CONTAINS ccrig uses the
    download path`): a scratch git repo with remote `https://gitlab.invalid/mccrigan/dotfiles.git`
    containing a copy of `statusline.js`; run `--update` with a local `CCBSL_UPDATE_BASE` at 99.x;
    assert output matches `/updated v.+ -> v99/`, not `/git pull/`. Fails before.
  - The genuine-clone path still works: a repo with remote `.../jordanallenlewis/ccrig.git` still
    takes `git pull`.
- **Tests:** the REGRESSION above.
- **Edge cases:** ssh remote `git@gitlab.com:jordanallenlewis/ccrig.git` (the `[\/:]` anchor matches
  the `:` form); no remote at all (returns false → download path).
- **Rollback:** restore the unanchored regex.

### UPD-06 — `NO_PROXY` wildcard support + remove the dead clause
- **Rationale:** BUG-UPD-5.
- **Files:** `statusline.js` (`noProxy` `906-909`), `test-unit.js`.
- **Exact change:** normalize each entry first — `if (p.startsWith('*.')) p = p.slice(1);` (turning
  `*.example.com` into the already-handled `.example.com`) — and drop the duplicated `host === p`
  clause.
- **Dependencies:** none.
- **Parallelization:** disjoint → worktree isolation.
- **Acceptance criteria:**
  - New `test-unit.js` (`NO_PROXY *.example.com bypasses the proxy`): local fake proxy + `HTTP_PROXY`
    set; `fetchText('http://sub.example.com/x')` with `NO_PROXY='*.example.com'`; assert 0 proxy
    hits. Fails before (1 hit).
  - Existing proxy behavior with `NO_PROXY=example.com` unchanged.
- **Tests:** the unit test above.
- **Edge cases:** `NO_PROXY='*'` (global bypass — still works via the `*` clause); a bare `.foo`
  entry (unchanged).
- **Rollback:** revert the normalization + restore the dead clause (do not — it was dead anyway).

### UPD-08 — `--update --force` re-applies the current version (repair)
- **Rationale:** BUG-UPD-6.
- **Files:** `statusline.js` (`runUpdate` `1049`), `test.js`.
- **Exact change:** change `1049` from `if (latest === VERSION)` to `if (latest === VERSION &&
  !force)`; the `--force` path then falls through the existing download/validate/backup/swap
  machinery unchanged.
- **Dependencies:** none.
- **Parallelization:** disjoint → worktree isolation.
- **Acceptance criteria:**
  - New REGRESSION (`REGRESSION: --update --force re-applies the same version`): install a copy,
    append a comment line to corrupt it, run `--update --force` against a local `CCBSL_UPDATE_BASE`
    of the **same** VERSION, assert the file matches the pristine remote and a `.bak` exists. Fails
    before ("already at").
  - `--update` without `--force` at the same version still prints "already at ...; nothing to apply."
- **Tests:** the REGRESSION above.
- **Edge cases:** the git-clone path (unaffected — this is the download path); `--force` with a newer
  remote (unchanged behavior).
- **Rollback:** revert the `&& !force`.

### UPD-09 — Strict `parseRemoteVersion` (x.y.z only)
- **Rationale:** `parseRemoteVersion` (`987`) captures `([0-9.]+)` so a malformed `99.2.0.1` parses,
  but `semverGt` compares only 3 fields — a published 4-part hotfix reads as "not newer" / "up to
  date" (silent miss).
- **Files:** `statusline.js` (`parseRemoteVersion` `987`), `test-unit.js`.
- **Exact change:** tighten the capture to `/const VERSION\s*=\s*'(\d+\.\d+\.\d+)'/` so anything else
  returns null → the existing loud "no VERSION marker" refusal (`1047`) / "update check failed" path,
  matching the documented policy (`866-868`).
- **Dependencies:** none.
- **Parallelization:** disjoint → worktree isolation.
- **Acceptance criteria:**
  - Extend the `test-unit.js` `parseRemoteVersion` test (`41-47`) with the 4-part case
    (`"const VERSION = '99.2.0.1';"` → null) and confirm the existing x.y.z + `-rc` cases still pass.
  - `node --test` green.
- **Tests:** the extended unit test.
- **Edge cases:** `2.2.0-rc1` still → null (existing behavior); `10.20.30` still → `'10.20.30'`.
- **Rollback:** restore the loose capture.

---

## 8. Area-level verification

Sandboxed (C10):
```
node --check statusline.js && \
node statusline.js --selftest && \
node --test && \
node --test test-unit.js
```
`node --test` must report `# fail 0` including the new UPD REGRESSIONs. UPD-02's test is skipped for
root (expected in a root CI container until [tests-ci.md](tests-ci.md) TEST-08 runs as non-root).

---

## 9. Risks & open questions for the human

- **UPD-07 is a security-doc correction with reputational weight.** SECURITY.md currently *understates*
  the tool's protection (says no signature exists when one does). The fix should be reviewed by the
  owner for tone and accuracy before it ships, since SECURITY.md is a trust document. Not a code
  risk; a wording/trust call.
- **Release signing operationalization is a separate human decision.** UPD-07 documents the *opt-in*
  mechanism (a user pins their own key), but shipping *official* signed releases requires the owner to
  generate a key, sign each release's `statusline.js.sig` in CI, and publish the public key. Flagged
  as an open question — the plan does not assume it.
- No paid services or migrations; all code changes are reversible single-file edits.
