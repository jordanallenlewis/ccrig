#!/usr/bin/env node
/*
 * Claude Code status line — a terminal command center
 * ---------------------------------------------------------------------------
 * CREDIT: This was kickstarted by Hannah Stulberg's guide
 *   "Claude Code for Everything: Your Status Line Is Empty (Let's Fix That)"
 *   (In the Weeds) — https://hannahstulberg.substack.com/p/claude-code-for-everything-your-status-line-is-empty
 *
 * Reused from that article: the status-line-as-command-center idea; the
 * color-coded context bar with green<50 / yellow<70 / red thresholds; the
 * folder + model + git + plan-usage segments; and the portable
 * "write it as a Node script at ~/.claude/statusline.js" approach (edits apply
 * live, works the same on Windows).
 *
 * Enhanced here (what's different): every value comes from Claude Code's OWN
 * stdin JSON (rate_limits, context_window, effort, fast_mode, thinking) — so
 * this is ZERO-network: no OAuth token, no keychain read, no /api/oauth/usage
 * call, no 429s, always fresh. Plus: line-wrapping that tracks live terminal
 * resize; an effort segment; inference-mode flags (fast / no-think);
 * unpushed/unpulled commits vs upstream; date-aware limit-reset times; one
 * script serving multiple Claude profiles via CLAUDE_CONFIG_DIR; and a single
 * git call per render.
 * ---------------------------------------------------------------------------
 * SETUP (Mac / Linux / Windows):
 *   1. Save this file (e.g. ~/.claude/statusline.js).
 *   2. In ~/.claude/settings.json add:
 *        "statusLine": {
 *          "type": "command",
 *          "command": "node \"/ABSOLUTE/PATH/TO/statusline.js\""
 *        }
 *      If `node` isn't found when the status line runs, use an absolute node
 *      path (e.g. the output of `which node` / `where node`).
 *   3. Restart Claude Code once. After that, edits to this file apply live.
 *
 * CUSTOMIZE: edit the CONFIG block below — toggle segments, tune thresholds,
 * change colors (256-color codes: https://www.ditig.com/256-colors-cheat-sheet).
 *
 * PREVIEW / TEST (these run only when you invoke the file by hand; Claude Code
 * always calls it with JSON on stdin and no args):
 *   node statusline.js --demo [--cols N]   render sample data (great for screenshots)
 *   node statusline.js --selftest          sanity-check rendering on edge inputs
 *   node statusline.js --help
 */

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// ===========================================================================
// CONFIG — the "make it yours" block
// ===========================================================================
const CONFIG = {
  // Segments render in this order; flip any to false to hide it.
  show: {
    folder: true,       // 📂 current project (repo-relative)
    model: true,        // ★ model name + [1m] when on a 1M-context model
    effort: true,       // ⚡ reasoning effort (low…max)
    flags: true,        // fast (when on) / no-think (when thinking is off)
    context: true,      // ctx: color-coded context-window bar
    git: true,          // 🌿 branch ●uncommitted ↑unpushed ↓unpulled
    caveman: true,      // [CAVEMAN] badge if the caveman plugin is active
    session: true,      // 5-hour plan-usage bar + reset time
    weekly: true,       // 7-day plan-usage bar + reset time
    cost: false,        // session $ + lines +added/-removed (off by default)
    sessionName: false, // the session's title (off by default)
  },
  thresholds: {
    context: { green: 50, yellow: 70 }, // % filled → color
    usage: { green: 50, yellow: 80 },
  },
  resetStyle: 'clock',  // 'clock' (10:40a, dated if not today) | 'relative' (2h14m)
  reserveCols: 1,       // safety margin subtracted from terminal width
  // 256-color codes (see cheat sheet linked above)
  color: {
    dim: 245, folder: 75, model: 111, effort: 179, flag: 45, caveman: 172,
    green: 78, yellow: 214, red: 203, sky: 75,
  },
};

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
    if (cp === 0xFE0F || cp === 0x200D) continue;              // variation selector / ZWJ = 0
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

// live terminal width — COLUMNS (Claude Code re-passes it on every resize) first;
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

// truncate a folder path (keep the tail — the most specific dir) to fit
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

// caveman plugin badge — preserved so this composes with existing tooling
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

