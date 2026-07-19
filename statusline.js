#!/usr/bin/env node
/*
 * CCRig: a command center for your terminal
 * ---------------------------------------------------------------------------
 * CREDIT: kickstarted by Hannah Stulberg's guide
 *   "Claude Code for Everything: Your Status Line Is Empty (Let's Fix That)"
 *   https://hannahstulberg.substack.com/p/claude-code-for-everything-your-status-line-is-empty
 * Reused: the status-line-as-command-center idea; the color-coded context bar
 * (green<50 / yellow<70 / red); the folder/model/git/usage segments; and the
 * portable "write it as a Node script" approach. A comment on that article (by
 * AstroHan) noted the plan-usage numbers are already in stdin: the basis for
 * this version dropping the API call.
 *
 * Enhanced here: every value comes from Claude Code's OWN stdin JSON
 * (rate_limits, context_window, effort, fast_mode, thinking), so the RENDER is
 * zero-network (no token, no keychain, no 429s, always fresh). The only network
 * call anywhere is an optional once-a-day update check (updateCheck, off with one
 * flag); the guardian is fully local. Plus: wrapping
 * that tracks live terminal resize; effort + inference-mode flags;
 * unpushed/unpulled commits; date-aware reset times; an active-profile badge;
 * one script for many Claude profiles; and an interactive config editor.
 * Also: a bold ⚠ near-limit warning + resume hint once session/weekly usage
 * crosses `thresholds.usage.warn` (default 90%). Claude Code already
 * persists the full transcript, so the hint just names the command
 * (`claude --continue`) instead of leaving you to remember it mid-crunch.
 * ---------------------------------------------------------------------------
 * SETUP (macOS / Linux / Windows): save this file anywhere, then run
 *   node statusline.js --install
 * It wires your Claude Code settings.json (with a backup) and prints next steps.
 * Restart Claude Code once; edits apply live afterward. `--uninstall` undoes it.
 *
 * CUSTOMIZE: in a Claude Code session run `/statusline-config` (installed by
 * --install) to see every option and change settings conversationally. Or run
 * `node statusline.js --config` for an interactive terminal editor, or hand-edit
 * `statusline.config.json` next to this file (see statusline.config.example.json).
 * `--options` prints the current settings. Config is a separate file, so updating
 * this script never wipes it.
 *
 * THE GUARDIAN (opt-in, wired by --install-guardian): the first status line that
 * acts on your limits instead of only showing them. (1) Auto-pause + auto-resume:
 * at critical usage it checkpoints the exact work state (todos, last request, git
 * HEAD/dirty) and, in autopilot "resume", a detached sleep-safe watcher relaunches
 * `claude --resume <id> -p` at the reset with a prompt that continues the next step
 * and repeats nothing. (2) Keep-working: a Stop hook that refuses to pause while
 * todos remain (loop-guarded, yields to real questions). (3) Time-to-limit forecast
 * in the bar. (4) Cross-profile failover via a shared usage ledger. (5) Compaction-
 * proof checkpoints (PreCompact). All zero-network, opt-in, reversible.
 * ---------------------------------------------------------------------------
 * CLI (manual only: Claude Code calls this with JSON on stdin and no args):
 *   node statusline.js --install            wire Claude Code to this file (backs up settings)
 *   node statusline.js --install-guardian   also wire keep-working + auto-resume (add --auto for hands-free)
 *   node statusline.js --uninstall          remove the status line (and any guardian hooks)
 *   node statusline.js --uninstall-guardian remove only the guardian hooks
 *   node statusline.js --doctor             diagnose a broken or missing status line + guardian
 *   node statusline.js --mode <m>           display density: minimal | normal | expanded
 *   node statusline.js --autopilot <m>      limit behaviour: off | notify | resume
 *   node statusline.js --keep-working <b>   keep working while todos remain: on | off
 *   node statusline.js --config             interactive segment/preview editor
 *   node statusline.js --demo [--cols N]    render sample data (great for screenshots)
 *   node statusline.js --selftest           sanity-check rendering on edge inputs
 *   node statusline.js --version | --help
 */

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const VERSION = '1.3.0';

// where updates come from: the public GitLab repo's main branch (raw files).
// Override the base with CCBSL_UPDATE_BASE (used by tests to point at a local dir).
const UPDATE_BASE = process.env.CCBSL_UPDATE_BASE ||
  'https://gitlab.com/jordanallenlewis/ccrig/-/raw/main';
const UPDATE_SCRIPT_URL = UPDATE_BASE + '/statusline.js';
const UPDATE_CHANGELOG_URL = UPDATE_BASE + '/CHANGELOG.md';
// Supply-chain: paste an Ed25519 PUBLIC key (PEM) here (or set "updatePubkey" in config)
// to REQUIRE that every downloaded update carries a matching statusline.js.sig signature.
// Empty = updates rest on HTTPS/TLS + validation + manual apply (see SECURITY.md). To enable:
//   openssl genpkey -algorithm ed25519 -out key.pem && openssl pkey -in key.pem -pubout
//   sign each release:  openssl pkeyutl -sign -inkey key.pem -rawin -in statusline.js | base64 > statusline.js.sig
const UPDATE_PUBKEY = '';

// ===========================================================================
// DEFAULTS: generic, safe for anyone. Override in statusline.config.json
// (next to this file); your overrides deep-merge over these and survive updates.
// ===========================================================================
const DEFAULT_ORDER = ['profile', 'update', 'folder', 'model', 'downgrade', 'effort', 'flags', 'context', 'git', 'agents', 'caveman', 'billing', 'session', 'weekly', 'forecast', 'resumeHint', 'cost', 'sessionName'];
// what survives in minimal mode; the safety/attention segments stay on purpose
const MINIMAL_KEEP = ['profile', 'update', 'folder', 'model', 'downgrade', 'context', 'git', 'agents', 'forecast', 'resumeHint'];
const MODES = ['minimal', 'normal', 'expanded'];
const DEFAULTS = {
  // minimal: the quiet essentials | normal: your `show` flags | expanded: everything with content
  // switch anytime: node statusline.js --mode <minimal|normal|expanded>  (applies live)
  mode: 'normal',
  order: DEFAULT_ORDER,
  show: {
    profile: 'auto',    // 👤 active Claude profile. 'auto' = only when >1 profile exists; true = always; false = never
    update: true,       // ⬆ shown only when a newer version is available (see updateCheck)
    folder: true,       // 📂 current project (repo-relative)
    model: true,        // ★ model name + [1m] on a 1M-context model
    downgrade: true,    // ⬇ loud alert if the model silently drops tier (Opus → Sonnet) mid-session
    effort: true,       // ⚡ reasoning effort (low…max)
    flags: true,        // fast (when on) / no-think (when thinking is off)
    context: true,      // ctx: color-coded context-window bar
    agents: true,       // 🤖 count of subagents/Task running right now (workflow + subagent support)
    git: true,          // 🌿 branch ●uncommitted ↑unpushed ↓unpulled
    caveman: true,      // [CAVEMAN] badge if the caveman plugin is active
    billing: true,      // 💳 sub (Claude.ai subscription) vs api (pay-per-token)
    session: true,      // 5-hour plan-usage bar + reset time
    weekly: true,       // 7-day plan-usage bar + reset time
    forecast: true,     // ⏳ predictive time-to-limit + pace verdict (Feature 3), shown only when it has something to say
    resumeHint: true,   // ⚠ shown only past thresholds.usage.warn: how to pick back up after reset
    cost: false,        // session $ + lines +added/-removed
    sessionName: false, // the session's title
  },
  thresholds: {
    context: { green: 50, yellow: 70 }, // % filled → color
    usage: { green: 50, yellow: 80, warn: 90, critical: 98 }, // warn: ⚠ + resumeHint; critical: resume ticket + autopilot
  },
  resetStyle: 'clock',  // 'clock' (10:40a, dated if not today) | 'relative' (2h14m)
  resumeTickets: true,  // at critical usage, save resume-tickets/<session>.md with the exact pick-up command
  // ---- Guardian: keep working through soft stops, and survive the hard limit wall ----
  // Feature 2 (Relentless mode): a Stop hook keeps the session working while todos remain.
  //   false | true | { maxContinues: 25, maxStuck: 3 }.  Needs `--install-guardian` to wire the hook.
  keepWorking: false,
  // Feature 1 (Limit Autopilot): what to do when a window crosses `thresholds.usage.critical`.
  //   'off'    do nothing beyond the resume ticket
  //   'notify' desktop notification + a rich checkpoint, once per session
  //   'resume' also relaunch `claude --resume <id>` automatically when the window resets
  // Default 'off' so a plain --install never spawns a notification or writes a checkpoint;
  // --install-guardian sets it to 'notify' (or 'resume' with --auto).
  autopilot: 'off',
  autopilotBuffer: 45,       // seconds to wait past resets_at before an auto-resume relaunch
  autopilotWeekly: false,    // also auto-relaunch for the 7-day window (days-long waits are less reliable; off by default)
  autopilotFailover: false,  // Feature 4: prefer a profile that still has headroom over waiting for the reset
  // Opt-in: let the UNATTENDED auto-resume relaunch bypass permission prompts. The relaunch is
  // headless (`claude --resume -p`) and cannot answer a prompt, so without this a permission gate
  // stalls the pickup. Off by default because it is a real "skip permission checks" escalation;
  // the relaunch prompt still tells the model to favour reversible actions and stop before anything
  // destructive/irreversible. Only affects the guardian's own relaunch, never your interactive session.
  autopilotBypassPermissions: false,
  claudeBin: 'claude',       // how to invoke Claude Code from the watcher (absolute path if not on PATH)
  // Feature 3 (time-to-limit forecast): predictive burn-rate ETA + pace verdict in the bar.
  forecast: true,
  // Feature 4 (cross-profile hint): OFF by default — it writes to a shared ~/.claude-usage-ledger
  // outside your config dir, and cross-account use is a per-user judgement. Opt in with "ledger": true.
  ledger: false,
  downgradeAlert: true,      // ⬇ warn when the model silently downgrades tier mid-session (Opus→Sonnet)
  // Cross-session attention board (`--board`): each live render publishes this session's
  // state to a shared dir so `--board` can show every session across your worktrees/profiles.
  // OFF by default (it writes cwd/model/usage outside the config dir, like the ledger).
  sessionBoard: false,
  // Re-inject a rules file after Claude Code compacts context (SessionStart source=compact),
  // in case compaction drops your project rules. false | true (=CLAUDE.md) | "path/to/file".
  reinjectOnCompact: false,
  // Update notifications: a once-a-day background check pings the public GitLab repo for a
  // newer version and shows an ⬆ badge. The RENDER stays zero-network (it only reads a local
  // cache the background check wrote). A single unauthenticated GET; set false to disable.
  updateCheck: true,
  // Supply-chain: paste an Ed25519 PUBLIC key (PEM) here to REQUIRE that every downloaded --update
  // carries a matching statusline.js.sig signature (see the header for the openssl commands). Empty =
  // TLS-only (the default): the download is still validated + backed up, just not signature-checked.
  updatePubkey: '',
  gitCacheMs: 10000,    // cache git state this long so big repos don't re-shell each ~2s render (0 = off)
  reserveCols: 1,       // safety margin subtracted from terminal width
  // Map a Claude config-dir name to a profile label. Unlisted dirs derive their
  // label from the name (e.g. .claude-work -> "work"). Leave {} for pure auto.
  profileLabels: {},
  // 256-color codes: https://www.ditig.com/256-colors-cheat-sheet
  color: {
    dim: 245, folder: 75, model: 111, effort: 179, flag: 45, caveman: 172,
    green: 78, yellow: 214, red: 203, sky: 75, update: 220, agents: 141, // update badge (gold), agents (purple)
    profileDefault: 39, profilePersonal: 213, // profile badge hues
  },
};

// ---- config loading: deep-merge statusline.config.json over DEFAULTS ----
const CONFIG_PATH = path.join(__dirname, 'statusline.config.json');
function clone(x) { return (x && typeof x === 'object') ? JSON.parse(JSON.stringify(x)) : x; }
function deepMerge(base, over) {
  const out = clone(base);
  if (over && typeof over === 'object' && !Array.isArray(over)) {
    for (const k of Object.keys(over)) {
      out[k] = (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) && over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]))
        ? deepMerge(out[k], over[k]) : clone(over[k]);
    }
  }
  return out;
}
function loadConfig() {
  let merged;
  try { merged = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); }
  catch { merged = clone(DEFAULTS); }
  // a hand-edited config can null out a whole section; restore anything critical
  for (const k of ['show', 'thresholds', 'color', 'profileLabels']) {
    if (!merged[k] || typeof merged[k] !== 'object' || Array.isArray(merged[k])) merged[k] = clone(DEFAULTS[k]);
  }
  for (const k of ['context', 'usage']) {
    if (!merged.thresholds[k] || typeof merged.thresholds[k] !== 'object' || Array.isArray(merged.thresholds[k])) merged.thresholds[k] = clone(DEFAULTS.thresholds[k]);
    for (const key of Object.keys(DEFAULTS.thresholds[k])) { // non-numeric values break bar colors silently
      if (typeof merged.thresholds[k][key] !== 'number') merged.thresholds[k][key] = DEFAULTS.thresholds[k][key];
    }
  }
  for (const k of Object.keys(DEFAULTS.color)) {
    if (typeof merged.color[k] !== 'number') merged.color[k] = DEFAULTS.color[k];
  }
  // numeric keys flow straight into width math / cache TTLs; a hand-edited non-numeric or
  // negative value must not disable wrapping (NaN width) or inflate the terminal width.
  const rc = Number(merged.reserveCols);
  merged.reserveCols = (Number.isFinite(rc) && rc >= 0) ? Math.floor(rc) : DEFAULTS.reserveCols;
  const gc = Number(merged.gitCacheMs);
  merged.gitCacheMs = (Number.isFinite(gc) && gc >= 0) ? Math.floor(gc) : DEFAULTS.gitCacheMs;
  if (!Array.isArray(merged.order) || !merged.order.length) merged.order = clone(DEFAULT_ORDER);
  else {
    // MIGRATION: a saved/example `order` from an older version is missing segments added
    // since (update, downgrade, agents, ...). Union them in next to their default neighbour,
    // so new segments (incl. the downgrade safety alert) surface instead of silently vanishing.
    // Visibility is still governed by each segment's `show` flag; this only fixes `order`.
    for (let i = 0; i < DEFAULT_ORDER.length; i++) {
      const name = DEFAULT_ORDER[i];
      if (merged.order.includes(name)) continue;
      let at = merged.order.length;
      for (let j = i - 1; j >= 0; j--) { const idx = merged.order.indexOf(DEFAULT_ORDER[j]); if (idx !== -1) { at = idx + 1; break; } }
      merged.order.splice(at, 0, name);
    }
  }
  if (!MODES.includes(merged.mode)) merged.mode = 'normal';
  return merged;
}
let CONFIG = loadConfig();

// ===========================================================================
// low-level helpers
// ===========================================================================
// os.homedir() can throw (arbitrary-UID containers with no passwd entry); never die for it
let HOME; try { HOME = os.homedir(); } catch { HOME = process.env.HOME || process.env.USERPROFILE || os.tmpdir(); }
const CFG = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const K = CONFIG.color;
const c = (n, s) => `\x1b[38;5;${n}m${s}\x1b[0m`;
const SEP = c(K.dim, ' │ ');

function readFileSafe(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }
function settingsVal(key) {
  try { return JSON.parse(readFileSafe(path.join(CFG, 'settings.json')))[key]; } catch { return undefined; }
}

// terminal cell width of ONE codepoint: 0 (VS16/ZWJ), 2 (wide/fullwidth/emoji-presentation), else 1.
// Flat integer comparisons only (this is on the hot path, C3): no regex, no per-call allocation.
function glyphWidth(cp) {
  if (cp === 0xFE0F || cp === 0x200D) return 0;                 // variation selector / ZWJ
  if (cp >= 0x1F000) return 2;                                  // astral emoji & symbols
  if (cp === 0x26A1 || cp === 0x2600 || cp === 0x26A0 || cp === 0x23F3) return 2; // ⚡ ☀ ⚠ ⏳ (⬆/⬇ stay 1)
  // East Asian Wide / Fullwidth ranges that actually occur in folder/branch/session names.
  // 0xFF00-0xFF60 is fullwidth (wide); halfwidth kana 0xFF61-0xFF9F stays 1 (deliberately excluded).
  if ((cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0x303E) ||
      (cp >= 0x3041 && cp <= 0x33FF) || (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0xAC00 && cp <= 0xD7A3) ||
      (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE4F) ||
      (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6)) return 2;
  return 1;
}
// display width: strip ANSI, then sum per-codepoint cell widths
function dispWidth(s) {
  s = s.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of s) w += glyphWidth(ch.codePointAt(0));
  return w;
}

// greedily pack segments into lines no wider than the terminal (dynamic wrap)
function wrapSegments(segs, width) {
  const sepW = dispWidth(SEP);
  const lines = [];
  let cur = [], curW = 0;
  for (const s of segs) {
    const sw = dispWidth(s);
    const add = cur.length ? sepW + sw : sw;
    if (cur.length && curW + add > width) { lines.push(cur.join(SEP)); cur = [s]; curW = sw; }
    else { cur.push(s); curW += add; }
  }
  if (cur.length) lines.push(cur.join(SEP));
  return lines.join('\n');
}

// color-coded block bar. `redAt` (default t.yellow) is the % at which the fill turns red;
// usageSeg passes the warn threshold so the bar escalates WITH the ⚠ label, not a tier early.
function bar(pct, width, t, redAt) {
  pct = Math.max(0, Math.min(100, pct));
  // reserve the final block for a TRUE 100%, so a limit bar does not read "full" at ~94% (Math.round did)
  const filled = pct >= 100 ? width : Math.min(width - 1, Math.floor((pct / 100) * width));
  const red = redAt == null ? t.yellow : redAt;
  const col = pct <= t.green ? K.green : pct < red ? K.yellow : K.red;
  return c(col, '█'.repeat(filled)) + c(K.dim, '░'.repeat(width - filled));
}

// live terminal width: COLUMNS (Claude Code re-passes it on every resize) first;
// ioctl / stdout fallbacks for when this runs outside Claude Code.
function ttyWidth() {
  let fd = null, ws = null;
  try {
    fd = fs.openSync('/dev/tty', 'r+');
    ws = new (require('tty').WriteStream)(fd);
    if (ws.columns > 0) return ws.columns;
  } catch { /* no controlling tty */ }
  finally { if (ws) { try { ws.destroy(); } catch {} } else if (fd != null) { try { fs.closeSync(fd); } catch {} } }
  return null;
}
function getWidth() {
  const e = parseInt(process.env.COLUMNS, 10);
  if (e > 0) return e;
  const t = ttyWidth();
  if (t) return t;
  if (process.stdout && process.stdout.columns) return process.stdout.columns;
  return 100;
}

// truncate a folder to fit `max` terminal CELLS, keeping the tail (the most specific dir),
// never slicing a surrogate pair; prefixes '…' when trimmed. Cell-aware via glyphWidth.
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

function nowSec() { return Math.floor(Date.now() / 1000); }
// a window is still counting against you only while its reset is in the future;
// a reset in the past means the window already refreshed (fresh numbers arrive on
// your next message), so we stop showing a stale time and a stale warning.
function windowActive(reset) { return reset == null || reset > nowSec(); }

