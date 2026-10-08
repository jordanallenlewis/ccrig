# Security

This is a single, dependency-free Node file you can read end to end before you run it. That is the primary security property: **audit it, then run it.** This document is the honest threat model: what it does, what it protects against, and what it does not.

## What it reads, writes, and transmits

- **Reads:** the JSON Claude Code pipes to the status line on stdin; your Claude Code `settings.json` and this tool's `statusline.config.json`; your session transcript files under `$CLAUDE_CONFIG_DIR/projects/**` (read-only, best-effort, only the tail); `git status` in the current repo, and near a limit its `.git/HEAD` and branch ref files (read-only).
- **Writes (local only):** checkpoints, watcher PID files, loop counters, per-session model-tier state, watcher logs, and the last few seconds of stop pings (`recent-pings.json`, so one stop pings once) under `$CLAUDE_CONFIG_DIR/guardian/`; resume tickets under `$CLAUDE_CONFIG_DIR/resume-tickets/`; an update cache at `$CLAUDE_CONFIG_DIR/.ccbsl-update.json`; a render error log at `$CLAUDE_CONFIG_DIR/statusline-error.log` (only after a render crash); the `/statusline-config` command file and a `settings.json.bak` written when you install; when you run `ccrig init` or `--install-guardian` with stop pings on, Claude Code's own phone-push switches (`inputNeededNotifEnabled`, `agentPushNotifEnabled`) in `settings.json`, only where you have never set them (Claude Code 2.1.140 or newer); project labels from `ccrig --name` under `~/.ccrig/names/` (one small JSON file per project folder, never inside the project); a locale cache (`ccsl-locale.json`) in your temp dir; burn-rate, subagent-count, git-state and profile-count caches in your temp dir; and, only if you opt in, the cross-profile usage ledger at `~/.claude-usage-ledger/` and the session board at `~/.claude-rig-sessions/`. `node statusline.js --purge` deletes the state files for the active profile (guardian dir, resume tickets, update cache, this profile's ledger entry, the shared board, temp caches, and the error log); it leaves your `statusline.config.json`, the settings backups, and the script itself. `node statusline.js --uninstall` removes the wired status line, the guardian hooks, and the command file across every profile.
- **Windows only, the Git Bash watchdog:** when the status line has stopped drawing, a hook starts `bash.exe -c "exit 0"` in the background to see whether Git Bash works. If it hangs, CCRig moves its own status line entry from `settings.json` to `$CLAUDE_CONFIG_DIR/ccrig-statusline-paused.json` (after a backup) and puts it back once Git Bash starts again; it never touches a status line of another tool. It ends only stuck `bash.exe`/`sh.exe` processes, over a minute old, whose command line ends with the exact status line or hook command CCRig wired, found with a PowerShell process query that runs only while Git Bash is broken or the bar is paused. It also records the Claude Code version the status line receives (`$CLAUDE_CONFIG_DIR/.ccrig-cc-version`), which decides whether the hooks can start `node.exe` without a shell.
- **Transmits:** nothing during rendering. There are two network calls anywhere:
  - the optional once-a-day update check (`updateCheck`, default on): an unauthenticated GET to the npm registry to read the latest release version (plus, when a newer release exists, its changelog from that release's git tag). It sends no telemetry, no identifiers, no usage data. Turn it off with `"updateCheck": false` or `NO_UPDATE_NOTIFIER=1`.
  - the phone push for stop pings, **only if you set `pushUrl`** (or `CCRIG_PUSH_URL`); off by default. A detached child POSTs to that URL once per stop: a title (`Claude Code: <session label> finished | needs you | stopped`, where the label is your project folder's name or the one you gave it), a fixed line (`Finished. Your turn.`, `Waiting on a permission prompt.`, or the API error's type), and an ntfy priority and tag. Claude's reply and Claude Code's own notification text stay on the desktop notification and never go into the push. A topic on the public ntfy.sh server is readable by anyone who knows its name, so pick a long random one or use your own server (`?auth=` in the URL works).
- **Starts, on this machine:** the desktop notifier for a stop ping or a limit ping (`osascript` on macOS, `notify-send` on Linux, a PowerShell toast on Windows), with the text passed as arguments or environment, never through a shell.

Nothing this tool reads leaves your machine, except the stop-ping push above when you set `pushUrl`.

## The update mechanism (`--update`)

CCRig is distributed primarily through npm, as the `ccrig` package. On an npm install, updates come from npm itself (`npm install -g ccrig@latest`), backed by the registry's integrity checks and TLS; `--update` detects that case and defers to npm rather than touching a file npm manages. The self-update mechanism described below covers a copy you installed without npm (the curl one-liner), where CCRig updates its own single file.

- **Nothing is downloaded or executed automatically unless you opt in.** By default the daily check only writes a version number to a local file and shows a badge, and code changes only when **you** run `--update`. With `"autoUpdate": true` the background check installs a newer release itself: an npm install through `npm install -g ccrig@<version>` into its own prefix (never with sudo), a standalone copy through the same validated, backed-up swap as `--update`.
- `--update` fetches over HTTPS, then **refuses to apply** anything that fails `node --check` (syntax) or a shape check (it must actually be `statusline.js`), so a proxy login page or truncated file cannot overwrite yours. It **backs up** the current file and does an **atomic swap**, rolling back untouched on any failure. It will not silently downgrade.
- **Trust anchor:** by default, integrity rests on HTTPS/TLS to the repo host. You can require more: pin an Ed25519 public key (PEM) in `updatePubkey` and `--update` will refuse any download that lacks a matching `statusline.js.sig` signature, verified with `node:crypto` (zero dependencies). Generate and sign a release with:
  ```
  openssl genpkey -algorithm ed25519 -out key.pem && openssl pkey -in key.pem -pubout   # the -pubout value goes in updatePubkey
  openssl pkeyutl -sign -inkey key.pem -rawin -in statusline.js | base64 > statusline.js.sig
  ```
  Official releases are **not signed yet**, so pinning a key today refuses every official update; use it with a mirror you sign yourself (`CCBSL_UPDATE_BASE`). Downloads come from the release's git tag (`v<version>`), never the moving `main` branch, and a file whose `VERSION` disagrees with the release is refused.
- **Blast radius if the repo/account were compromised:** a malicious `statusline.js` would run wherever the status line runs, plus on session lifecycle events if you wired the guardian. Mitigations: manual apply, backups, single-file auditability, absolute-path hook pinning (PATH cannot hijack it; the one exception is Windows with a node path that contains a space, where the command names `node` from PATH so PowerShell can run it), and `--uninstall`/`--purge` to fully remove it.

## The guardian (auto-resume + keep-working)

- **On by default** with `ccrig init` / `--install` (autopilot `notify`: checkpoint + resume ticket + desktop ping, nothing unattended); install the bar only with `--no-guardian` or `"autopilot": "off"`. The genuinely opt-in part is the **unattended auto-resume relaunch** (autopilot `resume` / `--auto`). Setup prints what it changes and backs up `settings.json`; fully reversible with `--uninstall-guardian`.
- **Auto-resume** relaunches the official `claude` CLI (`--resume … -p`). It does not touch your auth, does not proxy the API, and does not bypass any limit. It waits for your real reset and continues. It runs **unattended and capped**: the relaunched run has keep-working disabled (`CCBSL_UNATTENDED`), so it does its reviewable steps and stops rather than looping overnight. Weekly auto-resume is off by default.
- **Inspect and stop it any time:** `--status` lists armed watchers (they are not hidden daemons, and each writes a PID file), `--disarm` stops them.

## The Claude Code mod

The mod (`hooks/ccrig.ts`, installed with `/plugin install ccrig@ccrig`) runs inside Claude Code with your permissions, like any mod. What it does with them:

- **Starts one program:** Node (the node your wired CCRig status line already names, else `node`, else `node.exe`) running the `statusline.js` that ships in the same plugin directory. It never runs a shell, and text you type after `/ccrig` is checked against each command's exact arguments, so it can never become a flag.
- **Reads:** your merged Claude Code settings through the mods API, only to find CCRig's own wiring and node path, and `~/.ccrig/statusline.config.json`. It reads `HOME` and `USERPROFILE` only to find that file. It writes no settings.
- **Writes:** nothing itself. The `statusline.js` it runs writes what the section above lists, plus `~/.ccrig/mod.json` (version, plugin directory, last session id, when it last ran), which `--doctor`, `init` and `--uninstall` read to know the mod is there.
- **Acts on its own only within your CCRig config:** a `claude -p` or SDK session draws nothing and its renders write nothing. With `"autopilot": "resume"`, an open session past its critical line continues itself at the reset by submitting CCRig's resume prompt (the transcript shows CCRig sent it); close the terminal first and the detached watcher above takes over. Nothing else is automatic.
- **Network:** none from the mod itself. The `statusline.js` it runs makes the two calls above (the once-a-day update check, which under the mod points you to `/plugin update ccrig@ccrig` instead of updating any file, and the stop-ping push only if you set `pushUrl`).

The mods API calls it makes, which `claude plugin validate .claude-plugin/plugin.json` lists from a clone before you install (a test fails the build when this list and the code disagree): `$.clock.after`, `$.clock.every`, `$.clock.now`, `$.command.register`, `$.env.get`, `$.fs.exists`, `$.fs.read`, `$.plugin.root`, `$.process.run`, `$.prompt.submit`, `$.session.cwd`, `$.session.id`, `$.session.model`, `$.session.root`, `$.session.usage`, `$.session.version`, `$.settings.read`, `$.ui.close`, `$.ui.copy`, `$.ui.invalidate`, `$.ui.log`, `$.ui.open`, `$.ui.resolve`, `$.ui.toast`.

The plugin is the whole repository at a release tag (tests and CI files included; only `hooks/ccrig.ts` runs). Remove it with `/plugin uninstall ccrig@ccrig`, or stop every mod for one session with `claude --safe-mode`.

## Reporting a vulnerability

Please open a confidential issue on the repository, or contact the maintainer at the address on [jordanallenlewis.com](https://jordanallenlewis.com). Please do not disclose publicly until a fix is available.

## Not affiliated with Anthropic

This is an unofficial, community tool. It is not affiliated with, endorsed by, or supported by Anthropic.
