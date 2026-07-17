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
 * ---------------------------------------------------------------------------
 * SETUP (macOS / Linux / Windows):
 *   1. Save this file somewhere (e.g. ~/.claude/statusline.js).
 *   2. In ~/.claude/settings.json add:
 *        "statusLine": { "type": "command", "command": "node \"/ABSOLUTE/PATH/statusline.js\"" }
 *      Use an absolute node path if `node` isn't on the status line's PATH.
 *   3. Restart Claude Code once. Edits apply live afterward.
 *
 * CUSTOMIZE: run `node statusline.js --config` for an interactive editor, or
 * hand-edit `statusline.config.json` next to this file (see statusline.config.example.json).
 * Your config lives in that separate file, so updating this script never wipes it.
 *
 * CLI (manual only: Claude Code calls this with JSON on stdin and no args):
 *   node statusline.js --config            interactive segment/preview editor
 *   node statusline.js --demo [--cols N]    render sample data (great for screenshots)
 *   node statusline.js --selftest           sanity-check rendering on edge inputs
 *   node statusline.js --help
 */

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// ===========================================================================
// DEFAULTS: generic, safe for anyone. Override in statusline.config.json
// (next to this file); your overrides deep-merge over these and survive updates.
// ===========================================================================
const DEFAULT_ORDER = ['profile', 'folder', 'model', 'effort', 'flags', 'context', 'git', 'caveman', 'billing', 'session', 'weekly', 'cost', 'sessionName'];
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
    cost: false,        // session $ + lines +added/-removed
    sessionName: false, // the session's title
  },
  thresholds: {
    context: { green: 50, yellow: 70 }, // % filled → color
    usage: { green: 50, yellow: 80 },
  },
  resetStyle: 'clock',  // 'clock' (10:40a, dated if not today) | 'relative' (2h14m)
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
  try { return deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); }
  catch { return clone(DEFAULTS); }
}
let CONFIG = loadConfig();

// ===========================================================================
// low-level helpers
// ===========================================================================
const HOME = os.homedir();
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
    if (cp >= 0x1F000 || cp === 0x26A1 || cp === 0x2600) w += 2; // emoji + ⚡ ☀
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
const usageSeg = (label, pct, reset) =>
  `${c(K.dim, label)} ${bar(pct, 8, CONFIG.thresholds.usage)} ${c(K.dim, Math.round(pct) + '%')}` +
  (reset ? c(K.dim, ' ↺' + fmtReset(reset)) : '');

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
      seven_day: { used_percentage: 88, resets_at: now + 5 * 86400 },
    },
  };
}
const DEMO_GIT = () => `\u{1F33F} ${c(K.green, 'main')} ${c(K.yellow, '●3')} ${c(K.yellow, '↑1')}`;

// ===========================================================================
// CLI modes (manual only: Claude Code passes JSON on stdin with no args)
// ===========================================================================
const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write([
    'Claude Code status line.',
    'Claude Code calls this automatically (JSON on stdin). Manual commands:',
    '  --config            interactive editor (toggle segments, live preview, save)',
    '  --demo [--cols N]    preview with sample data',
    '  --selftest          run edge-case render checks',
    '  --help              this text',
    '',
    'Config lives in statusline.config.json next to this file',
    '(see statusline.config.example.json). Updating the script never wipes it.',
    '',
  ].join('\n'));
  process.exit(0);
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
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}
  process.stdout.write(render(input, getWidth() - CONFIG.reserveCols));
}
