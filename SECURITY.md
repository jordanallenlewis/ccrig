# Security

This is a single, dependency-free Node file you can read end to end before you run it. That is the primary security property: **audit it, then run it.** This document is the honest threat model: what it does, what it protects against, and what it does not.

## What it reads, writes, and transmits

- **Reads:** the JSON Claude Code pipes to the status line on stdin; your Claude Code `settings.json` and this tool's `statusline.config.json`; your session transcript files under `$CLAUDE_CONFIG_DIR/projects/**` (read-only, best-effort, only the tail); `git status` in the current repo.
- **Writes (local only):** checkpoints, watcher PID files, loop counters, per-session model-tier state, and watcher logs under `$CLAUDE_CONFIG_DIR/guardian/`; resume tickets under `$CLAUDE_CONFIG_DIR/resume-tickets/`; an update cache at `$CLAUDE_CONFIG_DIR/.ccbsl-update.json`; a render error log at `$CLAUDE_CONFIG_DIR/statusline-error.log` (only after a render crash); the `/statusline-config` command file and a `settings.json.bak` written when you install; burn-rate, subagent-count, and git-state caches in your temp dir; and, only if you opt in, the cross-profile usage ledger at `~/.claude-usage-ledger/` and the session board at `~/.claude-rig-sessions/`. `node statusline.js --purge` deletes the state files for the active profile (guardian dir, resume tickets, update cache, this profile's ledger entry, the shared board, temp caches, and the error log); it leaves your `statusline.config.json`, the settings backups, and the script itself. `node statusline.js --uninstall` removes the wired status line, the guardian hooks, and the command file across every profile.
- **Transmits:** nothing during rendering. The **only** network call anywhere is the optional once-a-day update check (`updateCheck`, default on): an unauthenticated GET to the public repo to read the latest version. It sends no telemetry, no identifiers, no usage data. Turn it off with `"updateCheck": false` or `NO_UPDATE_NOTIFIER=1`.

Nothing this tool reads ever leaves your machine.

## The update mechanism (`--update`)

- **Nothing is ever downloaded or executed automatically.** The daily check only writes a version number to a local file and shows a badge. Code changes only when **you** run `--update`.
- `--update` fetches over HTTPS, then **refuses to apply** anything that fails `node --check` (syntax) or a shape check (it must actually be `statusline.js`), so a proxy login page or truncated file cannot overwrite yours. It **backs up** the current file and does an **atomic swap**, rolling back untouched on any failure. It will not silently downgrade.
- **Trust anchor:** by default, integrity rests on HTTPS/TLS to the repo host. You can require more: pin an Ed25519 public key (PEM) in `updatePubkey` and `--update` will refuse any download that lacks a matching `statusline.js.sig` signature, verified with `node:crypto` (zero dependencies). Generate and sign a release with:
  ```
  openssl genpkey -algorithm ed25519 -out key.pem && openssl pkey -in key.pem -pubout   # the -pubout value goes in updatePubkey
  openssl pkeyutl -sign -inkey key.pem -rawin -in statusline.js | base64 > statusline.js.sig
  ```
  For a stronger guarantee without pinning, install by `git clone` and update with `git pull` (a reviewable diff), and/or pin `CCBSL_UPDATE_BASE` to a tagged release rather than the moving `main`. Note: the signature gate applies to the download path, not to a `git pull`.
- **Blast radius if the repo/account were compromised:** a malicious `statusline.js` would run wherever the status line runs, plus on session lifecycle events if you wired the guardian. Mitigations: manual apply, backups, single-file auditability, absolute-path hook pinning (PATH cannot hijack it), and `--uninstall`/`--purge` to fully remove it.

## The guardian (auto-resume + keep-working)

- **Opt-in** behind `--install-guardian`; it prints what it changes and backs up `settings.json`; fully reversible with `--uninstall-guardian`.
- **Auto-resume** relaunches the official `claude` CLI (`--resume … -p`). It does not touch your auth, does not proxy the API, and does not bypass any limit. It waits for your real reset and continues. It runs **unattended and capped**: the relaunched run has keep-working disabled (`CCBSL_UNATTENDED`), so it does its reviewable steps and stops rather than looping overnight. Weekly auto-resume is off by default.
- **Inspect and stop it any time:** `--status` lists armed watchers (they are not hidden daemons, and each writes a PID file), `--disarm` stops them.

## Reporting a vulnerability

Please open a confidential issue on the repository, or contact the maintainer at the address on [jordanallenlewis.com](https://jordanallenlewis.com). Please do not disclose publicly until a fix is available.

## Not affiliated with Anthropic

This is an unofficial, community tool. It is not affiliated with, endorsed by, or supported by Anthropic.