// reset time: absolute clock (dated when not today) or relative countdown
function fmtReset(epochSec) {
  if (epochSec <= nowSec()) return 'now'; // reset time has passed; quota refreshes on the next message
  if (CONFIG.resetStyle === 'relative') {
    let s = epochSec - Math.floor(Date.now() / 1000);
    if (s <= 0) return 'now';
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60);
    if (d > 0) return h ? `${d}d${h}h` : `${d}d`;
    if (h > 0) return m ? `${h}h${m}m` : `${h}h`;
    return `${m}m`;
  }
  const d = new Date(epochSec * 1000), now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (CONFIG.resetStyle === 'clock24') {   // 24-hour locales: 14:40, dated M/D 14:40 when not today
    const c24 = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return sameDay ? c24 : `${d.getMonth() + 1}/${d.getDate()} ${c24}`;
  }
  let h = d.getHours(); const m = d.getMinutes();
  const ap = h >= 12 ? 'p' : 'a'; h = h % 12 || 12;
  const clock = `${h}:${String(m).padStart(2, '0')}${ap}`;
  return sameDay ? clock : `${d.getMonth() + 1}/${d.getDate()} ${clock}`;
}
const cBold = (n, s) => `\x1b[1m\x1b[38;5;${n}m${s}\x1b[0m`;
function warnAtOf(t) { return t.warn != null ? t.warn : 90; }
const usageSeg = (label, pct, reset) => {
  const t = CONFIG.thresholds.usage;
  const near = pct >= warnAtOf(t) && windowActive(reset); // a passed reset means the window refreshed: no warning
  const lbl = near ? cBold(K.red, '⚠ ' + label) : c(K.dim, label);
  const val = near ? cBold(K.red, Math.round(pct) + '%') : c(K.dim, Math.round(pct) + '%');
  return `${lbl} ${bar(pct, 8, t, warnAtOf(t))} ${val}` + (reset ? c(K.dim, ' ↺' + fmtReset(reset)) : '');
};
// At >= thresholds.usage.critical (default 98%), drop a resume ticket: a tiny file
// with the exact command to reopen THIS session after the limit resets. Claude Code
// already saves the transcript continuously, so nothing is at risk; the ticket is
// findability. Days later, after a weekly reset, `claude --continue` may resume the
// wrong (a newer) session. The ticket names the precise one.
function writeResumeTicket(input, pct, windowName, resetEpoch) {
  const sid = input.session_id;
  if (!sid || !/^[A-Za-z0-9-]+$/.test(sid)) return false;
  try {
    const dir = path.join(CFG, 'resume-tickets');
    const file = path.join(dir, sid + '.md');
    if (fs.existsSync(file)) return true; // one ticket per session; written once
    fs.mkdirSync(dir, { recursive: true });
    const cwd = (input.workspace && input.workspace.current_dir) || input.cwd || process.cwd();
    const name = input.session_name || '(unnamed session)';
    const when = resetEpoch ? fmtReset(resetEpoch) : 'the next window';
    fs.writeFileSync(file, [
      '# Claude Code resume ticket',
      '',
      'Saved by the status line at ' + new Date().toISOString() + ' (' + windowName + ' usage ' + Math.round(pct) + '%, resets ' + when + ').',
      'Claude Code saves the transcript continuously, so nothing was lost. This ticket is the pointer back.',
      '',
      'Session: "' + name + '"',
      'Profile: ' + profileLabel(CFG) + '  (' + CFG + ')',
      'Project: ' + cwd,
      '',
      'Pick up exactly where you left off (this pins the profile the session ran under, so it',
      'resumes on the right account even from a shell set to a different profile):',
      '',
      '    ' + resumeCmdLine(CFG, cwd, sid),
      '',
      'Or, from that project directory with this profile active, run `claude --continue`.',
      '',
    ].join('\n'));
    for (const f of fs.readdirSync(dir)) { // keep the drawer tidy: 14-day retention
      try { const p = path.join(dir, f); if (Date.now() - fs.statSync(p).mtimeMs > 14 * 86400 * 1000) fs.unlinkSync(p); } catch {}
    }
    return true;
  } catch { return false; }
}

// ===========================================================================
// GUARDIAN: keep a session working through soft stops, and survive the hard
// rate-limit wall with a checkpoint + auto-resume. Everything below reads the
// same stdin/transcript Claude Code already produces: still zero-network.
// ===========================================================================

// --- config getters that tolerate a hand-edited config (scalar or object) ---
function cfgAutopilot() { const m = CONFIG.autopilot; return (m === 'off' || m === 'notify' || m === 'resume') ? m : 'notify'; }
function cfgKeepWorking() {
  const k = CONFIG.keepWorking;
  if (k === true) return { maxContinues: 25, maxStuck: 3 };
  if (k && typeof k === 'object' && !Array.isArray(k)) {
    return { maxContinues: (k.maxContinues > 0 ? k.maxContinues : 25), maxStuck: (k.maxStuck > 0 ? k.maxStuck : 3) };
  }
  return null; // disabled
}
function claudeBin() { return (typeof CONFIG.claudeBin === 'string' && CONFIG.claudeBin) || 'claude'; }
// real pluralization for user-facing counts ("1 watcher" / "3 watchers"), never "watcher(s)".
function plural(n, singular, pluralForm) { return n === 1 ? singular : (pluralForm || singular + 's'); }
// process-spawning side effects (desktop notify, the watcher) are gated so the
// test suite and CI never launch anything; file side effects (checkpoints) are not.
function actAllowed() { return !process.env.CCBSL_NO_ACT; }
const SID_RE = /^[A-Za-z0-9-]+$/;
function guardDir() { return path.join(CFG, 'guardian'); }

// read the last `bytes` of a transcript as parsed JSONL lines (newest work is at the tail)
function readTranscriptTail(tp, bytes) {
  if (!tp) return [];
  try {
    const fd = fs.openSync(tp, 'r');
    const size = fs.fstatSync(fd).size;
    const span = Math.min(size, bytes || 524288);
    const buf = Buffer.alloc(span);
    fs.readSync(fd, buf, 0, span, size - span);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n').filter(Boolean);
  } catch { return []; }
}
function scanTodos(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o && o.isSidechain) continue;   // defense-in-depth: never treat a subagent turn as the main agent's
    const content = o && o.message && o.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && b.type === 'tool_use' && b.name === 'TodoWrite' && b.input && Array.isArray(b.input.todos)) return b.input.todos;
    }
  }
  return null;
}
// the most recent TodoWrite state: [{content,status,activeForm}] or null. `fullScan` (used
// by the Stop hook, off the hot path) re-reads the whole file if a big tool_result pushed
// the last TodoWrite out of the tail window — so keep-working doesn't wrongly see "no todos".
function latestTodos(tp, fullScan) {
  let todos = scanTodos(readTranscriptTail(tp, 524288));
  if (todos === null && fullScan && tp) {
    try { if (fs.statSync(tp).size > 524288) todos = scanTodos(fs.readFileSync(tp, 'utf8').split('\n').filter(Boolean)); } catch {}
  }
  return todos;
}
// the most recent human request text (skips tool_result-only user turns)
function latestUserText(tp) {
  const lines = readTranscriptTail(tp, 524288);
  for (let i = lines.length - 1; i >= 0; i--) {
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    if (!o || o.isSidechain || o.type !== 'user' || !o.message) continue;
    const cnt = o.message.content;
    if (typeof cnt === 'string') { if (cnt.trim()) return cnt.trim().slice(0, 500); continue; }
    if (Array.isArray(cnt)) {
      const txt = cnt.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join(' ').trim();
      if (txt) return txt.slice(0, 500);
    }
  }
  return '';
}
// the trailing assistant text (used to detect "Claude is asking the user a question")
function latestAssistantText(tp) {
  const lines = readTranscriptTail(tp, 262144);
  for (let i = lines.length - 1; i >= 0; i--) {
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    if (!o || o.isSidechain || o.type !== 'assistant' || !o.message) continue;
    const cnt = o.message.content;
    if (typeof cnt === 'string') return cnt.trim();
    if (Array.isArray(cnt)) {
      const txt = cnt.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join(' ').trim();
      return txt;
    }
  }
  return '';
}
// in-flight orchestration: Task/Agent subagents whose tool_use has no matching tool_result
// yet = running right now. Foreground Task subagents show live; Workflows ack immediately
// (background) so they read as done here, which is correct.
// Cached by transcript SIZE: transcripts are append-only, so an unchanged size means the
// result is unchanged — this keeps the 768KB read off the hot path on idle refreshes.
function inflightAgents(tp) {
  if (!tp) return [];
  let size;
  try { size = fs.statSync(tp).size; } catch { return []; }
  const cacheFile = path.join(os.tmpdir(), 'ccbsl-agents-' + strHash(tp) + '.json');
  try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (c && c.size === size && Array.isArray(c.list)) return c.list; } catch {}
  const list = computeInflightAgents(tp);
  try { fs.writeFileSync(cacheFile, JSON.stringify({ size, list })); } catch {}
  return list;
}
function computeInflightAgents(tp) {
  const lines = readTranscriptTail(tp, 786432);
  const results = new Set();
  const uses = [];
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    const cnt = o && o.message && o.message.content;
    if (!Array.isArray(cnt)) continue;
    for (const b of cnt) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_result' && b.tool_use_id) results.add(b.tool_use_id);
      else if (b.type === 'tool_use' && (b.name === 'Task' || b.name === 'Agent') && b.id) {
        uses.push({ id: b.id, desc: (b.input && (b.input.description || b.input.subagent_type)) || 'subagent' });
      }
    }
  }
  return uses.filter((u) => !results.has(u.id));
}
// 🤖 segment: how many subagents are running right now
let DEMO_AGENTS = 0; // set by --demo to showcase the segment
function agentsSeg(input) {
  const n = DEMO_AGENTS || inflightAgents(input.transcript_path).length;
  if (!n) return '';
  return c(K.agents, '🤖 ' + n + (n === 1 ? ' agent' : ' agents'));
}
// ⬇ segment: Claude Code silently drops Opus → Sonnet when you approach the Opus cap.
// Track the highest model tier seen this session and shout if the current one is lower.
function modelTier(name) { const n = String(name == null ? '' : name).toLowerCase(); return /opus/.test(n) ? 3 : /sonnet/.test(n) ? 2 : /haiku/.test(n) ? 1 : 0; }
let DEMO_DOWNGRADE = null; // [fromName, toName] set by --demo
function downgradeSeg(input, live) {
  if (CONFIG.downgradeAlert === false) return '';
  if (DEMO_DOWNGRADE) return cBold(K.red, '⬇ ' + DEMO_DOWNGRADE[1]) + c(K.dim, ' (was ' + DEMO_DOWNGRADE[0] + ')');
  const sid = input.session_id;
  const cur = (input.model && (input.model.display_name || input.model.id)) || '';
  const tier = modelTier(cur);
  if (!tier || !sid || !SID_RE.test(sid)) return '';
  const f = path.join(guardDir(), sid + '.model');
  let top = 0, topName = '';
  try { const o = JSON.parse(fs.readFileSync(f, 'utf8')); top = o.tier || 0; topName = o.name || ''; } catch {}
  if (tier >= top) { // an equal-or-higher tier is the session's ceiling: record it
    if (live && tier > top) { try { fs.mkdirSync(guardDir(), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ tier, name: cur })); sweepGuardDir(); } catch {} }
    return '';
  }
  // A drop below the ceiling. Only surface when usage is ELEVATED — that's when Claude Code
  // auto-downgrades. But a deliberate /model switch at high usage looks identical, so this is
  // a low-key yellow heads-up ("you're on a lower tier"), not a bold-red alarm.
  const rl = input.rate_limits || {};
  const pctOf = (o) => (o && typeof o.used_percentage === 'number') ? o.used_percentage : 0;
  if (Math.max(pctOf(rl.five_hour), pctOf(rl.seven_day)) < 50) return '';
  const shortName = (s) => s.split(/[\s(]/)[0];
  return c(K.yellow, '⬇ ' + shortName(cur)) + c(K.dim, ' (was ' + shortName(topName) + ')');
}

