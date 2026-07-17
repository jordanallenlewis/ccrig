#!/usr/bin/env node
/*
 * Claude Code status line: a terminal command center
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
 * (rate_limits, context_window, effort, fast_mode, thinking), so it's
 * ZERO-network (no token, no keychain, no 429s, always fresh). Plus: wrapping
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
 * CUSTOMIZE: run `node statusline.js --config` for an interactive editor, or
 * hand-edit `statusline.config.json` next to this file (see statusline.config.example.json).
 * Your config lives in that separate file, so updating this script never wipes it.
 *
 * CLI (manual only: Claude Code calls this with JSON on stdin and no args):
 *   node statusline.js --install            wire Claude Code to this file (backs up settings)
 *   node statusline.js --uninstall          remove the status line from settings
 *   node statusline.js --doctor             diagnose a broken or missing status line
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

const VERSION = '1.1.0';

// ===========================================================================
// DEFAULTS: generic, safe for anyone. Override in statusline.config.json
// (next to this file); your overrides deep-merge over these and survive updates.
// ===========================================================================
const DEFAULT_ORDER = ['profile', 'folder', 'model', 'effort', 'flags', 'context', 'git', 'caveman', 'billing', 'session', 'weekly', 'resumeHint', 'cost', 'sessionName'];
const DEFAULTS = {
  order: DEFAULT_ORDER,
  show: {
    profile: 'auto',    // 👤 active Claude profile. 'auto' = only when >1 profile exists; true = always; false = never
    folder: true,       // 📂 current project (repo-relative)
    model: true,        // ★ model name + [1m] on a 1M-context model
    effort: true,       // ⚡ reasoning effort (low…max)
    flags: true,        // fast (when on) / no-think (when thinking is off)
    context: true,      // ctx: color-coded context-window bar
    git: true,          // 🌿 branch ●uncommitted ↑unpushed ↓unpulled
    caveman: true,      // [CAVEMAN] badge if the caveman plugin is active
    billing: true,      // 💳 sub (Claude.ai subscription) vs api (pay-per-token)
    session: true,      // 5-hour plan-usage bar + reset time
    weekly: true,       // 7-day plan-usage bar + reset time
    resumeHint: true,   // ⚠ shown only past thresholds.usage.warn: how to pick back up after reset
    cost: false,        // session $ + lines +added/-removed
    sessionName: false, // the session's title
  },
  thresholds: {
    context: { green: 50, yellow: 70 }, // % filled → color
    usage: { green: 50, yellow: 80, warn: 90, critical: 98 }, // warn: ⚠ + resumeHint; critical: resume ticket
  },
  resetStyle: 'clock',  // 'clock' (10:40a, dated if not today) | 'relative' (2h14m)
  resumeTickets: true,  // at critical usage, save resume-tickets/<session>.md with the exact pick-up command
  gitCacheMs: 2500,     // cache git state this long so big repos don't slow each render (0 = off)
  reserveCols: 1,       // safety margin subtracted from terminal width
  // Map a Claude config-dir name to a profile label. Unlisted dirs derive their
  // label from the name (e.g. .claude-work -> "work"). Leave {} for pure auto.
  profileLabels: {},
  // 256-color codes: https://www.ditig.com/256-colors-cheat-sheet
  color: {
    dim: 245, folder: 75, model: 111, effort: 179, flag: 45, caveman: 172,
    green: 78, yellow: 214, red: 203, sky: 75,
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
  if (!Array.isArray(merged.order) || !merged.order.length) merged.order = clone(DEFAULT_ORDER);
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

// display width: strip ANSI, count emoji / wide glyphs as 2 cells
function dispWidth(s) {
  s = s.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === 0xFE0F || cp === 0x200D) continue;               // variation selector / ZWJ = 0
    if (cp >= 0x1F000 || cp === 0x26A1 || cp === 0x2600 || cp === 0x26A0) w += 2; // emoji + ⚡ ☀ ⚠
    else w += 1;
  }
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

// color-coded block bar
function bar(pct, width, t) {
  pct = Math.max(0, Math.min(100, pct));
  const filled = Math.round((pct / 100) * width);
  const col = pct <= t.green ? K.green : pct <= t.yellow ? K.yellow : K.red;
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

// truncate a folder path (keep the tail: the most specific dir) to fit
function truncFolder(f, max) {
  if (max < 2 || f.length <= max) return f;
  return '…' + f.slice(-(max - 1));
}

// reset time: absolute clock (dated when not today) or relative countdown
function fmtReset(epochSec) {
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
  let h = d.getHours(); const m = d.getMinutes();
  const ap = h >= 12 ? 'p' : 'a'; h = h % 12 || 12;
  const clock = `${h}:${String(m).padStart(2, '0')}${ap}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? clock : `${d.getMonth() + 1}/${d.getDate()} ${clock}`;
}
const cBold = (n, s) => `\x1b[1m\x1b[38;5;${n}m${s}\x1b[0m`;
function warnAtOf(t) { return t.warn != null ? t.warn : 90; }
const usageSeg = (label, pct, reset) => {
  const t = CONFIG.thresholds.usage;
  const near = pct >= warnAtOf(t);
  const lbl = near ? cBold(K.red, '⚠ ' + label) : c(K.dim, label);
  const val = near ? cBold(K.red, Math.round(pct) + '%') : c(K.dim, Math.round(pct) + '%');
  return `${lbl} ${bar(pct, 8, t)} ${val}` + (reset ? c(K.dim, ' ↺' + fmtReset(reset)) : '');
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
      'Project: ' + cwd,
      '',
      'Pick up exactly where you left off:',
      '',
      '    cd "' + cwd + '"',
      '    claude --resume ' + sid,
      '',
      'Or run `claude --continue` in that directory for its most recent session.',
      '',
    ].join('\n'));
    for (const f of fs.readdirSync(dir)) { // keep the drawer tidy: 14-day retention
      try { const p = path.join(dir, f); if (Date.now() - fs.statSync(p).mtimeMs > 14 * 86400 * 1000) fs.unlinkSync(p); } catch {}
    }
    return true;
  } catch { return false; }
}

// Shown once session OR weekly usage crosses thresholds.usage.warn. Escalates at
// critical: the resume ticket is written and the hint names it.
function resumeHintSeg(input, sPct, wPct, sReset, wReset) {
  const t = CONFIG.thresholds.usage;
  const warnAt = warnAtOf(t);
  const critAt = t.critical != null ? t.critical : 98;
  const worst = Math.max(sPct != null ? sPct : -1, wPct != null ? wPct : -1);
  if (worst < warnAt) return '';
  if (CONFIG.resumeTickets !== false && worst >= critAt) {
    const which = (sPct != null && sPct >= critAt) ? 'session' : 'weekly';
    const saved = writeResumeTicket(input, worst, which, which === 'session' ? sReset : wReset);
    return cBold(K.red, '⚠ limit imminent') +
      c(K.dim, saved ? ': resume ticket saved, pick up with ' : ': resume with ') + c(K.yellow, 'claude --resume');
  }
  return cBold(K.red, '⚠ near limit') + c(K.dim, ': auto-saved, resume with ') + c(K.yellow, 'claude --continue');
}

// context %: prefer Claude Code's own number, fall back to the transcript tail
function contextPct(input) {
  const cw = input.context_window;
  if (cw && typeof cw.used_percentage === 'number') return Math.round(cw.used_percentage);
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

// how many Claude profiles exist on this machine (~/.claude + ~/.claude-*)
function claudeProfileCount() {
  try {
    let n = 0;
    for (const e of fs.readdirSync(HOME)) {
      if (e === '.claude' || e.startsWith('.claude-')) {
        try { if (fs.statSync(path.join(HOME, e)).isDirectory() && ++n >= 2) return n; } catch {}
      }
    }
    return n;
  } catch { return 1; }
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
    out = execSync('git status --porcelain=v2 --branch', { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 700, encoding: 'utf8' });
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

  const cwd = (input.workspace && input.workspace.current_dir) || input.cwd || process.cwd();
  const projectDir = (input.workspace && input.workspace.project_dir) || cwd;
  let folder = path.basename(projectDir || cwd);
  if (cwd && projectDir && cwd !== projectDir && cwd.startsWith(projectDir)) folder += cwd.slice(projectDir.length);
  out.folder = `\u{1F4C2} ${c(K.folder, truncFolder(folder, width - 4))}`;

  let model = (input.model && input.model.display_name) || (input.model && input.model.id) || 'Claude';
  model = model.replace(/\s*\(1M context\)/i, '').trim();
  const oneM = /\[?1m\]?/i.test(((input.model && input.model.id) || '') + ' ' + (settingsVal('model') || ''));
  out.model = `${c(K.dim, '★')} ${c(K.model, model)}${oneM ? c(K.dim, ' [1m]') : ''}`;

  const effort = effortLevel(input);
  out.effort = effort ? c(K.effort, '⚡' + effort) : '';

  const flags = [];
  if (input.fast_mode) flags.push(c(K.flag, 'fast'));
  if (input.thinking && input.thinking.enabled === false) flags.push(c(K.yellow, 'no-think'));
  out.flags = flags.join(' ');

  const ctx = contextPct(input);
  out.context = ctx != null ? `${c(K.dim, 'ctx')} ${bar(ctx, 10, CONFIG.thresholds.context)} ${c(K.dim, ctx + '%')}` : '';

  out.git = gitOverride != null ? gitOverride : gitSeg(cwd);
  out.caveman = cavemanBadge();
  out.billing = billingSeg(input);

  const rl = input.rate_limits || {};
  const pctOf = (o) => (o && typeof o.used_percentage === 'number') ? o.used_percentage : null;
  const resetOf = (o) => (o && typeof o.resets_at === 'number') ? o.resets_at : null;
  const sPct = pctOf(rl.five_hour), wPct = pctOf(rl.seven_day);
  out.session = sPct != null ? usageSeg('session', sPct, resetOf(rl.five_hour)) : '';
  out.weekly = wPct != null ? usageSeg('weekly', wPct, resetOf(rl.seven_day)) : '';
  out.resumeHint = resumeHintSeg(input, sPct, wPct, resetOf(rl.five_hour), resetOf(rl.seven_day));

  const cost = input.cost;
  if (cost && typeof cost.total_cost_usd === 'number') {
    let s = c(K.dim, '$' + cost.total_cost_usd.toFixed(2));
    if (cost.total_lines_added || cost.total_lines_removed) {
      s += ' ' + c(K.green, '+' + (cost.total_lines_added || 0)) + c(K.dim, '/') + c(K.red, '-' + (cost.total_lines_removed || 0));
    }
    out.cost = s;
  } else out.cost = '';

  const name = input.session_name;
  out.sessionName = name ? c(K.dim, name.length > 28 ? name.slice(0, 27) + '…' : name) : '';

  const order = Array.isArray(CONFIG.order) ? CONFIG.order : DEFAULT_ORDER;
  return order.filter((n) => S[n] && out[n]).map((n) => out[n]);
}

function render(input, width, gitOverride) {
  return wrapSegments(collectSegments(input, width, gitOverride), width);
}

// representative sample input for --demo / --config preview
function demoInput() {
  const now = Math.floor(Date.now() / 1000);
  return {
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

function helpText() {
  return [
    'claude-code-statusline v' + VERSION,
    'Claude Code calls this automatically (JSON on stdin). Manual commands:',
    '  --install           wire Claude Code to this file (backs up settings.json first)',
    '  --uninstall         remove the status line from settings.json',
    '  --doctor            diagnose a broken or missing status line',
    '  --config            interactive editor (toggle segments, live preview, save)',
    '  --demo [--cols N]    preview with sample data',
    '  --selftest          run edge-case render checks',
    '  --version           print the version',
    '  --help              this text',
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
  process.stdout.write('claude-code-statusline v' + VERSION + '\n');
  process.exit(0);
}

// ---- push-button install: wire settings.json to this file, backup first ----
function settingsPathOf() { return path.join(CFG, 'settings.json'); }
function isPlainObject(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
// state: 'missing' | 'invalid' (unparseable) | 'notObject' (an array/number/null) | 'ok'
function readSettingsRaw() {
  const sp = settingsPathOf();
  if (!fs.existsSync(sp)) return { state: 'missing', value: null };
  let v;
  try { v = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch { return { state: 'invalid', value: null }; }
  return isPlainObject(v) ? { state: 'ok', value: v } : { state: 'notObject', value: null };
}
function backupSettings() {
  const sp = settingsPathOf();
  if (fs.existsSync(sp)) { fs.copyFileSync(sp, sp + '.bak'); return sp + '.bak'; }
  return null;
}
function runInstall() {
  try {
    fs.mkdirSync(CFG, { recursive: true });
    const sp = settingsPathOf();
    const raw = readSettingsRaw();
    if (raw.state === 'invalid') {
      process.stdout.write('!! ' + sp + ' exists but is not valid JSON. Fix it first (or delete it), then re-run --install.\n');
      process.exit(1);
    }
    if (raw.state === 'notObject') {
      process.stdout.write('!! ' + sp + ' parses but is not a JSON object (an array or a bare value). Fix it first, then re-run --install.\n');
      process.exit(1);
    }
    const settings = raw.value || {};
    const bak = backupSettings();
    // process.execPath = the node running this installer: absolute, exists, cross-platform
    settings.statusLine = {
      type: 'command',
      command: `"${process.execPath}" "${__filename}"`,
      refreshInterval: 2,
    };
    fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n');
    JSON.parse(fs.readFileSync(sp, 'utf8')); // round-trip validate
    process.stdout.write('ok  status line wired in ' + sp + (bak ? '\nok  previous settings backed up to ' + bak : '') + '\n');
    const helper = path.join(__dirname, 'claude-profiles.sh');
    if (fs.existsSync(helper)) {
      process.stdout.write('--  multiple Claude accounts? add to your shell rc:  source "' + helper + '"\n');
    }
    process.stdout.write('\nRestart Claude Code once. After that, edits to this file apply live.\n');
    process.stdout.write('Preview now:  node "' + __filename + '" --demo\n');
    process.exit(0);
  } catch (e) {
    process.stdout.write('install failed: ' + e.message + '\n');
    process.exit(1);
  }
}
function runUninstall() {
  try {
    const sp = settingsPathOf();
    const raw = readSettingsRaw();
    if (raw.state !== 'ok' || !raw.value.statusLine) {
      process.stdout.write('nothing to remove: no statusLine in ' + sp + '\n');
      process.exit(0);
    }
    const settings = raw.value;
    const bak = backupSettings();
    delete settings.statusLine;
    fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n');
    process.stdout.write('ok  statusLine removed from ' + sp + (bak ? ' (backup: ' + bak + ')' : '') + '\n');
    process.stdout.write('--  this file and statusline.config.json were left in place; delete them if you want.\n');
    process.exit(0);
  } catch (e) {
    process.stdout.write('uninstall failed: ' + e.message + '\n');
    process.exit(1);
  }
}

// ---- doctor: diagnose the failure modes users actually hit ----
function runDoctor() {
  let fails = 0;
  const ok = (m) => process.stdout.write('  ok    ' + m + '\n');
  const bad = (m, fix) => { fails++; process.stdout.write('  FAIL  ' + m + (fix ? '\n        fix: ' + fix : '') + '\n'); };
  const info = (m) => process.stdout.write('  --    ' + m + '\n');
  process.stdout.write('claude-code-statusline v' + VERSION + ' doctor\n');
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
      if (!cmd.includes(__filename)) info('statusLine points at a different script: ' + cmd);
      // check every quoted absolute path in the command (node binary AND script);
      // non-path tokens (sh -c bodies, env values) are ignored on purpose
      const pathish = [...cmd.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((t) => path.isAbsolute(t));
      const missing = pathish.filter((t) => !fs.existsSync(t));
      if (missing.length) bad('path(s) in the statusLine command do not exist: ' + missing.join(', ') + ' (moved? node upgrade?)', 're-run: node "' + __filename + '" --install');
      else if (pathish.length) ok('command paths exist (' + pathish.length + ' checked)');
      else info('no quoted absolute paths in the command to check');
      if (sl.refreshInterval) ok('refreshInterval: ' + sl.refreshInterval + 's'); else info('refreshInterval not set: bars update only on session events');
    }
  }
  if (fs.existsSync(CONFIG_PATH)) {
    try { JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); ok('statusline.config.json parses'); }
    catch (e) { bad('statusline.config.json is invalid JSON (' + e.message + '); defaults are in use', 'fix it or delete it'); }
  } else info('no statusline.config.json: defaults in use (customize with --config)');
  try { execSync('git --version', { stdio: 'ignore', timeout: 2000 }); ok('git found'); }
  catch { info('git not found: the git segment stays hidden'); }
  try { render(demoInput(), 80, DEMO_GIT()); ok('test render'); }
  catch (e) { bad('rendering throws: ' + e.message, 'update this file, or report it'); }
  const elog = path.join(CFG, 'statusline-error.log');
  if (fs.existsSync(elog)) info('a previous run errored; see ' + elog + ' (delete it to clear this note)');

  process.stdout.write(fails ? '\n' + fails + ' problem(s) found.\n' : '\nAll checks passed.\n');
  process.exit(fails ? 1 : 0);
}

// one mode at a time: silently ignoring the second flag misleads the user
const EXCLUSIVE = ['--install', '--uninstall', '--doctor', '--config', '--demo', '--selftest'];
const picked = EXCLUSIVE.filter((m) => argv.includes(m));
if (picked.length > 1) {
  process.stdout.write('pick one of: ' + picked.join(', ') + '\n');
  process.exit(1);
}

if (argv.includes('--install')) runInstall();
if (argv.includes('--uninstall')) runUninstall();
if (argv.includes('--doctor')) {
  try { runDoctor(); } catch (e) { process.stdout.write('doctor crashed: ' + e.message + '\n'); process.exit(1); }
}

if (argv.includes('--demo')) {
  const ci = argv.indexOf('--cols');
  const cols = ci >= 0 ? parseInt(argv[ci + 1], 10) : null;
  const demo = demoInput();
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
function saveConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2) + '\n');
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
    out += `\n   r) reset-time style: ${CONFIG.resetStyle}\n   s) save & quit    q) quit without saving\n`;
    process.stdout.write(out);
    const a = (await ask('\n> ')).trim().toLowerCase();
    if (a === 'q' || a === '') { process.stdout.write('No changes saved.\n'); break; }
    if (a === 's') { if (saveConfig()) process.stdout.write(`Saved → ${CONFIG_PATH}\n`); break; }
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
    process.stdout.write(render(input, getWidth() - CONFIG.reserveCols));
  } catch (e) {
    // the status line must never die silently: leave a trail and a next step
    try { fs.writeFileSync(path.join(CFG, 'statusline-error.log'), new Date().toISOString() + '\n' + (e.stack || e.message) + '\n'); } catch {}
    process.stdout.write(c(K.dim, 'statusline error: run node statusline.js --doctor'));
  }
}