// git: branch + uncommitted + ahead/behind, in ONE call (porcelain v2 + --branch)
function gitSeg(cwd) {
  let out;
  try {
    out = execSync('git status --porcelain=v2 --branch', { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 700, encoding: 'utf8' });
  } catch { return ''; }
  let branch = '', ahead = 0, behind = 0, dirty = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice(14).trim();
    else if (line.startsWith('# branch.ab ')) {
      const ab = line.slice(12).trim().split(/\s+/);
      ahead = Math.abs(parseInt(ab[0], 10)) || 0;
      behind = Math.abs(parseInt(ab[1], 10)) || 0;
    } else if (line && !line.startsWith('#')) dirty++;
  }
  if (!branch) return '';
  if (branch === '(detached)') branch = 'detached';
  const parts = [c(K.green, branch)];
  if (dirty > 0) parts.push(c(K.yellow, '●' + dirty));
  if (ahead > 0) parts.push(c(K.yellow, '↑' + ahead));
  if (behind > 0) parts.push(c(K.sky, '↓' + behind));
  return `\u{1F33F} ${parts.join(' ')}`;
}

// ===========================================================================
// build the ordered segment list from one input object
//   `gitOverride` lets --demo / --selftest inject a git string instead of shelling out
// ===========================================================================
function collectSegments(input, width, gitOverride) {
  const S = CONFIG.show;
  const out = {};

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

  // emit in CONFIG order, dropping disabled or empty
  const order = ['folder', 'model', 'effort', 'flags', 'context', 'git', 'caveman', 'session', 'weekly', 'cost', 'sessionName'];
  return order.filter((n) => S[n] && out[n]).map((n) => out[n]);
}

function render(input, width, gitOverride) {
  return wrapSegments(collectSegments(input, width, gitOverride), width);
}

// ===========================================================================
// CLI modes (manual only — Claude Code passes JSON on stdin with no args)
// ===========================================================================
const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write([
    'Claude Code status line.',
    'Usage (Claude Code calls this automatically with JSON on stdin):',
    '  in ~/.claude/settings.json → statusLine.command = node <this file>',
    '',
    'Manual:',
    '  --demo [--cols N]   preview with sample data',
    '  --selftest          run edge-case render checks',
    '  --help              this text',
    '',
    'Customize the CONFIG block at the top of the file.',
    '',
  ].join('\n'));
  process.exit(0);
}

if (argv.includes('--demo')) {
  const ci = argv.indexOf('--cols');
  const cols = ci >= 0 ? parseInt(argv[ci + 1], 10) : null;
  const now = Math.floor(Date.now() / 1000);
  const demo = {
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
  const fakeGit = `\u{1F33F} ${c(K.green, 'main')} ${c(K.yellow, '●7')} ${c(K.yellow, '↑2')}`;
  const widths = cols ? [cols] : [120, 80, 50];
  for (const w of widths) {
    process.stdout.write(`\n\x1b[2m── ${w} cols ──\x1b[0m\n`);
    process.stdout.write(render(demo, w - CONFIG.reserveCols, fakeGit) + '\n');
  }
  process.stdout.write('\n');
  process.exit(0);
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
            // a line wider than the terminal is only a BUG if it still holds a
            // separator (wrap could have broken it); a lone unsplittable segment is fine
            if (l.replace(/\x1b\[[0-9;]*m/g, '').includes('│')) wrapBug = true;
          }
        }
        const tag = wrapBug ? 'FAIL' : tooWide ? 'note' : 'ok  ';
        process.stdout.write(`${tag}  ${name} @${w}${tooWide && !wrapBug ? ' (unsplittable segment — expected)' : ''}\n`);
        if (wrapBug) ok = false;
      } catch (e) { process.stdout.write(`FAIL  ${name} @${w}: ${e.message}\n`); ok = false; }
    }
  }
  process.stdout.write(ok ? '\nAll self-tests passed.\n' : '\nSome self-tests failed.\n');
  process.exit(ok ? 0 : 1);
}

// ===========================================================================
// normal path: Claude Code pipes the status JSON on stdin
// ===========================================================================
let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}
process.stdout.write(render(input, getWidth() - CONFIG.reserveCols));