// --- checkpoint: a rich, machine-readable snapshot of exactly where work stands.
// Feeds both the auto-resume relaunch and the SessionStart re-injection, so a
// resumed session neither loses progress nor repeats finished work.
function checkpointPath(sid) { return path.join(guardDir(), sid + '.checkpoint.json'); }
function inputCwd(input) { return (input.workspace && input.workspace.current_dir) || input.cwd || process.cwd(); }
// a cheap git fingerprint so a resumed run can RECONCILE (not blindly continue):
// HEAD sha + whether the tree was dirty when we checkpointed.
function gitSnapshot(cwd) {
  try {
    const head = execSync('git rev-parse HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 700, encoding: 'utf8' }).trim();
    const status = execSync('git --no-optional-locks status --porcelain', { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 700, encoding: 'utf8' });
    return { head, dirty: status.trim().length > 0 };
  } catch { return null; }
}
function writeCheckpoint(input, meta) {
  const sid = input.session_id;
  if (!sid || !SID_RE.test(sid)) return null;
  try {
    fs.mkdirSync(guardDir(), { recursive: true });
    const cwd = inputCwd(input);
    // preserve an existing limit-window schedule: a PreCompact snapshot (no resets_at)
    // must not wipe the resets_at/window an armed auto-resume watcher depends on.
    let resets_at = (meta && meta.resets_at) || null;
    let window = (meta && meta.window) || '';
    let reason = (meta && meta.reason) || 'checkpoint';
    // a PreCompact (no resets_at) after a limit checkpoint must keep the limit schedule AND its reason,
    // so the resume prompt still says "interrupted by a usage limit", not "context was just compacted".
    if (resets_at == null) { const ex = readCheckpoint(sid); if (ex && ex.resets_at) { resets_at = ex.resets_at; if (!window) window = ex.window || ''; if (ex.reason && /limit/.test(ex.reason)) reason = ex.reason; } }
    const data = {
      session_id: sid,
      session_name: input.session_name || '',
      cwd,
      config_dir: CFG,   // the profile that OWNS this session; the resume MUST run under it
      saved_at: new Date().toISOString(),
      reason,
      window,
      resets_at,
      transcript_path: input.transcript_path || '',
      todos: latestTodos(input.transcript_path) || [],
      last_request: latestUserText(input.transcript_path),
      agents: inflightAgents(input.transcript_path).map((a) => a.desc).slice(0, 8), // orchestration in flight at the limit
      git: gitSnapshot(cwd),
    };
    fs.writeFileSync(checkpointPath(sid), JSON.stringify(data, null, 2) + '\n');
    sweepGuardDir();
    return data;
  } catch { return null; }
}
// 14-day retention sweep over the guardian dir (checkpoints, tickets-adjacent markers,
// per-session .model files). Runs at points that fire at most once per session, not per render.
function sweepGuardDir() {
  try {
    for (const f of fs.readdirSync(guardDir())) {
      try { const p = path.join(guardDir(), f); if (Date.now() - fs.statSync(p).mtimeMs > 14 * 86400 * 1000) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}
function readCheckpoint(sid) {
  try { return JSON.parse(fs.readFileSync(checkpointPath(sid), 'utf8')); } catch { return null; }
}
// turn a checkpoint into a resume prompt that forbids repeating finished work
function resumePromptFromCheckpoint(cp, crossAccount, unattended) {
  const todos = Array.isArray(cp.todos) ? cp.todos : [];
  const done = todos.filter((t) => t && t.status === 'completed').map((t) => t.content).filter(Boolean);
  const rest = todos.filter((t) => t && t.status !== 'completed')
    .map((t) => (t.status === 'in_progress' ? '[in progress] ' : '') + (t.content || t.activeForm)).filter(Boolean);
  const why = cp.reason && /limit/.test(cp.reason) ? 'You were interrupted mid-task by a Claude usage limit and are resuming now.'
    : cp.reason && /compact/.test(cp.reason) ? 'Your context was just compacted. Here is the work state captured beforehand so nothing is lost.'
    : 'You are resuming this session.';
  // cross-account failover starts a FRESH session (no prior transcript); a same-account
  // --resume has the full transcript. Say the true thing so the model doesn't hallucinate.
  const transcriptLine = crossAccount
    ? ' You are continuing on a different profile, so the earlier transcript is NOT here. Rely on the checkpoint below and the working tree, and run `git status` first.'
    : ' The full transcript above is intact, so do NOT redo anything already finished.';
  const L = [why + transcriptLine];
  if (cp.last_request) L.push('', 'Original request: ' + cp.last_request);
  if (done.length) L.push('', 'Already DONE (do not repeat):', ...done.map((x) => '- ' + x));
  if (rest.length) L.push('', 'Remaining TODO (continue from the first one):', ...rest.map((x) => '- ' + x));
  else L.push('', 'No open todos were recorded. Review the last few steps in the transcript and finish the original request.');
  if (cp.git && cp.git.head) {
    L.push('', 'When interrupted, git HEAD was ' + cp.git.head.slice(0, 12) + ' and the working tree was ' + (cp.git.dirty ? 'DIRTY (uncommitted changes were in progress)' : 'clean') + '. First run `git status` to reconcile the tree against what the transcript says you did, then continue.');
  }
  const agents = Array.isArray(cp.agents) ? cp.agents.filter(Boolean) : [];
  if (agents.length) {
    L.push('', 'NOTE: ' + agents.length + ' subagent(s)/workflow(s) were running when the limit hit and did NOT survive it: ' +
      agents.slice(0, 6).join('; ') + '. They are not auto-resumed. Re-dispatch or re-run whichever are still needed.');
  }
  // unattended-safety: ONLY when a scheduler relaunched us headless (not on an attended
  // compaction or a manual resume, where a human is present and this would mislead).
  if (unattended) {
    L.push('', 'IMPORTANT: you are resuming UNATTENDED (a scheduler relaunched you at the limit reset; no human is watching). ' +
      'Do the next concrete step, favour reversible actions, and do NOT kick off new long-running workflows or many parallel subagents unprompted. ' +
      'If the next step needs a human decision, a secret, or is destructive/irreversible, stop and leave a clear note instead of guessing.');
  }
  L.push('', 'Continue now from the first remaining step.');
  return L.join('\n');
}

// --- best-effort desktop notification + detached process spawn (never throw) ---
function spawnDetached(cmd, args, opts) {
  try {
    const { spawn } = require('child_process');
    // windowsHide: no flashing console window when a background helper fires on Windows
    const child = spawn(cmd, args, Object.assign({ detached: true, stdio: 'ignore', windowsHide: true }, opts || {}));
    // spawn ENOENT (a missing notifier binary) is delivered ASYNC as an 'error' event, after the
    // caller's try/catch has returned; without this handler it crashes the live render. Best-effort: swallow.
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}
// build the platform notification command. On win32 the payload travels via env (never in code
// position), so a $(…)/backtick/quote in a session name cannot inject into PowerShell.
function notifySpec(platform, title, msg) {
  if (platform === 'darwin') return { cmd: 'osascript', args: ['-e', 'display notification ' + JSON.stringify(msg) + ' with title ' + JSON.stringify(title)], env: {} };
  if (platform === 'linux') return { cmd: 'notify-send', args: [title, msg], env: {} };
  if (platform === 'win32') {
    // zero-dep WinRT toast (no BurntToast); reads $env:CCBSL_N_TITLE/$env:CCBSL_N_MSG, so no injection
    const script = [
      '$ErrorActionPreference="SilentlyContinue"',
      '[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null',
      '$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      '$x=$t.GetElementsByTagName("text")',
      '$x.Item(0).AppendChild($t.CreateTextNode($env:CCBSL_N_TITLE))|Out-Null',
      '$x.Item(1).AppendChild($t.CreateTextNode($env:CCBSL_N_MSG))|Out-Null',
      '$n=[Windows.UI.Notifications.ToastNotification]::new($t)',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Claude Code").Show($n)',
    ].join(';');
    return { cmd: 'powershell', args: ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], env: { CCBSL_N_TITLE: title, CCBSL_N_MSG: msg } };
  }
  return null;
}
function notify(title, msg) {
  if (!actAllowed()) return;
  const spec = notifySpec(process.platform, String(title == null ? '' : title), String(msg == null ? '' : msg));
  if (spec) spawnDetached(spec.cmd, spec.args, { env: Object.assign({}, process.env, spec.env) });
}
// do a once-per-session action, guarded by a marker file under guardian/
function oncePerSession(sid, tag, fn) {
  if (!sid || !SID_RE.test(sid)) return false;
  try {
    fs.mkdirSync(guardDir(), { recursive: true });
    const marker = path.join(guardDir(), sid + '.' + tag);
    if (fs.existsSync(marker)) return false;
    fs.writeFileSync(marker, new Date().toISOString() + '\n');
  } catch { return false; }
  try { fn(); } catch {}
  return true;
}

// --- Feature 4: cross-profile usage ledger. Each render records THIS profile's
// last-seen usage to a shared dir in HOME (not CFG), so any profile can later see
// which others still have headroom. Honest about staleness: entries carry a time.
function ledgerDir() { return path.join(HOME, '.claude-usage-ledger'); }
function writeLedger(input, sPct, sReset, wPct, wReset) {
  if (CONFIG.ledger === false || !actAllowed()) return;
  const base = path.basename(CFG);
  if (!/^\.claude(-[A-Za-z0-9._-]+)?$/.test(base)) return;
  writeJsonAtomic(path.join(ledgerDir(), base + '.json'), {   // atomic: concurrent profiles never truncate it
    profile: base, session: sPct, sessionReset: sReset, weekly: wPct, weeklyReset: wReset,
    cwd: inputCwd(input), ts: Math.floor(Date.now() / 1000),
  });
}

// --- cross-session attention board: each live render publishes THIS session's state to a
// shared dir so `--board` can show every session across worktrees/profiles. Opt-in.
function boardDir() { return path.join(HOME, '.claude-rig-sessions'); }
function writeBoard(input, sPct, sReset, wPct, wReset, ctx, agents) {
  if (CONFIG.sessionBoard !== true) return;
  const sid = input.session_id;
  if (!sid || !SID_RE.test(sid)) return;
  const cwd = inputCwd(input);
  writeJsonAtomic(path.join(boardDir(), sid + '.json'), {
    sid, cwd, project: path.basename(cwd),
    profile: path.basename(CFG),
    model: (input.model && (input.model.display_name || input.model.id)) || '',
    session: sPct, sessionReset: sReset, weekly: wPct, weeklyReset: wReset,
    ctx: (ctx == null ? null : ctx), agents: agents || 0, ts: Date.now(),
  });
}
// another profile with headroom, freshest first; null if none qualifies
function pickFreshProfile(maxPct, maxAgeSec) {
  const here = path.basename(CFG);
  let best = null;
  try {
    for (const f of fs.readdirSync(ledgerDir())) {
      if (!f.endsWith('.json')) continue;
      let e; try { e = JSON.parse(fs.readFileSync(path.join(ledgerDir(), f), 'utf8')); } catch { continue; }
      if (!e || e.profile === here) continue;
      // e.profile becomes CLAUDE_CONFIG_DIR on failover; reject anything that is not a real .claude*
      // basename (never a traversal), matching writeLedger's own name gate, and confirm it stays under HOME.
      if (typeof e.profile !== 'string' || !/^\.claude(-[A-Za-z0-9._-]+)?$/.test(e.profile)) continue;
      if (!path.resolve(HOME, e.profile).startsWith(HOME + path.sep)) continue;
      const age = Math.floor(Date.now() / 1000) - (e.ts || 0);
      if (age > (maxAgeSec || 6 * 3600)) continue;                 // too stale to trust
      const s = typeof e.session === 'number' ? e.session : 100;
      const w = typeof e.weekly === 'number' ? e.weekly : 100;
      const head = Math.max(s, w);
      if (head >= (maxPct != null ? maxPct : 85)) continue;        // not enough headroom
      if (!best || head < best.head) best = { profile: e.profile, dir: path.join(HOME, e.profile), head, session: s, weekly: w };
    }
  } catch {}
  return best;
}
function profileLabelOf(base) {
  return (CONFIG.profileLabels && CONFIG.profileLabels[base]) || base.replace(/^\.?claude-?/, '') || 'default';
}

// --- Feature 3: burn-rate forecast. Keep a tiny rolling sample of usage over
// time (per session, in tmp) and project when the window would hit 100%.
function sampleFile(sid) { return path.join(os.tmpdir(), 'ccbsl-usage-' + strHash(sid) + '.jsonl'); }
function recordSample(sid, sPct, wPct) {
  if (CONFIG.forecast === false || !sid || !SID_RE.test(sid)) return;
  const now = Math.floor(Date.now() / 1000);
  const file = sampleFile(sid);
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch {}
  // first sample for this session: sweep stale ccbsl-usage-* files (one per old session
  // accumulates in tmp otherwise). Mirrors the 14-day retention on tickets/checkpoints.
  if (!lines.length) {
    try {
      const tmp = os.tmpdir();
      for (const f of fs.readdirSync(tmp)) {
        if (f.startsWith('ccbsl-usage-') && f.endsWith('.jsonl')) {
          try { const p = path.join(tmp, f); if (Date.now() - fs.statSync(p).mtimeMs > 14 * 86400 * 1000) fs.unlinkSync(p); } catch {}
        }
      }
    } catch {}
  }
  // a window reset (usage drops sharply) invalidates the old slope: start the buffer fresh
  try {
    const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
    if (last) {
      if ((sPct != null && typeof last.s === 'number' && sPct < last.s - 15) || (wPct != null && typeof last.w === 'number' && wPct < last.w - 15)) lines = [];
      else if (now - last.t < 12) return; // throttle: at most one sample per 12s
    }
  } catch {}
  lines.push(JSON.stringify({ t: now, s: sPct == null ? null : Math.round(sPct * 10) / 10, w: wPct == null ? null : Math.round(wPct * 10) / 10 }));
  if (lines.length > 40) lines = lines.slice(-40);               // rolling window
  try { fs.writeFileSync(file, lines.join('\n') + '\n'); } catch {}
}
// least-squares slope (%/sec) of the chosen field over the samples, or null
function burnRate(sid, field) {
  let lines = [];
  try { lines = fs.readFileSync(sampleFile(sid), 'utf8').split('\n').filter(Boolean); } catch { return null; }
  const pts = [];
  for (const l of lines) { let o; try { o = JSON.parse(l); } catch { continue; } if (o && typeof o[field] === 'number') pts.push([o.t, o[field]]); }
  if (pts.length < 3) return null;
  const t0 = pts[0][0];
  const span = pts[pts.length - 1][0] - t0;
  if (span < 30) return null;                                     // too little time to trust a rate
  // rebase time to t0 before the least-squares sums: raw epoch seconds (~1.78e9)
  // otherwise blow up n*Σt² and (Σt)² into near-equal ~1e19 values whose difference
  // loses all precision (catastrophic cancellation), wrecking the slope.
  const n = pts.length; let st = 0, sv = 0, stv = 0, stt = 0;
  for (const [tRaw, v] of pts) { const t = tRaw - t0; st += t; sv += v; stv += t * v; stt += t * t; }
  const denom = n * stt - st * st;
  if (denom === 0) return null;
  const slope = (n * stv - st * sv) / denom;                      // %/sec
  return { slope, last: pts[pts.length - 1][1] };
}

// spawn the detached, sleep-safe watcher that will relaunch this session at reset
function armWatcher(sid, cwd) {
  if (!actAllowed()) return;
  spawnDetached(process.execPath, [__filename, '--watch', sid], { cwd });
}
// Feature 1: at critical usage, snapshot the work and, per config, arm auto-resume.
function armAutopilot(input, which, pct, resetEpoch) {
  const sid = input.session_id;
  if (!sid || !SID_RE.test(sid)) return;
  const mode = cfgAutopilot();
  if (mode === 'off') return; // plain --install (default): no checkpoint, no notify, no watcher
  const willResume = mode === 'resume' && (which === 'session' || CONFIG.autopilotWeekly === true);
  // A second limit in one session (a later window hitting critical) must re-arm, not go stale.
  // Detect a changed binding window/reset and, in resume mode, disarm the old watcher + clear its
  // once-markers so a fresh watcher/notification fires for the NEW schedule.
  const ex = readCheckpoint(sid);
  const windowChanged = !ex || ex.window !== which || ex.resets_at !== resetEpoch;
  if (windowChanged) {
    writeCheckpoint(input, { reason: which + ' limit critical', window: which, resets_at: resetEpoch });
    if (willResume) {
      try { const pid = parseInt(fs.readFileSync(watchPidFile(sid), 'utf8'), 10) || 0; if (isOurWatcher(pid, sid)) process.kill(pid); } catch {}
      for (const tag of ['watch', 'notified']) { try { fs.unlinkSync(path.join(guardDir(), sid + '.' + tag)); } catch {} }
    } else {
      try { fs.unlinkSync(path.join(guardDir(), sid + '.notified')); } catch {} // renotify for the new window
    }
  }
  const label = which === 'session' ? 'session (5h)' : 'weekly (7d)';
  const when = resetEpoch ? fmtReset(resetEpoch) : 'the next window';
  oncePerSession(sid, 'notified', () => notify('Claude Code: ' + label + ' limit',
    'Work checkpointed. ' + (willResume ? 'Auto-resume armed for ' + when + '.' : 'Resume with claude --resume after ' + when + '.')));
  if (willResume) oncePerSession(sid, 'watch', () => armWatcher(sid, inputCwd(input)));
}
// Feature 4: a compact hint pointing at another profile that still has headroom
function failoverHint() {
  if (CONFIG.ledger === false) return '';
  const fo = pickFreshProfile(85, 6 * 3600);
  if (!fo) return '';
  return c(K.sky, '⤳ ' + profileLabelOf(fo.profile) + ' free ' + Math.round(100 - fo.head) + '%');
}

// Shown once session OR weekly usage crosses thresholds.usage.warn. Escalates at
// critical: the resume ticket + checkpoint are written and autopilot is armed.
function resumeHintSeg(input, sPct, wPct, sReset, wReset, live) {
  const t = CONFIG.thresholds.usage;
  const warnAt = warnAtOf(t);
  const critAt = t.critical != null ? t.critical : 98;
  // only an ACTIVE window (reset still in the future) counts; a passed reset refreshed it
  const near = (p, r) => p != null && p >= warnAt && windowActive(r);
  const sOn = near(sPct, sReset), wOn = near(wPct, wReset);
  if (!sOn && !wOn) return '';
  const sCrit = sOn && sPct >= critAt, wCrit = wOn && wPct >= critAt;
  if (sCrit || wCrit) {
    const which = sCrit ? 'session' : 'weekly';
    const pct = sCrit ? sPct : wPct, reset = sCrit ? sReset : wReset;
    // side effects (ticket/checkpoint/watcher/notify) only on the LIVE render, so a
    // hand-edited `critical` threshold can't make --demo/--config/--selftest write files.
    const saved = live && CONFIG.resumeTickets !== false && writeResumeTicket(input, pct, which, reset);
    if (live) armAutopilot(input, which, pct, reset);
    const willResume = cfgAutopilot() === 'resume' && (which === 'session' || CONFIG.autopilotWeekly === true);
    const tail = willResume
      ? c(K.dim, ': checkpoint saved, ') + c(K.yellow, 'autopilot armed')
      : c(K.dim, saved ? ': resume ticket saved, pick up with ' : ': resume with ') + c(K.yellow, 'claude --resume');
    const fo = failoverHint();
    return cBold(K.red, '⚠ limit imminent') + tail + (fo ? c(K.dim, ' · ') + fo : '');
  }
  return cBold(K.red, '⚠ near limit') + c(K.dim, ': auto-saved, resume with ') + c(K.yellow, 'claude --continue');
}

// Feature 3: predictive burn-rate ETA + pace verdict, from the sample ring buffer.
// Shows only when it has something worth saying (enough samples + a live window).
function forecastSeg(sid, sPct, sReset, wPct, wReset) {
  if (CONFIG.forecast === false || !sid) return '';
  const now = nowSec();
  // pick the window projected to hit its ceiling first
  const cands = [];
  const consider = (name, pct, reset) => {
    // need a real, future reset to forecast: without one there is no horizon to compare against
    if (pct == null || reset == null || !windowActive(reset)) return;
    const br = burnRate(sid, name === 'session' ? 's' : 'w');
    if (!br || br.slope <= 0) return;
    const etaSec = ((100 - br.last) / br.slope);                    // seconds to 100%
    if (etaSec <= 0) return;
    cands.push({ name, etaSec, toReset: reset - now, pct });
  };
  consider('session', sPct, sReset);
  consider('weekly', wPct, wReset);
  if (!cands.length) return '';
  cands.sort((a, b) => a.etaSec - b.etaSec);
  // A window that resets before it would exhaust never blocks you. Show the soonest
  // window that WILL actually block; only if none will, report the soonest as safe.
  const threats = cands.filter((c) => c.etaSec < c.toReset);
  if (!threats.length) return c(K.green, '⏳ ' + cands[0].name + ' safe (resets first)');
  const top = threats[0];
  const mins = Math.max(1, Math.round(top.etaSec / 60));
  const human = mins >= 60 ? Math.floor(mins / 60) + 'h' + (mins % 60 ? (mins % 60) + 'm' : '') : mins + 'm';
  const col = mins <= 15 ? K.red : mins <= 45 ? K.yellow : K.green;
  const verdict = mins <= 15 ? ' · slow down' : '';
  return c(col, '⏳ ~' + human + ' to ' + top.name + ' limit' + verdict);
}

// ===========================================================================
// UPDATES: a once-a-day background check pings the public repo for a newer
// version and caches the result; the render only READS that cache (zero-network).
// ===========================================================================
function updateCacheFile() { return path.join(CFG, '.ccbsl-update.json'); }
function readUpdateInfo() { try { return JSON.parse(fs.readFileSync(updateCacheFile(), 'utf8')); } catch { return null; } }
// atomic JSON write (tmp + rename) so a killed writer never leaves half-written JSON
function writeJsonAtomic(file, obj) {
  // pid-unique tmp so two concurrent same-profile writers don't clobber each other's temp
  let tmp;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return true;
  } catch { try { if (tmp) fs.unlinkSync(tmp); } catch {} return false; } // never strand the tmp (Windows EPERM on rename-over-open)
}
function updateNotifierOff() { return !!process.env.NO_UPDATE_NOTIFIER; }
// compare dotted numeric versions; true if a > b (non-numeric parts ignored safely).
// Policy: keep VERSION strictly numeric x.y.z — a '-rc' suffix makes parseRemoteVersion
// return null (the check then no-ops silently), which is the intended safe degrade.
function semverGt(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; }
  return false;
}
// ⬆ badge: shown only when a newer version is cached, not yet dismissed, and the check
// is still fresh (a blocked network shouldn't nag forever about a version you can't fetch).
let DEMO_UPDATE_LATEST = null; // set by --demo so the preview can show the badge
function updateSeg(info) {
  if (CONFIG.updateCheck === false || updateNotifierOff()) return '';
  const latest = DEMO_UPDATE_LATEST || (info && info.latest);
  if (!latest || !semverGt(latest, VERSION)) return '';
  if (!DEMO_UPDATE_LATEST) {
    if (info && info.seen && !semverGt(latest, info.seen)) return '';              // dismissed / already applied
    // stop nagging about a version we can't re-fetch: base staleness on the last SUCCESSFUL check
    // (falling back to checkedAt for old caches), so a failing daily check can't keep it fresh forever.
    const stale = info && (info.lastSuccessAt != null ? info.lastSuccessAt : info.checkedAt);
    if (stale != null && (Date.now() - stale) > 30 * 86400 * 1000) return '';
  }
  return cBold(K.update, '⬆ v' + latest) + c(K.dim, ' update');
}
// once-a-day, spawn the detached background check; never blocks the render. Takes the
// cache already read this render (no second read on the hot path).
function maybeCheckUpdate(info) {
  if (CONFIG.updateCheck === false || updateNotifierOff() || !actAllowed()) return false;
  const day = 24 * 3600 * 1000;
  if (info && info.checkedAt && (Date.now() - info.checkedAt) < day) return false; // throttled
  // stamp the attempt NOW (atomically) so a blocked network can't respawn a checker every render.
  // If the stamp can't persist (unwritable CFG), do NOT spawn — else every ~2s render would launch a
  // network-touching child (a C2 violation + a process leak). Fail closed on the throttle.
  if (!writeJsonAtomic(updateCacheFile(), Object.assign({ current: VERSION }, info || {}, { checkedAt: Date.now() }))) return false;
  // NODE_USE_SYSTEM_CA lets the child trust a corporate root CA (no-op on older Node)
  spawnDetached(process.execPath, [__filename, '--check-update'], { env: Object.assign({}, process.env, { NODE_USE_SYSTEM_CA: '1' }) });
  return true;
}

// fetch text from an http(s) URL OR, when CCBSL_UPDATE_BASE points at a local path
// (tests / air-gapped mirrors), read it straight from disk. Best-effort; never throws.
function fetchText(url, cb) {
  if (!/^https?:\/\//i.test(url)) { fs.readFile(url, 'utf8', (e, d) => cb(e, d)); return; }
  httpGetText(url, 0, cb);
}
function noProxy(host) {
  const np = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((s) => s.trim()).filter(Boolean);
  return np.some((raw) => {
    const p = raw.startsWith('*.') ? raw.slice(1) : raw;   // curl/Go-style *.example.com -> .example.com
    return p === '*' || host === p || (p.startsWith('.') && host.endsWith(p)) || host.endsWith('.' + p);
  });
}
function httpGetText(url, depth, cb) {
  if (depth > 5) return cb(new Error('too many redirects'));
  let u;
  try { u = new URL(url); } catch (e) { return cb(e); }
  const isHttps = u.protocol === 'https:';
  const proxy = isHttps ? (process.env.HTTPS_PROXY || process.env.https_proxy) : (process.env.HTTP_PROXY || process.env.http_proxy);
  const headers = { 'User-Agent': 'ccbsl/' + VERSION, Accept: 'text/plain, */*' };
  const onRes = (res) => {
    // once-guard: res.destroy() (used for the size cap) suppresses 'end', so deliver the
    // result/error exactly once from whichever handler fires first.
    let settled = false;
    const finish = (err, data) => { if (settled) return; settled = true; cb(err, data); };
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      let nextU; try { nextU = new URL(res.headers.location, url); } catch { return finish(new Error('bad redirect')); }
      // the network layer refuses, not mangles: only http(s), and never an https->http downgrade
      if (!/^https?:$/.test(nextU.protocol)) return finish(new Error('unsupported redirect scheme: ' + nextU.protocol));
      if (isHttps && nextU.protocol === 'http:') return finish(new Error('refusing an https->http downgrade redirect'));
      return httpGetText(nextU.toString(), depth + 1, finish);
    }
    if (res.statusCode !== 200) { res.resume(); return finish(new Error('HTTP ' + res.statusCode)); }
    let d = '';
    res.setEncoding('utf8');
    res.on('data', (x) => { d += x; if (d.length > 6 * 1024 * 1024) { res.destroy(); finish(new Error('response too large')); } });
    res.on('end', () => finish(null, d));
    res.on('error', finish);
  };
  try {
    if (proxy && !noProxy(u.hostname)) return httpViaProxy(u, proxy, isHttps, headers, onRes, cb);
    const mod = require(isHttps ? 'https' : 'http');
    const req = mod.get({ hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, headers, timeout: 7000 }, onRes);
    req.on('error', cb);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  } catch (e) { cb(e); }
}
// minimal zero-dep proxy support: CONNECT-tunnel for https, absolute-URI GET for http
function httpViaProxy(u, proxy, isHttps, headers, onRes, cb) {
  let p;
  try { p = new URL(proxy); } catch (e) { return cb(e); }
  const auth = p.username ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(decodeURIComponent(p.username) + ':' + decodeURIComponent(p.password || '')).toString('base64') } : {};
  const proxyPort = p.port || (p.protocol === 'https:' ? 443 : 80);
  if (!isHttps) {
    const http = require('http');
    const req = http.get({ hostname: p.hostname, port: proxyPort, path: u.toString(), headers: Object.assign({ Host: u.host }, headers, auth), timeout: 7000 }, onRes);
    req.on('error', cb); req.on('timeout', () => req.destroy(new Error('timeout')));
    return;
  }
  const net = require('net'), tls = require('tls');
  const sock = net.connect(proxyPort, p.hostname);
  let done = false; const fail = (e) => { if (!done) { done = true; try { sock.destroy(); } catch {} cb(e); } };
  sock.setTimeout(7000, () => fail(new Error('proxy timeout')));
  sock.on('error', fail);
  sock.on('connect', () => {
    sock.write('CONNECT ' + u.hostname + ':' + (u.port || 443) + ' HTTP/1.1\r\nHost: ' + u.hostname + ':' + (u.port || 443) + '\r\n' +
      (auth['Proxy-Authorization'] ? 'Proxy-Authorization: ' + auth['Proxy-Authorization'] + '\r\n' : '') + 'Connection: keep-alive\r\n\r\n');
  });
  let head = '';
  const onData = (chunk) => {
    head += chunk.toString('binary');
    const i = head.indexOf('\r\n\r\n');
    if (i < 0) return;
    sock.removeListener('data', onData);
    if (!/^HTTP\/\d\.\d 200/.test(head)) return fail(new Error('proxy CONNECT ' + head.slice(0, head.indexOf('\r\n'))));
    // any bytes the proxy already sent past the header terminator belong to the origin's
    // TLS handshake — put them back so tls.connect doesn't lose the ServerHello.
    const leftover = Buffer.from(head.slice(i + 4), 'binary');
    if (leftover.length) { try { sock.unshift(leftover); } catch {} }
    const tlsSock = tls.connect({ socket: sock, servername: u.hostname }, () => {
      const https = require('https');
      const req = https.request({ createConnection: () => tlsSock, hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 7000 }, (res) => { done = true; onRes(res); });
      req.on('error', fail);
      req.on('timeout', () => req.destroy(new Error('timeout'))); // no timeout handler = a mid-body stall hangs forever
      req.end();
    });
    tlsSock.on('error', fail);
  };
  sock.on('data', onData);
}

// pull the VERSION constant out of a fetched statusline.js
function parseRemoteVersion(js) { const m = /const VERSION\s*=\s*'(\d+\.\d+\.\d+)'/.exec(js || ''); return m ? m[1] : null; } // strict x.y.z: a 4-part or suffixed value -> null (the loud "no VERSION marker" refusal)
// pull the newest released section (heading + bullets) out of a fetched CHANGELOG.md
function parseChangelogTop(md) {
  if (!md) return '';
  const lines = md.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) { if (/^##\s+\[?\d+\.\d+\.\d+/.test(lines[i])) { start = i; break; } }
  if (start < 0) return '';
  const out = [lines[start].replace(/^##\s+/, '').trim()];
  for (let i = start + 1; i < lines.length && out.length < 24; i++) { if (/^##\s+/.test(lines[i])) break; if (lines[i].trim()) out.push(lines[i]); }
  return out.join('\n');
}
// --check-update: fetch the remote version (+ changelog notes) and cache it. Runs both
// as the detached background checker (stdout ignored) and as a manual command.
function runCheckUpdate() {
  fetchText(UPDATE_SCRIPT_URL, (err, js) => {
    const latest = err ? null : parseRemoteVersion(js);
    const prev = readUpdateInfo() || {};
    const finish = (notes) => {
      writeJsonAtomic(updateCacheFile(), { current: VERSION, latest: latest || prev.latest || null, notes: notes || prev.notes || '', seen: prev.seen || null, checkedAt: Date.now(), lastSuccessAt: latest ? Date.now() : (prev.lastSuccessAt || null), source: UPDATE_BASE });
      if (!latest) process.stdout.write('Could not check for updates (you may be offline, blocked, or behind a proxy). Your saved version info is unchanged.\n');
      else if (semverGt(latest, VERSION)) process.stdout.write('A newer version is ready: v' + latest + ' (you have v' + VERSION + ').\n' + (isNpmInstall() ? 'To get it, run:  npm install -g ccrig@latest\n' : 'To get it, run:  node "' + __filename + '" --update\n'));
      else process.stdout.write('You are on the latest version (v' + VERSION + ').\n');
      process.exit(0);
    };
    if (latest && semverGt(latest, VERSION)) fetchText(UPDATE_CHANGELOG_URL, (e2, md) => finish(parseChangelogTop(md)));
    else finish('');
  });
}
// only treat __dirname as a git clone to `git pull` when it's genuinely OUR repo:
// the script is a tracked file AND a remote points at this project. Otherwise a bare
// .git (a dotfiles repo, a parent-dir clone) would get pulled — data loss / wrong repo.
function isOurGitClone() {
  const { execFileSync } = require('child_process');
  const g = (args) => execFileSync('git', ['-C', __dirname].concat(args), { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    g(['rev-parse', '--is-inside-work-tree']);
    g(['ls-files', '--error-unmatch', path.basename(__filename)]);         // our script is version-controlled here
    return /[\/:](ccrig|claude-code-(better-)?status-line)(\.git)?(\s|$)/m.test(g(['remote', '-v'])); // remote is THIS project (path-segment anchored, not a bare substring)
  } catch { return false; }
}
// --update: pull the newest version. our git clone -> git pull; standalone copy -> download,
// validate (node --check + shape), back up, atomic swap, then print what changed.
// an npm-installed copy lives under node_modules; its updates are npm's job, not ours
function isNpmInstall() { return /[\\/]node_modules[\\/]/.test(__dirname); }
function runUpdate() {
  const force = argv.includes('--force');
  if (isNpmInstall()) {
    process.stdout.write('installed via npm; update with:  npm install -g ccrig@latest\n(the built-in --update download path is for the standalone / curl install.)\n');
    process.exit(0);
  }
  if (isOurGitClone()) {
    // the pinned-key signature gate only applies to the download path; git integrity here
    // rests on the remote + transport, so be honest that the key is not enforced on a pull.
    if (updatePubkey()) process.stdout.write('note: updatePubkey is set but this is a git clone. `git pull` integrity rests on your git remote, not the .sig signature. For signature-enforced updates, install as a standalone copy.\n');
    try {
      const { execFileSync } = require('child_process');
      const out = execFileSync('git', ['-C', __dirname, 'pull', '--ff-only'], { encoding: 'utf8', timeout: 60000 });
      process.stdout.write(out.trim() + '\nPulled the latest into ' + __dirname + '. Restart Claude Code if hooks changed.\n');
      process.exit(0);
    } catch (e) { process.stdout.write('git pull failed: ' + ((e.stderr || e.message || e) + '').trim() + '\nResolve it by hand in ' + __dirname + '\n'); process.exit(1); }
  }
  fetchText(UPDATE_SCRIPT_URL, (err, js) => {
    if (err || !js) { process.stdout.write('The download did not finish: ' + (err ? err.message : 'empty response') + '\nYour file was left unchanged.\n'); process.exit(1); }
    const latest = parseRemoteVersion(js);
    // trust gates before we ever overwrite: it must parse as our script and be a sane size
    if (!latest) { process.stdout.write('Update skipped: the downloaded file has no version marker, so it is not the real script (it may be a proxy error page). Your file was left unchanged.\n'); process.exit(1); }
    if (js.length < 10000 || !/ccrig|claude-code-better-status-line/.test(js)) { process.stdout.write('Update skipped: the downloaded file does not look like statusline.js, so it was left alone. Your file was left unchanged.\n'); process.exit(1); }
    if (latest === VERSION && !force) { process.stdout.write('You are already on v' + VERSION + ', so there is nothing to apply. To reinstall this same version and repair a changed copy, run --update --force.\n'); process.exit(0); }
    if (!semverGt(latest, VERSION) && !force) { process.stdout.write('The available version (v' + latest + ') is not newer than yours (v' + VERSION + '), so nothing was applied. To install it anyway, run --update --force.\n'); process.exit(0); }
    // keep a .js extension so `node --check` parses it as CommonJS (top-level return is legal there)
    const tmp = __filename + '.download-' + process.pid + '.js';
    try {
      const { execFileSync } = require('child_process');
      fs.writeFileSync(tmp, js);
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'ignore', timeout: 20000 }); // syntax-validate (no shell: install path is never interpolated)
    } catch (e) { try { fs.unlinkSync(tmp); } catch {} process.stdout.write('Update skipped: the downloaded file did not pass a syntax check (' + (e.message || e) + '). Your file was left unchanged.\n'); process.exit(1); }
    // supply-chain gate: if a signing key is pinned, the download must carry a valid signature
    verifyUpdate(js, (verr, method) => {
      if (verr) { try { fs.unlinkSync(tmp); } catch {} process.stdout.write('Update skipped: ' + verr.message + '\nYour file was left unchanged.\n'); process.exit(1); }
      const bak = __filename + '.bak-v' + VERSION;
      try { fs.copyFileSync(__filename, bak); fs.renameSync(tmp, __filename); } // backup, then atomic same-dir swap
      catch (e) { try { fs.unlinkSync(tmp); } catch {} process.stdout.write('update failed while writing (' + (e.message || e) + '); your file is unchanged (backup at ' + bak + ').\n'); process.exit(1); }
      // prune old backups: keep the two most recent .bak-v* only
      try {
        const dir = path.dirname(__filename), pre = path.basename(__filename) + '.bak-v';
        const baks = fs.readdirSync(dir).filter((f) => f.startsWith(pre)).map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
        for (const old of baks.slice(2)) { try { fs.unlinkSync(path.join(dir, old.f)); } catch {} }
      } catch {}
      fetchText(UPDATE_CHANGELOG_URL, (e2, md) => {
        writeJsonAtomic(updateCacheFile(), { current: latest, latest, notes: '', seen: latest, checkedAt: Date.now(), source: UPDATE_BASE });
        process.stdout.write('Updated v' + VERSION + ' to v' + latest + '.  (Verified with ' + method + '; a backup is at ' + bak + '.)\n');
        const notes = parseChangelogTop(md);
        if (notes) process.stdout.write('\nWhat changed:\n' + notes + '\n');
        process.stdout.write('\nRestart Claude Code once so any updated hooks load.\n');
        process.exit(0);
      });
    });
  });
}
function updatePubkey() { return (typeof CONFIG.updatePubkey === 'string' && CONFIG.updatePubkey.trim()) || UPDATE_PUBKEY || ''; }
// verify a downloaded update: if a public key is pinned, require a matching Ed25519
// signature (statusline.js.sig, base64) using zero-dep node:crypto. Else TLS-only.
function verifyUpdate(js, cb) {
  const pk = updatePubkey();
  if (!pk) return cb(null, 'HTTPS/TLS + validation (unsigned; pin updatePubkey to require signatures)');
  fetchText(UPDATE_SCRIPT_URL + '.sig', (err, sigB64) => {
    if (err || !sigB64) return cb(new Error('a signing key is pinned but no valid statusline.js.sig was found'));
    try {
      const ok = require('crypto').verify(null, Buffer.from(js, 'utf8'), pk, Buffer.from(sigB64.trim(), 'base64'));
      return ok ? cb(null, 'Ed25519 signature verified') : cb(new Error('the signature did NOT verify against the pinned key'));
    } catch (e) { return cb(new Error('signature check failed: ' + (e.message || e))); }
  });
}
// --whatsnew: print the newest changelog section for the INSTALLED version
function runWhatsnew() {
  let md = ''; try { md = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8'); } catch {}
  const notes = parseChangelogTop(md) || (readUpdateInfo() || {}).notes || '';
  process.stdout.write('CCRig v' + VERSION + '\n\n' + (notes || '(no CHANGELOG.md next to the script)') + '\n');
  process.exit(0);
}

// --dismiss-update: silence the ⬆ badge for the currently-cached version (it returns for the next one).
// The only other writer of `seen` is a successful --update; this lets a user skip a version they don't want.
function runDismissUpdate() {
  const info = readUpdateInfo();
  if (!info || !info.latest || !semverGt(info.latest, VERSION)) { process.stdout.write('nothing to dismiss (no newer version is cached).\n'); process.exit(0); }
  writeJsonAtomic(updateCacheFile(), Object.assign({}, info, { seen: info.latest }));
  process.stdout.write('dismissed the update badge for v' + info.latest + ' (it returns when a newer version appears).\n');
  process.exit(0);
}

// context %: prefer Claude Code's own number, fall back to the transcript tail
function contextPct(input) {
  const cw = input.context_window;
  if (cw && typeof cw.used_percentage === 'number') return Math.min(100, Math.max(0, Math.round(cw.used_percentage)));
  const tp = input.transcript_path;
  if (!tp) return null;
  try {
    const fd = fs.openSync(tp, 'r');
    const size = fs.fstatSync(fd).size;
    const span = Math.min(size, 262144);
    const buf = Buffer.alloc(span);
    fs.readSync(fd, buf, 0, span, size - span);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      const u = o && o.message && o.message.usage;
      if (u && (u.input_tokens != null || u.cache_read_input_tokens != null)) {
        const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        const idHint = ((input.model && input.model.id) || '') + ' ' + (settingsVal('model') || '');
        const limit = /\[?1m\]?/i.test(idHint) ? 1000000 : 200000;
        return Math.min(100, Math.round((used / limit) * 100));
      }
    }
  } catch {}
  return null;
}

// live effort: stdin.effort.level (object) → fall back to settings
function effortLevel(input) {
  const e = input.effort;
  if (e && typeof e === 'object' && e.level) return String(e.level);
  if (typeof e === 'string' && e) return e;
  return settingsVal('effortLevel') || '';
}

// caveman plugin badge: preserved so this composes with existing tooling
function cavemanBadge() {
  const flag = path.join(CFG, '.caveman-active');
  try { if (fs.lstatSync(flag).isSymbolicLink()) return ''; } catch { return ''; }
  let mode = readFileSafe(flag).slice(0, 64).replace(/[\r\n]/g, '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  const ok = ['off', 'lite', 'full', 'ultra', 'wenyan-lite', 'wenyan', 'wenyan-full', 'wenyan-ultra', 'commit', 'review', 'compress'];
  if (!ok.includes(mode) || mode === 'off') return '';
  let badge = (mode === 'full') ? '[CAVEMAN]' : `[CAVEMAN:${mode.toUpperCase()}]`;
  const sfile = path.join(CFG, '.caveman-statusline-suffix');
  try {
    if (fs.existsSync(sfile) && !fs.lstatSync(sfile).isSymbolicLink()) {
      const sfx = readFileSafe(sfile).slice(0, 64).replace(/[\x00-\x1f]/g, '');
      if (sfx) badge += ' ' + sfx;
    }
  } catch {}
  return c(K.caveman, badge);
}

// dirs that MATCH the ~/.claude-* profile shape but are OUR OWN state, never profiles.
const NON_PROFILE_DIRS = new Set(['.claude-usage-ledger', '.claude-rig-sessions']);
// Every Claude profile config dir on this machine. A "profile" is an isolated
// CLAUDE_CONFIG_DIR; by convention they live at ~/.claude (default) and ~/.claude-<name>.
// The active CFG is always included (it may be a custom path outside HOME, and it's the
// one the user is explicitly targeting) and created if missing; every other ~/.claude*
// dir is included only if it already exists. This is what lets ONE --install cover a
// heavy user's work + personal profiles instead of silently wiring only the active one.
// a dir that already looks like a Claude profile (a real marker) — not a foreign ~/.claude-* tool dir
function hasClaudeMarker(dir) {
  return fs.existsSync(path.join(dir, 'settings.json')) || fs.existsSync(path.join(dir, '.credentials.json')) || fs.existsSync(path.join(dir, 'projects'));
}
function detectProfiles() {
  const seen = new Set();
  const out = [];
  const add = (d) => { if (d && !seen.has(d)) { seen.add(d); out.push(d); } };
  add(CFG); // the explicit target: always, even if it doesn't exist yet
  try {
    for (const e of fs.readdirSync(HOME).sort()) {
      if (NON_PROFILE_DIRS.has(e)) continue;
      if (e === '.claude' || e.startsWith('.claude-')) {
        const p = path.join(HOME, e);
        // require a Claude marker for NON-active dirs, so --install never writes settings.json into a
        // foreign ~/.claude-* tool dir (claude-code-router, claude-flow, backup dirs, ...).
        try { if (p === CFG || (fs.statSync(p).isDirectory() && hasClaudeMarker(p))) add(p); } catch {}
      }
    }
  } catch {}
  return out;
}
// ~/.claude-* dirs that look like a profile by name but lack any marker (skipped by --install);
// surfaced as a note so a real-but-empty profile can still be wired explicitly with --this-profile.
function markerlessClaudeDirs() {
  const out = [];
  try {
    for (const e of fs.readdirSync(HOME).sort()) {
      if (NON_PROFILE_DIRS.has(e) || !(e === '.claude' || e.startsWith('.claude-'))) continue;
      const p = path.join(HOME, e);
      if (p === CFG) continue;
      try { if (fs.statSync(p).isDirectory() && !hasClaudeMarker(p)) out.push(p); } catch {}
    }
  } catch {}
  return out;
}
// a short human label for a profile dir: ~/.claude -> "default", ~/.claude-personal -> "personal"
function profileLabel(dir) {
  const b = path.basename(dir);
  return b === '.claude' ? 'default' : (b.replace(/^\.claude-/, '') || b);
}
// how many Claude profiles exist on this machine (for the auto-hide profile badge)
function claudeProfileCount() {
  try { return detectProfiles().length; } catch { return 1; }
}

// active Claude profile badge: generic for anyone. In 'auto' it stays hidden for
// single-profile users; labels derive from the dir name unless mapped in config.
function profileSeg() {
  const mode = CONFIG.show.profile;
  if (mode === false) return '';
  const base = path.basename(CFG);
  if (mode === 'auto' && base === '.claude' && claudeProfileCount() < 2) return '';
  const label = (CONFIG.profileLabels && CONFIG.profileLabels[base]) || base.replace(/^\.?claude-?/, '') || 'default';
  const col = base === '.claude' ? K.profileDefault : (base === '.claude-personal' ? K.profilePersonal : K.sky);
  return c(col, '👤 ' + label);
}

// billing path: `rate_limits` is sent ONLY to Claude.ai subscribers (Pro/Max);
// an API key means pay-per-token. Unknown (e.g. before the first response) → hide.
function billingSeg(input) {
  const rl = input.rate_limits || {};
  const hasSub = (rl.five_hour && typeof rl.five_hour.used_percentage === 'number') ||
                 (rl.seven_day && typeof rl.seven_day.used_percentage === 'number');
  if (hasSub) return c(K.green, '💳 sub');
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return c(K.yellow, '💳 api');
  return '';
}

// git: branch + uncommitted + ahead/behind in ONE call (porcelain v2 + --branch),
// cached briefly so a large repo doesn't re-shell on every render (official pattern).
function strHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }
function gitProbe(cwd) {
  let out;
  try {
    out = execSync('git --no-optional-locks status --porcelain=v2 --branch', { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 700, encoding: 'utf8' });
  } catch { return null; }
  let branch = '', ahead = 0, behind = 0, dirty = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice(14).trim();
    else if (line.startsWith('# branch.ab ')) {
      const ab = line.slice(12).trim().split(/\s+/);
      ahead = Math.abs(parseInt(ab[0], 10)) || 0;
      behind = Math.abs(parseInt(ab[1], 10)) || 0;
    } else if (line && !line.startsWith('#')) dirty++;
  }
  if (!branch) return null;
  if (branch === '(detached)') branch = 'detached';
  return { branch, ahead, behind, dirty };
}
function gitSeg(cwd) {
  const ttl = CONFIG.gitCacheMs || 0;
  const cacheFile = path.join(os.tmpdir(), 'ccsl-git-' + strHash(cwd) + '.json');
  let data;
  if (ttl > 0) {
    try { if (Date.now() - fs.statSync(cacheFile).mtimeMs < ttl) data = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
  }
  if (data === undefined) {
    data = gitProbe(cwd);
    if (ttl > 0) { try { fs.writeFileSync(cacheFile, JSON.stringify(data)); } catch {} }
  }
  if (!data || !data.branch) return '';
  const parts = [c(K.green, data.branch)];
  if (data.dirty > 0) parts.push(c(K.yellow, '●' + data.dirty));
  if (data.ahead > 0) parts.push(c(K.yellow, '↑' + data.ahead));
  if (data.behind > 0) parts.push(c(K.sky, '↓' + data.behind));
  return `\u{1F33F} ${parts.join(' ')}`;
}

// ===========================================================================
// build the ordered segment list from one input object
//   `gitOverride` lets --demo / --config / --selftest inject a git string
// ===========================================================================
function collectSegments(input, width, gitOverride) {
  const S = CONFIG.show;
  const out = {};

  out.profile = profileSeg();
  const updateInfo = (CONFIG.updateCheck === false || updateNotifierOff()) ? null : readUpdateInfo(); // read the cache once
  out.update = updateSeg(updateInfo);

  const cwd = (input.workspace && input.workspace.current_dir) || input.cwd || process.cwd();
  const projectDir = (input.workspace && input.workspace.project_dir) || cwd;
  let folder = path.basename(projectDir || cwd);
  // true-ancestor only: cwd must continue with a path separator, so /foo isn't treated as a parent of /foobar
  if (cwd && projectDir && cwd !== projectDir && cwd.startsWith(projectDir) && (cwd[projectDir.length] === '/' || cwd[projectDir.length] === '\\')) folder += cwd.slice(projectDir.length);
  out.folder = `\u{1F4C2} ${c(K.folder, truncFolder(folder, width - 4))}`;

  // String-coerce at the source: a hostile non-string display_name/id (e.g. 123) must not reach .replace()
  let model = String((input.model && input.model.display_name) || (input.model && input.model.id) || 'Claude');
  model = model.replace(/\s*\(1M context\)/i, '').trim();
  const oneM = /\[?1m\]?/i.test(((input.model && input.model.id) || '') + ' ' + (settingsVal('model') || ''));
  out.model = `${c(K.dim, '★')} ${c(K.model, model)}${oneM ? c(K.dim, ' [1m]') : ''}`;
  out.downgrade = downgradeSeg(input, gitOverride === undefined);

  const effort = effortLevel(input);
  out.effort = effort ? c(K.effort, '⚡' + effort) : '';

  const flags = [];
  if (input.fast_mode) flags.push(c(K.flag, 'fast'));
  if (input.thinking && input.thinking.enabled === false) flags.push(c(K.yellow, 'no-think'));
  out.flags = flags.join(' ');

  const ctx = contextPct(input);
  out.context = ctx != null ? `${c(K.dim, 'ctx')} ${bar(ctx, 10, CONFIG.thresholds.context)} ${c(K.dim, ctx + '%')}` : '';

  out.git = gitOverride != null ? gitOverride : gitSeg(cwd);
  out.agents = agentsSeg(input);
  out.caveman = cavemanBadge();
  out.billing = billingSeg(input);

  const rl = input.rate_limits || {};
  const pctOf = (o) => (o && typeof o.used_percentage === 'number') ? o.used_percentage : null;
  const resetOf = (o) => (o && typeof o.resets_at === 'number') ? o.resets_at : null;
  const sPct = pctOf(rl.five_hour), wPct = pctOf(rl.seven_day);
  const sReset = resetOf(rl.five_hour), wReset = resetOf(rl.seven_day);
  // side effects only on the LIVE render (Claude Code's stdin), never in --demo / --config / --selftest
  const live = gitOverride === undefined;
  if (live) {
    maybeCheckUpdate(updateInfo);                  // once/day background version check (never blocks)
    writeBoard(input, sPct, sReset, wPct, wReset, ctx, inflightAgents(input.transcript_path).length); // attention board (opt-in)
    if (sPct != null || wPct != null) {
      recordSample(input.session_id, sPct, wPct);   // Feature 3: build the burn-rate history
      writeLedger(input, sPct, sReset, wPct, wReset); // Feature 4: publish this profile's usage
    }
  }
  out.session = sPct != null ? usageSeg('session', sPct, sReset) : '';
  out.weekly = wPct != null ? usageSeg('weekly', wPct, wReset) : '';
  out.forecast = forecastSeg(input.session_id, sPct, sReset, wPct, wReset);
  out.resumeHint = resumeHintSeg(input, sPct, wPct, sReset, wReset, live);

  const cost = input.cost;
  if (cost && typeof cost.total_cost_usd === 'number') {
    let s = c(K.dim, '$' + cost.total_cost_usd.toFixed(2));
    if (cost.total_lines_added || cost.total_lines_removed) {
      s += ' ' + c(K.green, '+' + (cost.total_lines_added || 0)) + c(K.dim, '/') + c(K.red, '-' + (cost.total_lines_removed || 0));
    }
    out.cost = s;
  } else out.cost = '';

  const name = typeof input.session_name === 'string' ? input.session_name : '';
  out.sessionName = name ? c(K.dim, name.length > 28 ? name.slice(0, 27) + '…' : name) : '';

  const order = Array.isArray(CONFIG.order) ? CONFIG.order : DEFAULT_ORDER;
  const mode = CONFIG.mode || 'normal';
  return order.filter((n) => {
    if (!out[n]) return false;                              // no content -> never show
    if (mode === 'minimal') return MINIMAL_KEEP.includes(n); // quiet: essentials only (+ the ⚠ hint)
    if (mode === 'expanded') return true;                    // everything with content, incl. cost + name
    return S[n];                                             // normal: honor the per-segment show flags
  }).map((n) => out[n]);
}

function render(input, width, gitOverride) {
  return wrapSegments(collectSegments(input, width, gitOverride), width);
}

// representative sample input for --demo / --config preview
function demoInput() {
  const now = Math.floor(Date.now() / 1000);
  return {
    session_id: 'ccbsl-demo',
    workspace: { current_dir: '/Users/you/Desktop/my-project', project_dir: '/Users/you/Desktop/my-project' },
    model: { id: 'claude-opus-4-8[1m]', display_name: 'Opus 4.8 (1M context)' },
    effort: { level: 'high' },
    context_window: { used_percentage: 42 },
    fast_mode: true, thinking: { enabled: false },
    session_name: 'Refactor the billing service',
    cost: { total_cost_usd: 2.17, total_lines_added: 214, total_lines_removed: 38 },
    rate_limits: {
      five_hour: { used_percentage: 63, resets_at: now + 2 * 3600 },
      seven_day: { used_percentage: 93, resets_at: now + 5 * 86400 }, // crosses warn(90): demos the ⚠ + resumeHint
    },
  };
}
const DEMO_GIT = () => `\u{1F33F} ${c(K.green, 'main')} ${c(K.yellow, '●3')} ${c(K.yellow, '↑1')}`;

// ===========================================================================
// CLI modes (manual only: Claude Code passes JSON on stdin with no args)
// ===========================================================================
const argv = process.argv.slice(2);

// When required as a module (unit tests), export the pure helpers and DON'T run the CLI
// or touch stdin. Direct execution (`node statusline.js`) runs normally below.
if (require.main !== module) {
  module.exports = {
    semverGt, modelTier, parseRemoteVersion, parseChangelogTop, inflightAgents,
    computeInflightAgents, latestTodos, latestUserText, dispWidth, glyphWidth, deepMerge,
    truncFolder, fmtReset, resumePromptFromCheckpoint, wrapSegments, bar,
    fetchText, httpGetText, VERSION,
    DEFAULTS, DEFAULT_ORDER, MODES, helpText, watcherCmdMatches, notifySpec, maybeCheckUpdate,
  };
  return;
}

// Subcommand aliases: `ccrig init` behaves like `ccrig --install`, and a few other verbs map to
// their flag, so the modern `ccrig <command>` form works alongside the `--flag` form.
const SUBCOMMANDS = {
  init: '--install', install: '--install', uninstall: '--uninstall', doctor: '--doctor',
  update: '--update', preview: '--demo', demo: '--demo', sessions: '--sessions',
  board: '--board', config: '--config', help: '--help', version: '--version',
};
if (argv[0] && !argv[0].startsWith('-') && Object.prototype.hasOwnProperty.call(SUBCOMMANDS, argv[0])) {
  argv[0] = SUBCOMMANDS[argv[0]];
}

function helpText() {
  return [
    'CCRig v' + VERSION,
    'Claude Code runs this for you automatically. You can also run these by hand',
    '(as `ccrig <command>`, for example `ccrig init`, or by the flag names below):',
    '  --install            wire Claude Code to this file, for ALL your profiles (backs up settings.json first)',
    '  --install-guardian   also wire the guardian: keep-working + auto-resume at limits (all profiles)',
    '  --auto               with --install-guardian: hands-free relaunch (autopilot resume)',
    '  --uninstall          remove the status line + any guardian hooks (all profiles)',
    '  --uninstall-guardian remove only the guardian hooks; keep the status line (all profiles)',
    '  --this-profile       with any install/uninstall command: scope it to the active profile only',
    '  --doctor             diagnose a broken or missing status line + guardian',
    '  --mode <m>           set display density: minimal | normal | expanded',
    '  --autopilot <m>      limit behaviour: off | notify | resume',
    '  --keep-working <b>   keep working while todos remain: on | off',
    '  --board              show every live session across your worktrees/profiles (opt-in)',
    '  --sessions           list recent sessions with the command to resume each',
    '  --status             list armed auto-resume watchers (nothing is a hidden daemon)',
    '  --disarm [id]        stop auto-resume watcher(s) and clear their state',
    '  --purge              delete all local guardian state (checkpoints, tickets, cache)',
    '  --update             update in place (npm installs: npm install -g ccrig@latest; else git pull or download)',
    '  --force              with --update: apply even when the remote is not newer (repair)',
    '  --check-update       check now whether a newer version is available',
    '  --whatsnew           print the newest changelog section',
    '  --dismiss-update     silence the update badge for the current newest version',
    '  --options            print every current setting and its choices',
    '  --config             interactive editor (segments, mode, live preview, save)',
    '  --demo [--cols N]     preview with sample data',
    '  --selftest           run edge-case render checks',
    '  --version            print the version',
    '  --help               this text',
    '',
    'Config lives in statusline.config.json next to this file',
    '(see statusline.config.example.json). Updating the script never wipes it.',
    '',
  ].join('\n');
}
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(helpText());
  process.exit(0);
}

if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write('CCRig v' + VERSION + '\n');
  process.exit(0);
}

// ===========================================================================
// GUARDIAN runtime: hook dispatcher (--hook) + the auto-resume watcher (--watch).
// Claude Code invokes --hook with the hook JSON on stdin; the installer wires it.
// ===========================================================================
function emitHook(obj) {
  try { if (obj && Object.keys(obj).length) process.stdout.write(JSON.stringify(obj)); } catch {}
  process.exit(0);
}
function guardVal(sid, tag) {
  const f = path.join(guardDir(), sid + '.' + tag);
  return {
    get: () => { try { return parseInt(fs.readFileSync(f, 'utf8'), 10) || 0; } catch { return 0; } },
    set: (n) => { try { fs.mkdirSync(guardDir(), { recursive: true }); fs.writeFileSync(f, String(n)); return true; } catch { return false; } },
  };
}
function clearGuardCounters(sid) {
  for (const tag of ['continues', 'stuck', 'lastpending']) { try { fs.unlinkSync(path.join(guardDir(), sid + '.' + tag)); } catch {} }
}
// drop everything we track for a session: checkpoint, arming markers, loop counters
function clearSessionGuardState(sid) {
  if (!sid || !SID_RE.test(sid)) return;
  try { fs.unlinkSync(checkpointPath(sid)); } catch {}
  for (const tag of ['checkpoint', 'notified', 'watch', 'continues', 'stuck', 'lastpending']) {
    try { fs.unlinkSync(path.join(guardDir(), sid + '.' + tag)); } catch {}
  }
}
// Feature 2 (Relentless mode): a Stop hook that refuses to pause while todos remain.
function runHookStop(input) {
  // an unattended auto-resume must not loop overnight: never force-continue there
  if (process.env.CCBSL_UNATTENDED) return emitHook({});
  const kw = cfgKeepWorking();
  if (!kw) return emitHook({});                                   // disabled -> allow stop
  const sid = input.session_id, tp = input.transcript_path;
  const validSid = sid && SID_RE.test(sid);
  const pending = (latestTodos(tp, true) || []).filter((x) => x && x.status !== 'completed'); // full-scan: don't miss todos past the tail
  if (!pending.length) { if (validSid) clearGuardCounters(sid); return emitHook({}); } // done -> allow
  // a trailing question or an explicit hand-off is a real human decision: never talk over it
  const last = latestAssistantText(tp);
  if (/\?\s*$/.test(last) || /\b(which would you|which one|should i|do you want|would you like|let me know|please (confirm|choose|decide|clarify|advise)|blocked:?|need (your|you to|a decision|input|clarification)|waiting for|up to you|your call|can't proceed|cannot proceed|awaiting)\b/i.test(last.slice(-320))) {
    if (validSid) clearGuardCounters(sid);                        // fresh burst starts clean after a hand-off
    return emitHook({});
  }
  if (!validSid) return emitHook({});                             // can't loop-guard safely -> don't force
  const cont = guardVal(sid, 'continues'), stuck = guardVal(sid, 'stuck'), lastN = guardVal(sid, 'lastpending');
  const n = cont.get() + 1;
  if (n > kw.maxContinues) { clearGuardCounters(sid); return emitHook({}); }   // hard cap -> allow stop
  const prev = lastN.get();
  const s = (prev && pending.length >= prev) ? stuck.get() + 1 : 0;            // pending not shrinking = stalled
  if (s >= kw.maxStuck) { clearGuardCounters(sid); return emitHook({}); }      // stalled -> allow stop
  // fail OPEN: if the counters can't be persisted, we can't bound the loop, so allow the stop.
  // (all three run, no short-circuit, so a partial write doesn't leave a half-updated state.)
  const okC = cont.set(n), okS = stuck.set(s), okL = lastN.set(pending.length);
  if (!okC || !okS || !okL) { clearGuardCounters(sid); return emitHook({}); }
  const list = pending.slice(0, 6).map((x) => '- ' + (x.content || x.activeForm)).join('\n');
  emitHook({ decision: 'block', reason:
    'Do not stop yet: ' + pending.length + ' todo(s) still open. Keep working through them:\n' + list +
    '\nIf you are genuinely blocked on a human decision, a missing secret, or a question, state that explicitly, then stop.' });
}
// Feature 1 (re-kick): on resume/compact, inject the checkpoint so no work repeats.
// Also (opt-in) re-inject a rules file after a compaction, in case compaction dropped it.
function runHookSessionStart(input) {
  const sid = input.session_id, source = input.source || '';
  if (source && source !== 'resume' && source !== 'compact') return emitHook({}); // startup/clear = fresh
  const parts = [];
  // rules re-injection after compaction (opt-in via reinjectOnCompact)
  if (source === 'compact' && CONFIG.reinjectOnCompact) {
    const rel = CONFIG.reinjectOnCompact === true ? 'CLAUDE.md' : String(CONFIG.reinjectOnCompact);
    const file = path.isAbsolute(rel) ? rel : path.join(inputCwd(input), rel);
    try { const txt = fs.readFileSync(file, 'utf8').slice(0, 8000); if (txt.trim()) parts.push('Your context was just compacted. Re-including your project rules (' + rel + ') so they are not lost:\n\n' + txt); } catch {}
  }
  // checkpoint restore (limit resume / compact)
  if (sid && SID_RE.test(sid)) {
    const cp = readCheckpoint(sid);
    if (cp) {
      // a HUMAN resume supersedes any armed watcher for this session — stop it so it can't
      // also relaunch later. (Not when we ARE the watcher's own relaunch: CCBSL_UNATTENDED.)
      if (!process.env.CCBSL_UNATTENDED) {
        try { const pid = parseInt(fs.readFileSync(watchPidFile(sid), 'utf8'), 10) || 0; if (isOurWatcher(pid, sid)) process.kill(pid); } catch {}
      }
      parts.push(resumePromptFromCheckpoint(cp, false, !!process.env.CCBSL_UNATTENDED)); // attended unless the watcher relaunched us
      clearSessionGuardState(sid); // consume once + re-arm cleanly for a later limit
    }
  }
  if (!parts.length) return emitHook({});
  emitHook({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n---\n\n') } });
}
// Feature 5 (compaction-proof): snapshot work state before Claude Code compacts context.
function runHookPreCompact(input) {
  writeCheckpoint(input, { reason: 'pre-compact', window: '' });
  emitHook({});
}
function runHook(event, input) {
  try {
    if (event === 'stop' || event === 'Stop') return runHookStop(input);
    if (event === 'session-start' || event === 'SessionStart') return runHookSessionStart(input);
    if (event === 'pre-compact' || event === 'PreCompact') return runHookPreCompact(input);
  } catch {}
  emitHook({}); // unknown or error -> never block Claude Code
}

// Feature 1 (scheduler): the detached, sleep-safe watcher. Waits out the reset by
// polling wall-clock (survives laptop suspend + week-long waits), then relaunches
// the exact session headless. Optionally fails over to a profile with headroom.
function watchLog(sid, m) {
  try { const d = path.join(guardDir(), 'logs'); fs.mkdirSync(d, { recursive: true }); fs.appendFileSync(path.join(d, sid + '.log'), new Date().toISOString() + ' ' + m + '\n'); } catch {}
}
// On Windows `claude` is a .cmd/.ps1 shim: CreateProcess cannot run it, and post-CVE Node refuses a
// .cmd without a shell, while routing our multi-line -p prompt through cmd.exe would mangle newlines
// and expand %VARS%. So resolve the shim to the node entry (cli.js) it launches and run node against
// it directly: the prompt arg is then passed verbatim, no shell in the loop. Returns null (meaning
// spawn the bin as-is) for a real .exe or when the shim can't be resolved.
function winLaunch(bin) {
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1').split(';').filter(Boolean);
  const cands = [];
  if (/[\\/]/.test(bin) || /\.[A-Za-z0-9]+$/.test(bin)) cands.push(bin);
  else for (const dir of (process.env.PATH || '').split(path.delimiter)) for (const e of [''].concat(exts)) cands.push(path.join(dir, bin + e));
  let shim = null;
  for (const c of cands) { try { if (fs.statSync(c).isFile()) { shim = c; break; } } catch {} }
  if (!shim) return null;
  if (/\.exe$/i.test(shim)) return { cmd: shim, pre: [] };        // a real executable: spawn directly
  let txt = ''; try { txt = fs.readFileSync(shim, 'utf8'); } catch {}
  const m = txt.match(/["']?([^"'\r\n]*\.js)["']?/);              // the cli.js the shim runs
  if (m) {
    let js = m[1].replace(/%~dp0\\?/gi, path.dirname(shim) + path.sep).replace(/\$basedir[\\/]*/gi, path.dirname(shim) + path.sep);
    if (!path.isAbsolute(js)) js = path.join(path.dirname(shim), js);
    try { if (fs.statSync(js).isFile()) return { cmd: process.execPath, pre: [js] }; } catch {}
  }
  return null;
}
function relaunchResume(cp, profileDir) {
  const sid = cp.session_id;
  // process-spawning safety: under CCBSL_NO_ACT (the test guard) never launch the real
  // claude, mirroring armWatcher/notify. Makes the watcher runtime testable without a relaunch.
  if (!actAllowed()) { watchLog(sid, 'CCBSL_NO_ACT: would relaunch ' + (profileDir ? 'cross-profile' : '--resume ' + sid)); process.exit(0); }
  const prompt = resumePromptFromCheckpoint(cp, !!profileDir, true); // watcher relaunch = unattended
  // CCBSL_UNATTENDED disables keep-working inside the relaunched run, so an auto-resume
  // does its reviewable steps and STOPS instead of looping unattended overnight.
  const env = Object.assign({}, process.env, { CCBSL_UNATTENDED: '1' });
  // opt-in: the relaunch is headless and cannot answer a permission prompt, so let the user allow
  // it to bypass them ("bypass permissions" mode). Off by default; the prompt still tells the model
  // to prefer reversible actions and stop before anything destructive.
  const bypass = CONFIG.autopilotBypassPermissions === true ? ['--permission-mode', 'bypassPermissions'] : [];
  let args;
  if (profileDir) {                        // cross-account: seed a fresh session (can't --resume another profile's id)
    env.CLAUDE_CONFIG_DIR = profileDir;
    args = [...bypass, '-p', prompt];
  } else {
    // resume UNDER THE OWNING PROFILE, not whatever profile the watcher happened to inherit
    if (cp.config_dir) env.CLAUDE_CONFIG_DIR = cp.config_dir;
    args = [...bypass, '--resume', sid, '-p', prompt];
  }
  let fd = 'ignore';
  try { const d = path.join(guardDir(), 'logs'); fs.mkdirSync(d, { recursive: true }); fd = fs.openSync(path.join(d, sid + '.resume.log'), 'a'); } catch {}
  try {
    const { spawn } = require('child_process');
    let cmd = claudeBin(), spawnArgs = args;
    const opts = { cwd: cp.cwd, env, stdio: ['ignore', fd, fd], windowsHide: true };
    if (process.platform === 'win32') {
      const wl = winLaunch(cmd);
      if (wl) { cmd = wl.cmd; spawnArgs = wl.pre.concat(args); }
      else { opts.shell = true; }                 // fallback: let the shell resolve the shim
    }
    const child = spawn(cmd, spawnArgs, opts);
    // consume all guard state only once the relaunch actually started, so a failed
    // spawn (e.g. claude not on PATH) leaves the checkpoint for a manual resume, and
    // a second limit in the resumed session can re-checkpoint + re-arm cleanly.
    child.on('spawn', () => clearSessionGuardState(sid));
    child.on('error', (e) => { watchLog(sid, 'spawn error: ' + e.message + ' (checkpoint kept for manual resume)'); process.exit(1); });
    child.on('exit', (code) => {
      watchLog(sid, 'resume process exited code=' + code);
      notify('Claude Code auto-resumed', (cp.session_name || sid) + ': ' + (profileDir ? 'continued on another profile' : 'resumed after the reset'));
      process.exit(0);
    });
  } catch (e) { watchLog(sid, 'relaunch failed: ' + e.message); process.exit(1); }
}
// has the transcript been written since the window reset? then the user already
// picked the session back up themselves; auto-resuming would double-run it.
function resumedManuallySince(cp) {
  if (!cp.resets_at || !cp.transcript_path) return false;
  try { return fs.statSync(cp.transcript_path).mtimeMs / 1000 > cp.resets_at + 2; } catch { return false; }
}
function watchPidFile(sid) { return path.join(guardDir(), sid + '.watch.pid'); }
function runWatch(sid) {
  if (!sid || !SID_RE.test(sid)) process.exit(1);
  let cp = readCheckpoint(sid);
  if (!cp) { watchLog(sid, 'no checkpoint; exiting'); process.exit(1); }
  // Without a known reset time we cannot schedule safely: firing on a bare timer
  // would relaunch while the window is still exhausted. Leave it to the resume ticket.
  if (!cp.resets_at) { watchLog(sid, 'no reset time in checkpoint; not auto-resuming (use the resume ticket)'); process.exit(1); }
  const bufferMs = () => (typeof CONFIG.autopilotBuffer === 'number' && CONFIG.autopilotBuffer >= 0 ? CONFIG.autopilotBuffer : 45) * 1000;
  // wall-clock poll interval, default 30s; overridable ONLY via env so the end-to-end resume test can
  // exercise the real wait-then-fire timeline in seconds instead of minutes. Not a user-facing knob.
  const pollMs = Math.max(50, parseInt(process.env.CCBSL_WATCH_INTERVAL_MS, 10) || 30000);
  let target = cp.resets_at * 1000 + bufferMs();
  // a PID file makes the watcher inspectable (--status) and killable (--disarm), not an invisible daemon
  try { fs.writeFileSync(watchPidFile(sid), String(process.pid) + '\n' + target); } catch {}
  process.on('exit', () => { try { fs.unlinkSync(watchPidFile(sid)); } catch {} });
  watchLog(sid, 'armed pid=' + process.pid + ' window=' + cp.window + ' resets_at=' + cp.resets_at + ' target=' + new Date(target).toISOString());
  // the foreground session is still active if its transcript was written in the last N seconds
  const foregroundActive = () => {
    if (!cp.transcript_path) return false;
    try { return Date.now() - fs.statSync(cp.transcript_path).mtimeMs < 120000; } catch { return false; }
  };
  const fireIfIdle = (profileDir, why) => {
    if (resumedManuallySince(cp)) { watchLog(sid, 'session already continued after the reset; standing down'); clearSessionGuardState(sid); process.exit(0); }
    watchLog(sid, why); return relaunchResume(cp, profileDir);
  };
  const tick = () => {
    try {
      // Re-read the checkpoint each tick: a refreshed schedule (a later window hitting critical) or an
      // autopilotBuffer change is honored WITHOUT re-arming; a vanished checkpoint means stand down.
      const fresh = readCheckpoint(sid);
      if (!fresh || !fresh.resets_at) { watchLog(sid, 'checkpoint gone or lost its reset; standing down'); process.exit(0); }
      cp = fresh;
      const newTarget = cp.resets_at * 1000 + bufferMs();
      if (newTarget !== target) { target = newTarget; try { fs.writeFileSync(watchPidFile(sid), String(process.pid) + '\n' + target); } catch {} watchLog(sid, 'target refreshed to ' + new Date(target).toISOString()); }
      // Failover can fire before the reset (that's the point), but NOT while you're still
      // working in the foreground session — two agents in one worktree would collide.
      if (CONFIG.autopilotFailover && !foregroundActive()) {
        const fo = pickFreshProfile(85, 6 * 3600);
        if (fo) return fireIfIdle(fo.dir, 'failover to ' + fo.profile + ' (' + Math.round(100 - fo.head) + '% free)');
      }
      if (Date.now() >= target) return fireIfIdle(null, 'reset reached; relaunching');
    } catch (e) { watchLog(sid, 'tick error: ' + e.message); }
    setTimeout(tick, pollMs);
  };
  tick();
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
// only signal a pid we can confirm is OUR watcher (its cmdline still has `--watch <sid>`),
// so a stale pid file that was reused by an unrelated process is never killed.
// pure + testable: does a process cmdline belong to a watcher for this sid?
function watcherCmdMatches(cmdline, sid) { return typeof cmdline === 'string' && cmdline.includes('--watch') && cmdline.includes(sid); }
function isOurWatcher(pid, sid) {
  if (!pid || !pidAlive(pid)) return false;
  try {
    if (process.platform === 'win32') {
      // real cmdline check (was: blindly return true). pid is Number-coerced and sid is SID_RE-validated
      // by every caller, so the Win32_Process filter string is injection-safe.
      const cmd = require('child_process').execFileSync('powershell', ['-NoProfile', '-Command',
        '(Get-CimInstance Win32_Process -Filter "ProcessId=' + Number(pid) + '").CommandLine'],
        { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      return watcherCmdMatches(cmd, sid);
    }
    const cmd = require('child_process').execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return watcherCmdMatches(cmd, sid);
  } catch { return false; }   // fail closed: never signal a process we cannot confirm is our watcher
}
// --status: list armed auto-resume watchers (nothing is a hidden daemon)
function runStatus() {
  process.stdout.write('CCRig v' + VERSION + ' guardian status\n  Profile: ' + CFG + '\n\n');
  let any = false;
  try {
    for (const f of fs.readdirSync(guardDir())) {
      if (!f.endsWith('.watch.pid')) continue;
      any = true;
      const sid = f.slice(0, -'.watch.pid'.length);
      let pid = 0, target = 0;
      try { const p = fs.readFileSync(path.join(guardDir(), f), 'utf8').split('\n'); pid = parseInt(p[0], 10) || 0; target = parseInt(p[1], 10) || 0; } catch {}
      const cp = readCheckpoint(sid) || {};
      const alive = isOurWatcher(pid, sid);   // a recycled-PID orphan must not report ARMED
      process.stdout.write('  ' + (alive ? 'Ready' : 'Inactive') + '  session ' + sid + '  process ' + pid + (alive ? '' : ' (no longer running)') +
        (target ? '  fires about ' + new Date(target).toLocaleString() : '') + (cp.window ? '  [' + cp.window + ' window]' : '') + '\n');
    }
  } catch {}
  if (!any) process.stdout.write('  No auto-resume watchers are set up right now.\n');
  process.stdout.write('\n  To stop a watcher:  node "' + __filename + '" --disarm [session-id]\n  To clear all saved state:  node "' + __filename + '" --purge\n');
  process.exit(0);
}
// --disarm [sid]: stop watcher(s) and clear their state
function runDisarm(sid) {
  process.stdout.write('CCRig v' + VERSION + ': disarm\n  profile: ' + CFG + '\n');
  const targets = [];
  try { for (const f of fs.readdirSync(guardDir())) { if (!f.endsWith('.watch.pid')) continue; const s = f.slice(0, -'.watch.pid'.length); if (!sid || s === sid) targets.push(s); } } catch {}
  let killed = 0;
  for (const s of targets) {
    let pid = 0; try { pid = parseInt(fs.readFileSync(watchPidFile(s), 'utf8'), 10) || 0; } catch {}
    if (isOurWatcher(pid, s)) { try { process.kill(pid); killed++; } catch {} }
    clearSessionGuardState(s);
    try { fs.unlinkSync(watchPidFile(s)); } catch {}
  }
  process.stdout.write('Stopped ' + targets.length + ' ' + plural(targets.length, 'watcher') + (killed ? ' and ended ' + killed + ' running ' + plural(killed, 'process', 'processes') : '') + '.\n');
  process.exit(0);
}
// --purge: delete everything the guardian wrote locally (checkpoints, tickets, watchers,
// update cache, this profile's ledger entry, temp samples). Nothing here ever left the machine.
function runPurge() {
  process.stdout.write('CCRig v' + VERSION + ' clearing saved state\n  Profile: ' + CFG + '\n');
  const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };
  try { for (const f of fs.readdirSync(guardDir())) if (f.endsWith('.watch.pid')) { const s = f.slice(0, -'.watch.pid'.length); let pid = 0; try { pid = parseInt(fs.readFileSync(path.join(guardDir(), f), 'utf8'), 10) || 0; } catch {} if (isOurWatcher(pid, s)) { try { process.kill(pid); } catch {} } } } catch {}
  rm(guardDir());
  rm(path.join(CFG, 'resume-tickets'));
  try { fs.unlinkSync(updateCacheFile()); } catch {}
  try { fs.unlinkSync(path.join(CFG, 'statusline-error.log')); } catch {} // pure state, squarely inside purge's contract
  try { fs.unlinkSync(path.join(ledgerDir(), path.basename(CFG) + '.json')); } catch {}
  try { for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith('ccbsl-usage-') || f.startsWith('ccbsl-agents-') || f.startsWith('ccsl-git-')) { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch {} } } catch {}
  rm(boardDir()); // shared session-board files (live sessions republish on their next render)
  process.stdout.write("Cleared the saved state on this machine: checkpoints, resume tickets, watchers, the update cache, this profile's ledger entry, the session board, and temporary samples.\n");
  process.exit(0);
}
function pad(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }
function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; } // safe for copy-paste, even with spaces/quotes
// a copy-pasteable resume command that PINS the owning profile's CLAUDE_CONFIG_DIR, so a session
// started under one profile (e.g. personal) resumes under THAT profile even if the current shell is
// pointed at another (e.g. work). Platform-aware: PowerShell (the default Windows shell) vs POSIX.
function resumeCmdLine(cfgDir, cwd, sid) {
  if (process.platform === 'win32') {
    // Emit PowerShell-native syntax. The old cmd.exe form (`cd /d`, `set`, `&&`) does not paste into
    // PowerShell, where `&&` is not a separator in 5.1 and `set`/`$env:` differ. A single-quoted
    // PowerShell string escapes an inner quote by doubling it.
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const cd = cwd ? 'cd ' + q(cwd) + '; ' : '';
    return cd + '$env:CLAUDE_CONFIG_DIR=' + q(cfgDir) + '; claude --resume ' + sid;
  }
  const cd = cwd ? 'cd ' + shellQuote(cwd) + ' && ' : '';
  return cd + 'CLAUDE_CONFIG_DIR=' + shellQuote(cfgDir) + ' claude --resume ' + sid;
}
function readHead(p, bytes) { try { const fd = fs.openSync(p, 'r'); const buf = Buffer.alloc(bytes); const n = fs.readSync(fd, buf, 0, bytes, 0); fs.closeSync(fd); return buf.slice(0, n).toString('utf8'); } catch { return ''; } }
// --board: every live session across your worktrees/profiles (opt-in via sessionBoard)
function runBoard() {
  const dir = boardDir();
  const now = Date.now();
  const entries = [];
  let files = []; try { files = fs.readdirSync(dir); } catch {}
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(dir, f);
    try { const e = JSON.parse(fs.readFileSync(p, 'utf8')); if (e && e.ts && now - e.ts < 3600000) entries.push(e); else fs.unlinkSync(p); } catch { try { fs.unlinkSync(p); } catch {} } // prune >1h stale
  }
  const critAt = CONFIG.thresholds.usage.critical != null ? CONFIG.thresholds.usage.critical : 98;
  const warnAt = warnAtOf(CONFIG.thresholds.usage);
  const liveList = entries.filter((e) => now - e.ts < 600000).sort((a, b) => b.ts - a.ts); // updated in last 10 min
  process.stdout.write('CCRig v' + VERSION + ' session board\n');
  if (CONFIG.sessionBoard !== true) process.stdout.write('  (The session board is off. Turn on "sessionBoard" in your config so your sessions show up here.)\n');
  process.stdout.write('\n');
  if (!liveList.length) { process.stdout.write('  No sessions are active right now.\n'); process.exit(0); }
  for (const e of liveList) {
    const usage = Math.max(e.session || 0, e.weekly || 0);
    const state = usage >= critAt ? '⚠ at limit' : (e.ctx != null && e.ctx >= 85) ? '🔴 ctx ' + e.ctx + '%'
      : e.agents ? '🤖 ' + e.agents + ' agents' : usage >= warnAt ? '⚠ near limit' : 'active';
    const age = Math.round((now - e.ts) / 1000);
    process.stdout.write('  ' + pad(e.project, 20) + ' ' + pad((e.profile || '').replace(/^\.?claude-?/, '') || 'default', 9) + ' ' +
      pad((e.model || '').split(/[\s(]/)[0], 8) + ' ' + pad('s' + Math.round(e.session || 0) + '% w' + Math.round(e.weekly || 0) + '%', 11) + ' ' +
      pad(state, 13) + ' ' + (age < 60 ? age + 's' : Math.round(age / 60) + 'm') + ' ago\n');
  }
  process.stdout.write('\n  ' + liveList.length + ' live session(s).\n');
  process.exit(0);
}
// --sessions: recent sessions in this profile, newest first, with the resume command
function runSessions() {
  // scan EVERY profile, not just the active one: a session you want back may live under a different
  // profile (personal vs work). Each row is labelled with its profile and its resume command pins it.
  const profiles = detectProfiles();
  const rows = [];
  for (const cfgDir of profiles) {
    const base = path.join(cfgDir, 'projects');
    let projs; try { projs = fs.readdirSync(base); } catch { continue; }
    for (const proj of projs) {
      const pdir = path.join(base, proj);
      let files; try { files = fs.readdirSync(pdir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(pdir, f);
        try { const st = fs.statSync(p); rows.push({ sid: f.replace(/\.jsonl$/, ''), path: p, size: st.size, mtime: st.mtimeMs, cfgDir }); } catch {}
      }
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  const multi = profiles.length > 1;
  process.stdout.write('CCRig v' + VERSION + ' recent sessions across ' + profiles.length + ' ' + plural(profiles.length, 'profile') + '\n\n');
  if (!rows.length) { process.stdout.write('  No recent sessions found.\n'); process.exit(0); }
  const now = Date.now();
  for (const r of rows.slice(0, 15)) {
    let cwd = '';
    for (const line of readHead(r.path, 65536).split('\n')) { // cwd may not be on the very first line; a big first record still yields it
      if (!line) continue; let o; try { o = JSON.parse(line); } catch { continue; }
      cwd = o.cwd || (o.workspace && o.workspace.current_dir) || '';
      if (cwd) break;
    }
    const req = (latestUserText(r.path) || '').replace(/\s+/g, ' ').slice(0, 48) || '(no first request found)';
    const ageM = Math.round((now - r.mtime) / 60000);
    const age = ageM < 60 ? ageM + 'm' : ageM < 1440 ? Math.round(ageM / 60) + 'h' : Math.round(ageM / 1440) + 'd';
    const sz = r.size > 1e6 ? (r.size / 1e6).toFixed(1) + 'MB' : Math.round(r.size / 1e3) + 'KB';
    const prof = multi ? pad('[' + profileLabel(r.cfgDir) + ']', 11) + ' ' : '';
    process.stdout.write('  ' + pad(age + ' ago', 8) + ' ' + prof + pad(sz, 7) + ' ' + pad(path.basename(cwd) || '?', 16) + '  ' + req + '\n');
    process.stdout.write('    ' + resumeCmdLine(r.cfgDir, cwd, r.sid) + (cwd ? '' : "   (run this from the project's folder)") + '\n');
  }
  process.exit(0);
}
// one mode at a time: silently ignoring the second flag misleads the user. This gate sits ABOVE
// the one-shot dispatch so a combined command (e.g. `--purge --install`) is rejected, not half-run.
// --hook/--watch are installer-wired internals, never user-typed, so they are exempt.
const EXCLUSIVE = ['--install', '--install-guardian', '--uninstall', '--uninstall-guardian', '--doctor', '--config', '--demo', '--selftest', '--mode', '--autopilot', '--keep-working', '--board', '--sessions', '--status', '--disarm', '--purge', '--options', '--update', '--check-update', '--whatsnew', '--dismiss-update'];
const picked = EXCLUSIVE.filter((m) => argv.includes(m));
if (picked.length > 1) {
  process.stdout.write('pick one of: ' + picked.join(', ') + '\n');
  process.exit(1);
}

if (argv.includes('--hook')) { let inp = {}; try { inp = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {} runHook(argv[argv.indexOf('--hook') + 1], inp); }
if (argv.includes('--watch')) { runWatch(argv[argv.indexOf('--watch') + 1]); return; }
if (argv.includes('--status')) runStatus();
if (argv.includes('--disarm')) {
  const v = argv[argv.indexOf('--disarm') + 1];
  // a bare `--disarm` (no value) disarms all; a value must be a real session id, never another flag
  if (v !== undefined && (v.startsWith('--') || !SID_RE.test(v))) { process.stdout.write('usage: --disarm [session-id]\n'); process.exit(1); }
  runDisarm(v);
}
if (argv.includes('--purge')) runPurge();
if (argv.includes('--board')) runBoard();
if (argv.includes('--sessions')) runSessions();
if (argv.includes('--check-update')) { runCheckUpdate(); return; } // async: exits in its callback
if (argv.includes('--update')) { runUpdate(); return; }             // async: exits in its callback
if (argv.includes('--whatsnew')) runWhatsnew();
if (argv.includes('--dismiss-update')) runDismissUpdate();

// ---- --options: print every current setting + its choices (human + agent readable) ----
function runOptions() {
  const box = (v) => (v === false ? '[ ]' : (v === 'auto' ? '[a]' : '[x]'));
  const S = CONFIG.show, tu = CONFIG.thresholds.usage, tc = CONFIG.thresholds.context;
  const order = Array.isArray(CONFIG.order) ? CONFIG.order : DEFAULT_ORDER;
  const labels = CONFIG.profileLabels || {};
  let o = 'CCRig v' + VERSION + ' options\n';
  o += 'config file: ' + CONFIG_PATH + (fs.existsSync(CONFIG_PATH) ? '' : '  (not present: using defaults)') + '\n\n';
  o += 'display mode:   ' + CONFIG.mode + '        choices: ' + MODES.join(' | ') + '\n';
  o += 'reset style:    ' + CONFIG.resetStyle + '        choices: clock | clock24 | relative\n';
  o += 'resume tickets: ' + (CONFIG.resumeTickets === false ? 'off' : 'on') + '\n';
  o += 'update check:   ' + (CONFIG.updateCheck === false ? 'off' : 'on') + '        once/day background check for a newer version\n';
  o += 'git cache:      ' + (CONFIG.gitCacheMs || 0) + 'ms\n';
  o += '\nguardian (needs --install-guardian to wire the hooks):\n';
  o += '  keep-working:  ' + (cfgKeepWorking() ? 'on' : 'off') + '        keep the session working while todos remain\n';
  o += '  autopilot:     ' + cfgAutopilot() + '        off | notify | resume (auto-relaunch at reset)\n';
  o += '  autopilot buf: ' + (typeof CONFIG.autopilotBuffer === 'number' ? CONFIG.autopilotBuffer : 45) + 's       wait past a reset before relaunching\n';
  o += '  weekly resume: ' + (CONFIG.autopilotWeekly === true ? 'on' : 'off') + '        also auto-relaunch after the 7-day window\n';
  o += '  failover:      ' + (CONFIG.autopilotFailover === true ? 'on' : 'off') + '        continue on a profile with headroom instead of waiting\n';
  o += '  bypass perms:  ' + (CONFIG.autopilotBypassPermissions === true ? 'on' : 'off') + '        the unattended auto-resume relaunch skips permission prompts\n';
  o += '  forecast:      ' + (CONFIG.forecast === false ? 'off' : 'on') + '        predictive time-to-limit + pace in the bar\n';
  o += '  ledger:        ' + (CONFIG.ledger === false ? 'off' : 'on') + '        share this profile\'s usage for cross-profile hints\n\n';
  o += 'segments  ([x] on  [ ] off  [a] auto;  normal mode honors these, minimal/expanded override):\n';
  for (const n of order) o += '  ' + box(S[n]) + ' ' + n + '\n';
  o += '\nthresholds (percent of the window used):\n';
  o += '  context: green<=' + tc.green + '  yellow<=' + tc.yellow + '  (else red)\n';
  o += '  usage:   green<=' + tu.green + '  yellow<=' + tu.yellow + '  warn>=' + (tu.warn != null ? tu.warn : 90) + '  critical>=' + (tu.critical != null ? tu.critical : 98) + '\n';
  o += '\nprofile labels: ' + (Object.keys(labels).length ? JSON.stringify(labels) : '(none set; derived from dir names)') + '\n';
  o += '\nchange it:\n';
  o += '  in a Claude Code session:   /statusline-config\n';
  o += '  set a mode:                 node "' + __filename + '" --mode <' + MODES.join('|') + '>\n';
  o += '  interactive (a terminal):   node "' + __filename + '" --config\n';
  o += '  or edit:                    ' + CONFIG_PATH + '\n';
  process.stdout.write(o);
  process.exit(0);
}
if (argv.includes('--options')) runOptions();

// ---- push-button install: wire settings.json to this file, backup first ----
function settingsPathOf(dir = CFG) { return path.join(dir, 'settings.json'); }
function isPlainObject(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
// state: 'missing' | 'invalid' (unparseable) | 'notObject' (an array/number/null) | 'ok'
function readSettingsRaw(dir = CFG) {
  const sp = settingsPathOf(dir);
  if (!fs.existsSync(sp)) return { state: 'missing', value: null };
  let v;
  try { v = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch { return { state: 'invalid', value: null }; }
  return isPlainObject(v) ? { state: 'ok', value: v } : { state: 'notObject', value: null };
}
function backupSettings(dir = CFG) {
  const sp = settingsPathOf(dir);
  if (!fs.existsSync(sp)) return null;
  const bak = sp + '.bak';
  // protect a pristine pre-CCRig backup: if a .bak exists that predates us (no statusline.js reference),
  // don't clobber it — write the current content to .bak.1 instead, so a user's original custom bar
  // survives repeated installs/guardian-installs.
  try {
    if (fs.existsSync(bak) && !/statusline\.js/.test(fs.readFileSync(bak, 'utf8'))) {
      const bak1 = sp + '.bak.1'; fs.copyFileSync(sp, bak1); return bak1;
    }
  } catch {}
  fs.copyFileSync(sp, bak); return bak;
}
// The commands CCRig installs into <dir>/commands so they appear natively in the Claude Code `/`
// menu: `/ccrig` (a hub) and focused `/ccrig:<name>` actions, plus `/statusline-config` (kept for
// backward compatibility). The script path is baked into each, so they work whether CCRig was
// installed from npm or as a single file.
function slashCommandDir(dir = CFG) { return path.join(dir, 'commands'); }
function slashCommandPath(dir = CFG) { return path.join(slashCommandDir(dir), 'statusline-config.md'); }
// every command file CCRig owns, so --uninstall can remove them all cleanly
function ccrigCommandFiles(dir = CFG) {
  const d = slashCommandDir(dir);
  return ['statusline-config.md', 'ccrig.md', path.join('ccrig', 'config.md'), path.join('ccrig', 'status.md'),
    path.join('ccrig', 'sessions.md'), path.join('ccrig', 'doctor.md'), path.join('ccrig', 'update.md')].map((f) => path.join(d, f));
}
// the interactive config menu, shared by /statusline-config and /ccrig:config
function configMenuDoc(sl) {
  return [
    '---',
    'description: Open an interactive menu to configure your CCRig status line',
    'argument-hint: [optional: a change to apply directly, e.g. "minimal mode"]',
    '---',
    '',
    'Open an INTERACTIVE MENU so the user configures their CCRig by',
    'picking options, not by typing free text. The script is:',
    '',
    '    ' + sl,
    '',
    'Drive every choice with the AskUserQuestion tool (it renders as a selectable menu',
    'in the Claude Code CLI). Do not dump walls of text; surface values inside the menus.',
    '',
    '1. Read the current settings: run `node "' + sl + '" --options` (parse it, do not paste it all).',
    '2. If arguments were given below, apply that directly and skip to step 5. Otherwise open the',
    '   MAIN MENU with AskUserQuestion, header "Status line", question "What do you want to change?",',
    '   options (put the current value in each description):',
    '     - Display mode        (minimal / normal / expanded)',
    '     - Toggle a segment    (turn any segment on or off)',
    '     - Reset time style    (clock / relative)',
    '     - Resume tickets      (on / off)',
    '     - Thresholds          (warn %, critical %, color cutoffs)',
    '     - Show current + preview',
    '   (AskUserQuestion always adds an "Other" free-text choice; the user can use it.)',
    '3. Drill in with a follow-up AskUserQuestion menu for the pick, e.g. mode -> minimal/normal/expanded;',
    '   "Toggle a segment" -> a menu of the segments with their on/off state, then which way to set it.',
    '4. Apply the change:',
    '     - Display mode: `node "' + sl + '" --mode <minimal|normal|expanded>`',
    '     - Anything else: edit statusline.config.json next to the script, deep-merging ONLY the keys',
    '       being changed and keeping valid JSON. Never edit statusline.js.',
    '5. Verify with `node "' + sl + '" --doctor` (must pass) and show a fresh `node "' + sl + '" --demo`.',
    '6. Ask with AskUserQuestion "Change something else?" (Yes -> back to the main menu; Done -> stop).',
    '   Loop until the user is done.',
    '7. Briefly summarize what changed. Changes apply live within a couple seconds; no restart.',
    '',
    '$ARGUMENTS',
    '',
  ].join('\n');
}
// a "run one CCRig command and present the result nicely" slash command
function actionDoc(desc, sl, flag, instruction) {
  return ['---', 'description: ' + desc, 'allowed-tools: Bash(node:*)', '---', '', instruction, '',
    '!`node "' + sl + '" ' + flag + '`', ''].join('\n');
}
// write the whole /ccrig command suite (+ the legacy /statusline-config). Returns the config path
// (a truthy command path) so the caller can report that commands were added; null on failure.
function writeSlashCommands(dir = CFG) {
  try {
    const d = slashCommandDir(dir);
    const sl = __filename;
    fs.mkdirSync(path.join(d, 'ccrig'), { recursive: true });
    const cfg = configMenuDoc(sl);
    fs.writeFileSync(path.join(d, 'statusline-config.md'), cfg);
    fs.writeFileSync(path.join(d, 'ccrig', 'config.md'), cfg);
    fs.writeFileSync(path.join(d, 'ccrig', 'status.md'), actionDoc('Show your CCRig guardian status (auto-resume watchers)', sl, '--status',
      'Run the command below and give me a short, plain summary of my CCRig guardian status: which sessions are watched for auto-resume and when they will fire. If nothing is armed, say so.'));
    fs.writeFileSync(path.join(d, 'ccrig', 'sessions.md'), actionDoc('List your recent Claude Code sessions and how to resume each', sl, '--sessions',
      'Run the command below and show me my recent Claude Code sessions as a clean list, each with the exact command to resume it. Do not change anything.'));
    fs.writeFileSync(path.join(d, 'ccrig', 'doctor.md'), actionDoc('Check that your CCRig status line and guardian are healthy', sl, '--doctor',
      'Run the command below and tell me, in plain language, whether my CCRig setup is healthy. If it flags a problem, explain it and the exact fix.'));
    fs.writeFileSync(path.join(d, 'ccrig', 'update.md'), actionDoc('Check whether a newer CCRig is available', sl, '--check-update',
      'Run the command below and tell me whether a newer CCRig is available and how to get it. Do not update anything without asking me first.'));
    fs.writeFileSync(path.join(d, 'ccrig.md'), ['---',
      'description: CCRig, your Claude Code status line and usage-limit guardian',
      'argument-hint: [status | sessions | doctor | update | config]',
      'allowed-tools: Bash(node:*)',
      '---', '',
      "You are helping with CCRig, the user's Claude Code status line and usage-limit guardian.",
      'If an argument is given below, do that action (status, sessions, doctor, update, or config).',
      'Otherwise, run the status check below, tell the user in a line or two what CCRig is doing right',
      'now, and list what they can run next: /ccrig:status, /ccrig:sessions, /ccrig:doctor,',
      '/ccrig:update, and /ccrig:config.', '',
      '!`node "' + sl + '" --status`', '',
      '$ARGUMENTS', '',
    ].join('\n'));
    return path.join(d, 'statusline-config.md');
  } catch { return null; }
}
// wire ONE profile. Returns a result the caller reports; never exits, never throws for a
// bad settings.json (so one broken profile can't block the others).
function installStatusLineInto(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const sp = settingsPathOf(dir);
    const raw = readSettingsRaw(dir);
    if (raw.state === 'invalid') return { dir, sp, err: 'settings.json is not valid JSON (fix or delete it, then re-run)' };
    if (raw.state === 'notObject') return { dir, sp, err: 'settings.json is not a JSON object (fix it, then re-run)' };
    const settings = raw.value || {};
    // announce (and via backupSettings, preserve) a foreign status line we are about to replace
    const prevSl = isPlainObject(settings.statusLine) && typeof settings.statusLine.command === 'string' ? settings.statusLine.command : '';
    const replacedForeign = (prevSl && !isOurCmd(prevSl)) ? prevSl : null;
    const bak = backupSettings(dir);
    // process.execPath = the node running this installer: absolute, exists, cross-platform
    settings.statusLine = { type: 'command', command: `"${process.execPath}" "${__filename}"`, refreshInterval: 2 };
    if (!writeJsonAtomic(sp, settings)) throw new Error('could not save ' + sp + '; it was left unchanged');
    JSON.parse(fs.readFileSync(sp, 'utf8')); // round-trip validate
    const cmd = writeSlashCommands(dir);
    return { dir, sp, bak, cmd, replacedForeign };
  } catch (e) { return { dir, sp: settingsPathOf(dir), err: e.message }; }
}
function runInstall() {
  // By default wire EVERY profile on this machine, so a work + personal setup never ends
  // up with the bar on only one. --this-profile scopes it to the active CLAUDE_CONFIG_DIR.
  const thisOnly = argv.includes('--this-profile');
  const profiles = thisOnly ? [CFG] : detectProfiles();
  const results = profiles.map(installStatusLineInto);
  const okd = results.filter((r) => !r.err);
  const failed = results.filter((r) => r.err);
  for (const r of okd) {
    process.stdout.write('Set up the status line for the ' + profileLabel(r.dir) + ' profile.  (' + r.sp + ')'
      + (r.bak ? '  A backup was saved first.' : '') + '\n');
    if (r.replacedForeign) process.stdout.write('  Replaced the status line that was there before' + (r.bak ? ' (the old one is in the backup)' : '') + '.\n');
  }
  if (okd.some((r) => r.cmd)) process.stdout.write('Added the /ccrig commands to Claude Code: /ccrig, /ccrig:status, /ccrig:sessions, /ccrig:doctor, /ccrig:update, and /ccrig:config.\n');
  for (const r of failed) process.stdout.write('Could not set up the ' + profileLabel(r.dir) + ' profile (' + r.sp + '): ' + r.err + '\n');
  if (!thisOnly) for (const d of markerlessClaudeDirs()) process.stdout.write('Skipped the ' + profileLabel(d) + ' profile: it has no Claude settings yet. To set it up, run:  CLAUDE_CONFIG_DIR=' + d + ' node "' + __filename + '" --install --this-profile\n');
  if (!okd.length) { process.stdout.write('Setup did not finish: no profile could be set up. Run --doctor to see what is wrong.\n'); process.exit(1); }
  if (!thisOnly && profiles.length > 1) {
    // honest summary: only claim "all profiles" when nothing was skipped. Exit stays 0 on a partial
    // success so the one-line curl installer's `&&` chain is not broken.
    process.stdout.write('\nSet up ' + okd.length + ' of ' + profiles.length + ' ' + plural(profiles.length, 'profile')
      + (failed.length ? '. ' + failed.length + ' could not be set up; fix ' + (failed.length === 1 ? 'it' : 'them') + ' and run again.' : '. All your Claude profiles now show the bar.')
      + ' (Add --this-profile to set up just one.)\n');
  }
  const helper = path.join(__dirname, 'claude-profiles.sh');
  // claude-profiles.sh is a bash/zsh helper; do not tell a PowerShell (Windows) user to `source` it.
  if (fs.existsSync(helper) && process.platform !== 'win32') process.stdout.write('To switch accounts from your shell:  source "' + helper + '"\n');
  process.stdout.write('\nPreview it now:  node "' + __filename + '" --demo\n');
  process.stdout.write('Never lose work to a usage limit? Set up the guardian:  node "' + __filename + '" --install-guardian\n');
  // honest one-line privacy note; the render is zero-network, a once-a-day check is the only exception
  process.stdout.write('Privacy: drawing the bar never uses the network. The only exception is a once-a-day update check, which you can turn off with "updateCheck": false (or NO_UPDATE_NOTIFIER=1).\n');
  process.stdout.write('\nRestart Claude Code once, and you are set. After that, changes to your settings apply live.\n');
  process.exit(0);
}

// ---- guardian: wire the Stop / SessionStart / PreCompact hooks (Features 1, 2, 5) ----
const GUARD_EVENTS = [['Stop', 'stop'], ['SessionStart', 'session-start'], ['PreCompact', 'pre-compact']];
function guardianHookCommand(slug) { return `"${process.execPath}" "${__filename}" --hook ${slug}`; }
// paths a settings command references (quoted tokens first, then whitespace-split bare tokens)
function cmdPaths(cmd) {
  const quoted = [...String(cmd).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return quoted.concat(String(cmd).split(/\s+/));
}
// does the command reference a statusline.js path at all — i.e. THIS tool by name, any install
// (existence-agnostic). Used to strip guardian hooks even from a moved/deleted copy (reversibility).
function refsStatuslineJs(cmd) {
  if (typeof cmd !== 'string') return false;
  if (cmd.includes(__filename)) return true;
  return cmdPaths(cmd).some((t) => /(^|[\/\\])statusline\.js$/.test(t));
}
// does this statusLine command belong to THIS install to REMOVE safely? our exact file, OR a
// stale reference to a now-MISSING statusline.js (a moved/partial install) — never a LIVE foreign
// script that merely shares the name. Guards --uninstall against deleting someone else's bar.
function isOurCmd(cmd) {
  if (typeof cmd !== 'string') return false;
  if (cmd.includes(__filename)) return true;
  let selfReal; try { selfReal = fs.realpathSync(__filename); } catch { selfReal = __filename; }
  for (const t of cmdPaths(cmd)) {
    if (/(^|[\/\\])statusline\.js$/.test(t)) {
      // symlink-aware same-file check (a symlinked TMPDIR spells our own path two ways); a
      // MISSING path is a stale reference to a moved/deleted copy of ours, so still ours to clean.
      try { const real = fs.realpathSync(t); return real === selfReal || real === __filename; }
      catch { return true; }
    }
  }
  return false;
}
// a guardian hook of ours: the --hook convention + any statusline.js reference (any install).
function isGuardianHookCmd(h) { return h && typeof h.command === 'string' && h.command.includes('--hook') && refsStatuslineJs(h.command); }
function isGuardianHookGroup(g) { return g && Array.isArray(g.hooks) && g.hooks.some(isGuardianHookCmd); }
// remove ONLY our individual hook entries, per-hook, so a user's hook that shares a
// group object with ours is never dropped. Empty groups (and events) are pruned.
// Returns the possibly-emptied hooks object (undefined if now empty) + a removed count.
function stripGuardianHooks(hooks) {
  if (!isPlainObject(hooks)) return { hooks, removed: 0 };
  let removed = 0;
  for (const [Event] of GUARD_EVENTS) {
    if (!Array.isArray(hooks[Event])) continue;
    const kept = [];
    for (const g of hooks[Event]) {
      if (g && Array.isArray(g.hooks)) {
        const before = g.hooks.length;
        g.hooks = g.hooks.filter((h) => !isGuardianHookCmd(h));
        removed += before - g.hooks.length;
        if (!g.hooks.length) continue; // this group held only our hook(s) -> drop it
      }
      kept.push(g);
    }
    if (kept.length) hooks[Event] = kept; else delete hooks[Event];
  }
  return { hooks: Object.keys(hooks).length ? hooks : undefined, removed };
}
// wire the guardian hooks into ONE profile. Returns a result; never exits/throws.
function installGuardianInto(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const sp = settingsPathOf(dir);
    const raw = readSettingsRaw(dir);
    if (raw.state === 'invalid') return { dir, sp, err: 'settings.json is not valid JSON (fix it, then re-run)' };
    if (raw.state === 'notObject') return { dir, sp, err: 'settings.json is not a JSON object (fix it, then re-run)' };
    const settings = raw.value || {};
    const bak = backupSettings(dir);
    if (!isPlainObject(settings.statusLine) || typeof settings.statusLine.command !== 'string') {
      settings.statusLine = { type: 'command', command: `"${process.execPath}" "${__filename}"`, refreshInterval: 2 };
    }
    // strip any prior guardian hooks surgically (keeps the user's own), then add fresh
    settings.hooks = stripGuardianHooks(isPlainObject(settings.hooks) ? settings.hooks : {}).hooks || {};
    for (const [Event, slug] of GUARD_EVENTS) {
      const kept = Array.isArray(settings.hooks[Event]) ? settings.hooks[Event] : [];
      kept.push({ hooks: [{ type: 'command', command: guardianHookCommand(slug) }] });
      settings.hooks[Event] = kept;
    }
    if (!writeJsonAtomic(sp, settings)) throw new Error('could not save ' + sp + '; it was left unchanged');
    JSON.parse(fs.readFileSync(sp, 'utf8')); // round-trip validate
    writeSlashCommands(dir);
    return { dir, sp, bak };
  } catch (e) { return { dir, sp: settingsPathOf(dir), err: e.message }; }
}
function runInstallGuardian() {
  const thisOnly = argv.includes('--this-profile');
  const profiles = thisOnly ? [CFG] : detectProfiles();
  const results = profiles.map(installGuardianInto);
  const okd = results.filter((r) => !r.err);
  const failed = results.filter((r) => r.err);
  for (const r of okd) {
    process.stdout.write('Set up the guardian for the ' + profileLabel(r.dir) + ' profile (Stop, SessionStart, and PreCompact hooks).  (' + r.sp + ')'
      + (r.bak ? '  A backup was saved first.' : '') + '\n');
  }
  for (const r of failed) process.stdout.write('Could not set up the ' + profileLabel(r.dir) + ' profile (' + r.sp + '): ' + r.err + '\n');
  if (!okd.length) { process.stdout.write('Guardian setup did not finish: no profile could be set up. Run --doctor to see what is wrong.\n'); process.exit(1); }
  // config (keep-working + autopilot) is shared across profiles — set it once
  const want = argv.includes('--auto') ? 'resume' : (cfgAutopilot() === 'off' ? 'notify' : cfgAutopilot());
  CONFIG.keepWorking = true;
  CONFIG.autopilot = want;
  saveConfig();
  if (!thisOnly && profiles.length > 1) {
    process.stdout.write('\nSet up the guardian for ' + okd.length + ' ' + plural(okd.length, 'profile')
      + (failed.length ? '. ' + failed.length + ' could not be set up.' : '.') + ' (Add --this-profile to set up just one.)\n');
  }
  process.stdout.write('Relentless mode is on: the session keeps working while todos remain.\n');
  process.stdout.write('Limit Autopilot: ' + want + (want === 'resume'
    ? '. It restarts your session on its own the moment the limit resets.'
    : '. It saves your place and sends a desktop alert; add --auto to have it restart on its own.') + '\n');
  process.stdout.write('\nAdjust it any time:  --autopilot <off|notify|resume>   --keep-working <on|off>\n');
  process.stdout.write('Remove it with:  node "' + __filename + '" --uninstall-guardian\n');
  process.stdout.write('\nRestart Claude Code once so the hooks load.\n');
  process.exit(0);
}
// remove the guardian hooks from ONE profile. Returns a result; never exits/throws.
function uninstallGuardianFrom(dir) {
  try {
    const sp = settingsPathOf(dir);
    const raw = readSettingsRaw(dir);
    if (raw.state !== 'ok') return { dir, sp, removed: 0 };
    const settings = raw.value;
    const res = stripGuardianHooks(settings.hooks);
    if (!res.removed) return { dir, sp, removed: 0 };
    const bak = backupSettings(dir);
    if (res.hooks === undefined) delete settings.hooks; else settings.hooks = res.hooks;
    if (!writeJsonAtomic(sp, settings)) throw new Error('could not save ' + sp + '; it was left unchanged');
    return { dir, sp, removed: res.removed, bak };
  } catch (e) { return { dir, sp: settingsPathOf(dir), removed: 0, err: e.message }; }
}
function runUninstallGuardian() {
  const thisOnly = argv.includes('--this-profile');
  const profiles = thisOnly ? [CFG] : detectProfiles();
  const results = profiles.map(uninstallGuardianFrom);
  const removedAny = results.filter((r) => r.removed);
  for (const r of removedAny) process.stdout.write('Removed ' + r.removed + ' guardian ' + plural(r.removed, 'hook') + ' from the ' + profileLabel(r.dir) + ' profile.  (' + r.sp + ')' + (r.bak ? '  A backup was saved first.' : '') + '\n');
  for (const r of results.filter((r) => r.err)) process.stdout.write('The ' + profileLabel(r.dir) + ' profile ran into a problem: ' + r.err + '\n');
  if (!removedAny.length) { process.stdout.write('There is nothing to remove: no profile has guardian hooks.\n'); process.exit(0); }
  CONFIG.keepWorking = false; CONFIG.autopilot = 'off'; saveConfig();
  process.stdout.write('Turned off Relentless mode and Autopilot. The status line itself stays in place.\n');
  process.exit(0);
}
// remove OUR status line (+ guardian hooks + slash command) from ONE profile. Never
// touches a third-party status line. Returns a result; never exits/throws.
function uninstallFrom(dir) {
  try {
    const sp = settingsPathOf(dir);
    const raw = readSettingsRaw(dir);
    const gres = raw.state === 'ok' ? stripGuardianHooks(raw.value.hooks) : { removed: 0 };
    // only remove a statusLine that is THIS script's, so we never delete a third-party
    // status line the user switched to (a statusLine with no readable command is treated
    // as ours: it's almost certainly a stale/partial entry from a moved install).
    const sl = raw.state === 'ok' ? raw.value.statusLine : undefined;
    const slCmd = isPlainObject(sl) && typeof sl.command === 'string' ? sl.command : (sl ? '' : null);
    const ownsStatusLine = slCmd != null && (slCmd === '' || isOurCmd(slCmd));
    const foreign = !!(sl && !ownsStatusLine);
    // these two files are unconditionally OURS regardless of statusLine ownership: clean them even
    // when the user switched status lines and runs --uninstall just to tidy up (hoisted above the early return).
    let removedCmd = false;
    try {
      for (const cf of ccrigCommandFiles(dir)) { try { if (fs.existsSync(cf)) { fs.unlinkSync(cf); removedCmd = true; } } catch {} }
      try { fs.rmdirSync(path.join(slashCommandDir(dir), 'ccrig')); } catch {} // drop the now-empty /ccrig subdir
    } catch {}
    try { fs.unlinkSync(path.join(dir, '.ccbsl-update.json')); } catch {}
    if (raw.state !== 'ok' || (!ownsStatusLine && !gres.removed)) return { dir, sp, removedSL: false, removedHooks: 0, foreign, removedCmd };
    const settings = raw.value;
    const bak = backupSettings(dir);
    if (ownsStatusLine) delete settings.statusLine;
    if (gres.removed) { if (gres.hooks === undefined) delete settings.hooks; else settings.hooks = gres.hooks; }
    if (!writeJsonAtomic(sp, settings)) throw new Error('could not save ' + sp + '; it was left unchanged');
    return { dir, sp, removedSL: ownsStatusLine, removedHooks: gres.removed, foreign, bak, removedCmd };
  } catch (e) { return { dir, sp: settingsPathOf(dir), err: e.message }; }
}
function runUninstall() {
  const thisOnly = argv.includes('--this-profile');
  const profiles = thisOnly ? [CFG] : detectProfiles();
  const results = profiles.map(uninstallFrom);
  const errs = results.filter((r) => r.err);
  let touched = 0;
  for (const r of results) {
    if (r.err) { process.stdout.write('Could not remove CCRig from the ' + profileLabel(r.dir) + ' profile: ' + r.err + '\n'); continue; }
    if (r.removedSL) { process.stdout.write('Removed the status line from the ' + profileLabel(r.dir) + ' profile.  (' + r.sp + ')' + (r.bak ? '  A backup was saved first.' : '') + '\n'); touched++; }
    else if (r.foreign) process.stdout.write('Left the ' + profileLabel(r.dir) + " profile's status line alone, since it belongs to another tool.\n");
    if (r.removedHooks) { process.stdout.write('Removed ' + r.removedHooks + ' guardian ' + plural(r.removedHooks, 'hook') + ' from the ' + profileLabel(r.dir) + ' profile.\n'); touched++; }
    if (r.removedCmd) { process.stdout.write('Removed the /ccrig commands from the ' + profileLabel(r.dir) + ' profile.\n'); touched++; }
  }
  if (!touched) {
    if (errs.length) process.exit(1); // a real permission/IO failure, not a clean no-op
    process.stdout.write('There is nothing to remove: no profile has our status line or guardian hooks.\n');
    process.exit(0);
  }
  process.stdout.write('This file and statusline.config.json were left in place. You can delete them if you like.\n');
  process.exit(errs.length ? 1 : 0);
}

// paths a command references that must exist on disk: prefer quoted absolute tokens; if NONE are
// quoted, fall back to whitespace-split absolute tokens, so an unquoted dead path is still caught.
function checkCmdPaths(cmd) {
  if (typeof cmd !== 'string') return { checked: 0, missing: [] };
  const quoted = [...cmd.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  // Prefer quoted tokens; fall back to whitespace-split ONLY when there are no quoted tokens at all,
  // so an unquoted dead path is caught but an `sh -c "node /path"` wrapper is not mis-split into a
  // fake absolute token (the quoted `node /path` is one non-absolute token, so nothing is checked).
  const toks = (quoted.length ? quoted : cmd.split(/\s+/)).filter((t) => !t.startsWith('-') && path.isAbsolute(t));
  const missing = toks.filter((t) => { try { return !fs.existsSync(t); } catch { return true; } });
  return { checked: toks.length, missing };
}
// ---- doctor: diagnose the failure modes users actually hit ----
function runDoctor() {
  let fails = 0;
  const ok = (m) => process.stdout.write('  ok    ' + m + '\n');
  const bad = (m, fix) => { fails++; process.stdout.write('  FAIL  ' + m + (fix ? '\n        fix: ' + fix : '') + '\n'); };
  const info = (m) => process.stdout.write('  --    ' + m + '\n');
  process.stdout.write('CCRig v' + VERSION + ' doctor\n');
  process.stdout.write('  script:  ' + __filename + '\n  profile: ' + CFG + '\n\n');

  const major = parseInt(process.versions.node, 10);
  if (major >= 18) ok('node ' + process.versions.node); else bad('node ' + process.versions.node + ' is too old', 'use Node 18 or newer');

  const sp = settingsPathOf();
  const raw = readSettingsRaw();
  if (raw.state === 'missing') bad('no settings.json at ' + sp, 'run: node "' + __filename + '" --install');
  else if (raw.state === 'invalid') bad('settings.json is not valid JSON', 'fix or delete it, then re-run --install');
  else if (raw.state === 'notObject') bad('settings.json parses but is not a JSON object', 'fix it, then re-run --install');
  else ok('settings.json parses');
  if (raw.state === 'ok') {
    const sl = isPlainObject(raw.value.statusLine) ? raw.value.statusLine : {};
    const cmd = typeof sl.command === 'string' ? sl.command : '';
    if (raw.value.statusLine && !isPlainObject(raw.value.statusLine)) bad('statusLine is not an object', 're-run: node "' + __filename + '" --install');
    else if (sl.command != null && typeof sl.command !== 'string') bad('statusLine.command is not a string', 're-run: node "' + __filename + '" --install');
    else if (!cmd) bad('statusLine is not configured', 'run: node "' + __filename + '" --install');
    else {
      ok('statusLine is configured');
      if (!isOurCmd(cmd)) info('statusLine points at a different script: ' + cmd);
      // check the absolute paths (node binary AND script); an UNQUOTED dead path is caught too
      const slp = checkCmdPaths(cmd);
      if (slp.missing.length) bad('path(s) in the statusLine command do not exist: ' + slp.missing.join(', ') + ' (moved? node upgrade?)', 're-run: node "' + __filename + '" --install');
      else if (slp.checked) ok('command paths exist (' + slp.checked + ' checked)');
      else info('no absolute paths in the command to check');
      if (sl.refreshInterval) ok('refreshInterval: ' + sl.refreshInterval + 's'); else info('refreshInterval not set: bars update only on session events');
    }
  }
  if (fs.existsSync(CONFIG_PATH)) {
    try { JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); ok('statusline.config.json parses'); }
    catch (e) { bad('statusline.config.json is invalid JSON (' + e.message + '); defaults are in use', 'fix it or delete it'); }
  } else info('no statusline.config.json: defaults in use (customize with --config)');
  try { execSync('git --version', { stdio: 'ignore', timeout: 2000 }); ok('git found'); }
  catch { info('git not found: the git segment stays hidden'); }
  // subscription-only features: rate_limits is only in stdin for Claude.ai Pro/Max
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) info('API key detected: usage bars, forecast, and auto-resume are subscription-only (they need rate_limits, which Claude Code sends only to Pro/Max); you still get context/git/cost/model');
  else info('usage bars/forecast/auto-resume need a Claude.ai Pro/Max subscription (rate_limits in stdin); if they stay blank on a subscription, the stdin schema may have changed');
  // guardian: report which lifecycle hooks are wired, and whether claude is reachable for auto-resume
  if (raw.state === 'ok') {
    const hooks = isPlainObject(raw.value.hooks) ? raw.value.hooks : {};
    const wired = GUARD_EVENTS.filter(([Event]) => Array.isArray(hooks[Event]) && hooks[Event].some(isGuardianHookGroup)).map(([Event]) => Event);
    if (wired.length === GUARD_EVENTS.length) ok('guardian hooks wired (' + wired.join(', ') + ')');
    else if (wired.length) info('guardian partly wired (' + wired.join(', ') + '); re-run --install-guardian for all three');
    else info('guardian hooks not wired (Relentless mode + auto-resume off); enable with --install-guardian');
    if (wired.length) {
      // path-check the hook commands too (doctor only checked statusLine before): after a node-version
      // upgrade, --install fixes statusLine but the hooks still point at a dead node path.
      const hookCmds = [];
      for (const [Event] of GUARD_EVENTS) for (const g of (Array.isArray(hooks[Event]) ? hooks[Event] : [])) for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) if (isGuardianHookCmd(h)) hookCmds.push(h.command);
      const hookMissing = [];
      for (const hc of hookCmds) for (const m of checkCmdPaths(hc).missing) if (!hookMissing.includes(m)) hookMissing.push(m);
      if (hookMissing.length) bad('path(s) in guardian hook commands do not exist: ' + hookMissing.join(', '), 're-run: node "' + __filename + '" --install-guardian');
      info('  keep-working: ' + (cfgKeepWorking() ? 'on' : 'off') + '   autopilot: ' + cfgAutopilot());
      if (cfgAutopilot() === 'resume') {
        try {
          if (process.platform === 'win32') {
            // auto-resume launches the `claude` shim via winLaunch (node against its cli.js), so a
            // .cmd/.ps1 shim is fine now; just confirm claude resolves on PATH.
            execSync('where ' + claudeBin(), { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
            ok('claude on PATH (auto-resume can relaunch)');
          } else {
            execSync('command -v ' + claudeBin(), { stdio: 'ignore', timeout: 2000 });
            ok('claude on PATH (auto-resume can relaunch)');
          }
        } catch { bad('autopilot is "resume" but "' + claudeBin() + '" is not on PATH', 'set "claudeBin" in config to an absolute claude path'); }
      }
    }
  }
  // update system: report the check state + any available version (no network here; reads the cache)
  if (CONFIG.updateCheck === false) info('update check: off');
  else {
    const u = readUpdateInfo();
    if (!u) info('update check: on (not run yet; a daily background check will populate it)');
    else if (u.latest && semverGt(u.latest, VERSION)) info('update check: on, v' + u.latest + ' available (run --update); you have v' + VERSION);
    else info('update check: on, up to date (v' + VERSION + ')');
  }
  // the /statusline-config command bakes in the script path; flag a stale one after a move
  try {
    const scp = slashCommandPath();
    if (fs.existsSync(scp)) {
      const m = fs.readFileSync(scp, 'utf8').split('\n').map((l) => l.trim()).find((l) => path.isAbsolute(l) && /statusline\.js$/.test(l));
      if (m && !fs.existsSync(m)) bad('the /statusline-config command points at a missing script (' + m + ')', 're-run: node "' + __filename + '" --install');
    }
  } catch {}
  try { render(demoInput(), 80, DEMO_GIT()); ok('test render'); }
  catch (e) { bad('rendering throws: ' + e.message, 'update this file, or report it'); }
  const elog = path.join(CFG, 'statusline-error.log');
  if (fs.existsSync(elog)) info('a previous run errored; see ' + elog + ' (delete it to clear this note)');

  process.stdout.write(fails ? '\n' + fails + ' problem(s) found.\n' : '\nAll checks passed.\n');
  process.exit(fails ? 1 : 0);
}

// ---- --autopilot / --keep-working: one-command toggles for the guardian, saved to config ----
if (argv.includes('--autopilot')) {
  const want = argv[argv.indexOf('--autopilot') + 1];
  if (!['off', 'notify', 'resume'].includes(want)) {
    process.stdout.write('usage: --autopilot <off|notify|resume>' + (want ? '  (got "' + want + '")' : '') + '\n');
    process.exit(1);
  }
  CONFIG.autopilot = want;
  if (saveConfig()) process.stdout.write('ok  autopilot -> ' + want + '  (' + CONFIG_PATH + ')\n');
  process.exit(0);
}
if (argv.includes('--keep-working')) {
  const want = argv[argv.indexOf('--keep-working') + 1];
  if (!['on', 'off'].includes(want)) {
    process.stdout.write('usage: --keep-working <on|off>' + (want ? '  (got "' + want + '")' : '') + '\n');
    process.exit(1);
  }
  CONFIG.keepWorking = (want === 'on');
  if (saveConfig()) process.stdout.write('ok  keep-working -> ' + want + '  (' + CONFIG_PATH + ')\n');
  process.exit(0);
}

// ---- --mode <minimal|normal|expanded>: one-command display density, saved to config ----
if (argv.includes('--mode')) {
  const want = argv[argv.indexOf('--mode') + 1];
  if (!MODES.includes(want)) {
    process.stdout.write('usage: --mode <' + MODES.join('|') + '>' + (want ? '  (got "' + want + '")' : '') + '\n');
    process.exit(1);
  }
  CONFIG.mode = want;
  if (saveConfig()) process.stdout.write('ok  display mode -> ' + want + '  (' + CONFIG_PATH + ')\nPreview:  node "' + __filename + '" --demo\n');
  process.exit(0);
}

if (argv.includes('--install')) runInstall();
if (argv.includes('--install-guardian')) runInstallGuardian();
if (argv.includes('--uninstall-guardian')) runUninstallGuardian();
if (argv.includes('--uninstall')) runUninstall();
if (argv.includes('--doctor')) {
  try { runDoctor(); } catch (e) { process.stdout.write('doctor crashed: ' + e.message + '\n'); process.exit(1); }
}

if (argv.includes('--demo')) {
  const ci = argv.indexOf('--cols');
  const cols = ci >= 0 ? parseInt(argv[ci + 1], 10) : null;
  DEMO_UPDATE_LATEST = '2.9.9';        // showcase the ⬆ update badge in the preview
  DEMO_AGENTS = 3;                     // showcase the 🤖 subagents segment
  DEMO_DOWNGRADE = ['Opus 4.8', 'Sonnet 5']; // showcase the ⬇ downgrade alert
  const demo = demoInput();
  // seed a short burn history so the ⏳ forecast segment shows in the preview
  try {
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(sampleFile(demo.session_id), [
      JSON.stringify({ t: now - 150, s: 51, w: 90 }),
      JSON.stringify({ t: now - 80, s: 58, w: 92 }),
      JSON.stringify({ t: now, s: 63, w: 93 }),
    ].join('\n') + '\n');
  } catch {}
  const widths = cols ? [cols] : [120, 80, 50];
  for (const w of widths) {
    process.stdout.write(`\n\x1b[2m── ${w} cols ──\x1b[0m\n`);
    process.stdout.write(render(demo, w - CONFIG.reserveCols, DEMO_GIT()) + '\n');
  }
  process.stdout.write('\n');
  process.exit(0);
}

if (argv.includes('--config')) {
  runConfigEditor(); // owns the process lifecycle; normal path below is guarded off
}

if (argv.includes('--selftest')) {
  const now = Math.floor(Date.now() / 1000);
  const cases = {
    'empty stdin': {},
    'minimal': { model: { display_name: 'Sonnet 5' } },
    'no upstream repo': { model: { id: 'claude-opus-4-8[1m]', display_name: 'Opus 4.8' }, context_window: { used_percentage: 5 } },
    'full': {
      workspace: { current_dir: '/tmp/x', project_dir: '/tmp/x' },
      model: { id: 'claude-opus-4-8[1m]', display_name: 'Opus 4.8 (1M context)' },
      effort: { level: 'xhigh' }, context_window: { used_percentage: 99 },
      fast_mode: false, thinking: { enabled: false },
      rate_limits: { five_hour: { used_percentage: 10, resets_at: now + 3600 }, seven_day: { used_percentage: 50, resets_at: now + 3 * 86400 } },
    },
    'near-limit': {
      model: { display_name: 'Sonnet 5' },
      rate_limits: { five_hour: { used_percentage: 96, resets_at: now + 900 }, seven_day: { used_percentage: 40, resets_at: now + 4 * 86400 } },
    },
    'cjk names': {
      workspace: { current_dir: '/tmp/日本語プロジェクト', project_dir: '/tmp/日本語プロジェクト' },
      model: { display_name: 'Opus 4.8' }, session_name: '中文会话名称一二三四五六七八',
      context_window: { used_percentage: 30 },
    },
  };
  let ok = true;
  for (const [name, input] of Object.entries(cases)) {
    for (const w of [140, 60, 30]) {
      try {
        const r = render(input, w, '');
        let wrapBug = false, tooWide = false;
        for (const l of r.split('\n')) {
          if (dispWidth(l) > w) {
            tooWide = true;
            if (l.replace(/\x1b\[[0-9;]*m/g, '').includes('│')) wrapBug = true;
          }
        }
        const tag = wrapBug ? 'FAIL' : tooWide ? 'note' : 'ok  ';
        process.stdout.write(`${tag}  ${name} @${w}${tooWide && !wrapBug ? ' (unsplittable segment: expected)' : ''}\n`);
        if (wrapBug) ok = false;
      } catch (e) { process.stdout.write(`FAIL  ${name} @${w}: ${e.message}\n`); ok = false; }
    }
  }
  process.stdout.write(ok ? '\nAll self-tests passed.\n' : '\nSome self-tests failed.\n');
  process.exit(ok ? 0 : 1);
}

// ---- interactive config editor: toggle segments, live preview, save ----
// keep only what differs from DEFAULTS, so persisting config doesn't freeze every default
// value against future updates (arrays are atomic: kept only if not deep-equal).
function diffFromDefaults(cur, def) {
  if (Array.isArray(def) || Array.isArray(cur)) return JSON.stringify(cur) === JSON.stringify(def) ? undefined : clone(cur);
  if (def && typeof def === 'object' && cur && typeof cur === 'object') {
    const out = {};
    for (const k of Object.keys(cur)) { const d = diffFromDefaults(cur[k], k in def ? def[k] : undefined); if (d !== undefined) out[k] = d; }
    return Object.keys(out).length ? out : undefined;
  }
  return cur === def ? undefined : clone(cur);
}
function saveConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
    // persist only overrides, never a full snapshot, so future default changes still reach the user
    const sparse = diffFromDefaults(CONFIG, DEFAULTS) || {};
    if (!writeJsonAtomic(CONFIG_PATH, sparse)) throw new Error('could not save ' + CONFIG_PATH + '; it was left unchanged');
    JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); // validate round-trip
    return true;
  } catch (e) { process.stdout.write(`save failed: ${e.message}\n`); return false; }
}
async function runConfigEditor() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  // buffer lines so none are lost when a piped stdin delivers them faster than we ask
  const queue = [], waiters = [];
  let closed = false;
  rl.on('line', (l) => { const w = waiters.shift(); if (w) w(l); else queue.push(l); });
  rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(''); });
  const ask = (q) => new Promise((res) => {
    process.stdout.write(q);
    if (queue.length) return res(queue.shift());
    if (closed) return res('');
    waiters.push(res);
  });
  const order = Array.isArray(CONFIG.order) ? CONFIG.order : DEFAULT_ORDER;
  while (true) {
    let out = '\n\x1b[1mstatusline config\x1b[0m   (edits go to statusline.config.json)\n\n';
    out += 'Preview:\n  ' + render(demoInput(), 96, DEMO_GIT()).split('\n').join('\n  ') + '\n\nSegments:\n';
    order.forEach((n, i) => {
      const v = CONFIG.show[n];
      const box = (v === false) ? '[ ]' : '[x]';
      out += `  ${String(i + 1).padStart(2)}) ${box} ${n}${n === 'profile' ? ` (mode: ${v})` : ''}\n`;
    });
    out += `\n   m) mode: ${CONFIG.mode}  (minimal / normal / expanded)\n`;
    out += `   r) reset-time style: ${CONFIG.resetStyle}\n   s) save & quit    q) quit without saving\n`;
    if (CONFIG.mode !== 'normal') out += `   note: mode is ${CONFIG.mode}, so the segment toggles above only take effect in normal mode.\n`;
    process.stdout.write(out);
    const a = (await ask('\n> ')).trim().toLowerCase();
    if (a === 'q' || a === '') { process.stdout.write('No changes saved.\n'); break; }
    if (a === 's') { if (saveConfig()) process.stdout.write(`Saved → ${CONFIG_PATH}\n`); break; }
    if (a === 'm') { CONFIG.mode = MODES[(MODES.indexOf(CONFIG.mode) + 1) % MODES.length]; continue; }
    if (a === 'r') { CONFIG.resetStyle = CONFIG.resetStyle === 'clock' ? 'relative' : 'clock'; continue; }
    if (/^\d+$/.test(a)) {
      const n = order[parseInt(a, 10) - 1];
      if (!n) { process.stdout.write('No such segment.\n'); continue; }
      if (n === 'profile') CONFIG.show.profile = CONFIG.show.profile === 'auto' ? true : (CONFIG.show.profile === true ? false : 'auto');
      else CONFIG.show[n] = !CONFIG.show[n];
      continue;
    }
    process.stdout.write('Enter a segment number, r, s, or q.\n');
  }
  rl.close();
  process.exit(0);
}

// strict unknown-flag rejection: a typo like `--instal` should error, not silently render a bar.
// Claude Code always invokes with argv.length===0, so this never runs on the render hot path (C3).
if (argv.some((a) => a.startsWith('--'))) {
  const KNOWN = new Set(['--install', '--install-guardian', '--uninstall', '--uninstall-guardian', '--doctor', '--mode', '--autopilot', '--keep-working', '--board', '--sessions', '--status', '--disarm', '--purge', '--update', '--check-update', '--whatsnew', '--dismiss-update', '--options', '--config', '--demo', '--selftest', '--version', '--help', '--cols', '--this-profile', '--auto', '--force', '--hook', '--watch']);
  const unknown = argv.find((a) => a.startsWith('--') && !KNOWN.has(a));
  if (unknown) { process.stdout.write('unknown flag: ' + unknown + '\nRun  node "' + __filename + '" --help  for the flag list.\n'); process.exit(1); }
}

// ===========================================================================
// normal path: Claude Code pipes the status JSON on stdin
// ===========================================================================
if (!argv.includes('--config')) {
  if (process.stdin.isTTY) {
    // a human ran this bare in a terminal: don't block on stdin, show help
    process.stdout.write(helpText());
    process.exit(0);
  }
  try {
    let input = {};
    try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}
    // JSON.parse('null')/'42'/'[]' all succeed and overwrite the {} fallback; render() reads
    // input.workspace etc, so coerce anything that is not a plain object back to {}.
    if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
    process.stdout.write(render(input, getWidth() - CONFIG.reserveCols));
  } catch (e) {
    // the status line must never die silently: leave a trail and a next step
    try { fs.writeFileSync(path.join(CFG, 'statusline-error.log'), new Date().toISOString() + '\n' + (e.stack || e.message) + '\n'); } catch {}
    process.stdout.write(c(K.dim, 'statusline error: run node statusline.js --doctor'));
  }
}
