#!/usr/bin/env node
/*
 * Test suite for ccrig. Zero dependencies: Node's built-in
 * test runner (node:test, Node 18+). Run:
 *   node --test test.js        (or: node test.js)
 *
 * Every test runs the real script as a subprocess against a throwaway
 * CLAUDE_CONFIG_DIR / HOME sandbox, so nothing here touches your real
 * ~/.claude or settings. The regression tests at the bottom encode real bugs
 * found by adversarial review; keep them passing.
 */

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const NODE = process.execPath;

// every sandbox lives under one scratch root, removed at the end
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-test-'));
test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

// TEST-01: a suite-owned tmp dir. run() points the child's TMPDIR/TEMP/TMP here, so the
// product's tmp reads/writes and --purge sweeps never touch the developer's real os.tmpdir().
const TESTTMP = path.join(ROOT, 'tmp');
fs.mkdirSync(TESTTMP, { recursive: true });

// TEST-02: run against a clean copy of the script OUTSIDE the repo checkout, so a
// statusline.config.json (or a dogfooded install) in the repo dir can't change test behavior.
// CHANGELOG.md is copied alongside because --whatsnew reads it next to the script.
const CLEAN = path.join(ROOT, 'clean');
fs.mkdirSync(CLEAN, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'statusline.js'), path.join(CLEAN, 'statusline.js'));
try { fs.copyFileSync(path.join(__dirname, 'CHANGELOG.md'), path.join(CLEAN, 'CHANGELOG.md')); } catch {}
const SCRIPT = path.join(CLEAN, 'statusline.js');

let n = 0;
function sandbox() {
  const dir = path.join(ROOT, 'sb' + (++n));
  fs.mkdirSync(path.join(dir, 'home', '.claude'), { recursive: true });
  return { home: path.join(dir, 'home'), cfg: path.join(dir, 'home', '.claude'), dir };
}
// a sandboxed copy of the script gets its own statusline.config.json (config
// is resolved next to the script file)
function scriptCopy(dir, config) {
  const p = path.join(dir, 'statusline.js');
  fs.copyFileSync(SCRIPT, p);
  if (config !== undefined) fs.writeFileSync(path.join(dir, 'statusline.config.json'), JSON.stringify(config));
  return p;
}
function run(args, { stdin = '', env = {}, script = SCRIPT } = {}) {
  // TEST-01: start from a scrubbed copy of the environment so a contributor's own
  // NO_UPDATE_NOTIFIER / API key / proxy / CCBSL_* settings can't change test behavior, and
  // redirect every temp path at TESTTMP so the product never reads or deletes host os.tmpdir().
  const base = { ...process.env };
  for (const k of ['NO_UPDATE_NOTIFIER', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    'CCBSL_UPDATE_BASE', 'CCBSL_UNATTENDED', 'CLAUDE_CONFIG_DIR']) delete base[k];
  base.TMPDIR = base.TEMP = base.TMP = TESTTMP;
  // CCBSL_NO_ACT keeps the guardian from spawning real notifications / watcher / relaunch
  // processes during tests; file side effects (checkpoints, tickets) still run.
  const merged = { ...base, COLUMNS: '120', CCBSL_NO_ACT: '1', ...env };
  // on Windows os.homedir() reads USERPROFILE, not HOME; mirror it so HOME sandboxing works there too
  if (merged.HOME) merged.USERPROFILE = merged.HOME;
  const r = spawnSync(NODE, [script, ...args], {
    input: stdin,
    encoding: 'utf8',
    timeout: 15000,
    env: merged,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function render(input, { env = {}, script = SCRIPT, cols = '120' } = {}) {
  return run([], { stdin: JSON.stringify(input), env: { ...env, COLUMNS: cols }, script });
}
function shellQuoteJs(s){return "'"+String(s).replace(/'/g,"'\\''")+"'";}
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const baseInput = (extra = {}) => ({
  model: { id: 'claude-opus-4-8[1m]', display_name: 'Opus 4.8 (1M context)' },
  effort: { level: 'high' },
  context_window: { used_percentage: 42 },
  workspace: { current_dir: '/tmp/proj', project_dir: '/tmp/proj' },
  ...extra,
});

// ===========================================================================
// rendering
// ===========================================================================
test('renders on empty stdin without crashing', () => {
  const sb = sandbox();
  const r = run([], { stdin: '', env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  assert.strictEqual(r.code, 0);
  assert.ok(strip(r.out).length > 0);
});

test('renders model, [1m] tag, effort, and context bar', () => {
  const sb = sandbox();
  const r = render(baseInput(), { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  const out = strip(r.out);
  assert.match(out, /Opus 4\.8/);
  assert.match(out, /\[1m\]/);
  assert.match(out, /⚡high/);
  assert.match(out, /ctx .*42%/);
});

test('model keeps its name and drops the "(1M context)" suffix', () => {
  const sb = sandbox();
  const out = strip(render(baseInput(), { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } }).out);
  assert.ok(!out.includes('(1M context)'));
});

test('flags: fast shows when on, no-think shows only when thinking is off', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const on = strip(render(baseInput({ fast_mode: true, thinking: { enabled: false } }), { env }).out);
  assert.match(on, /fast/); assert.match(on, /no-think/);
  const off = strip(render(baseInput({ fast_mode: false, thinking: { enabled: true } }), { env }).out);
  assert.ok(!off.includes('fast')); assert.ok(!off.includes('no-think'));
});

test('billing: sub with rate_limits, api with an API key, hidden otherwise', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const sub = strip(render(baseInput({ rate_limits: { five_hour: { used_percentage: 5 } } }), { env }).out);
  assert.match(sub, /💳 sub/);
  const api = strip(render(baseInput(), { env: { ...env, ANTHROPIC_API_KEY: 'sk-x' } }).out);
  assert.match(api, /💳 api/);
  const envNoKey = { ...env }; delete envNoKey.ANTHROPIC_API_KEY;
  const none = render(baseInput(), { env: envNoKey });
  // run() scrubs ANTHROPIC_API_KEY/AUTH_TOKEN from the child env, so this is unconditional now
  assert.ok(!strip(none.out).includes('💳'));
});

test('usage bars render with reset times', () => {
  const sb = sandbox();
  const now = Math.floor(Date.now() / 1000);
  const out = strip(render(baseInput({
    rate_limits: {
      five_hour: { used_percentage: 30, resets_at: now + 3600 },
      seven_day: { used_percentage: 60, resets_at: now + 5 * 86400 },
    },
  }), { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } }).out);
  assert.match(out, /session .*30% ↺/);
  assert.match(out, /weekly .*60% ↺/);
  // a reset days out carries a date (M/D), same-day carries a bare clock
  assert.match(out, /weekly .*↺\d+\/\d+ /);
});

test('relative reset style via config', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { resetStyle: 'relative' });
  const now = Math.floor(Date.now() / 1000);
  const out = strip(render(baseInput({
    rate_limits: { five_hour: { used_percentage: 30, resets_at: now + 2 * 3600 } },
  }), { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script }).out);
  assert.match(out, /session .*↺(1h5\dm|2h)/);
});

test('wrapping: no multi-segment line exceeds the terminal width', () => {
  const sb = sandbox();
  const input = baseInput({
    fast_mode: true, thinking: { enabled: false },
    rate_limits: { five_hour: { used_percentage: 63, resets_at: 1784310000 }, seven_day: { used_percentage: 88, resets_at: 1784484000 } },
  });
  for (const cols of ['50', '80', '140']) {
    const out = strip(render(input, { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, cols }).out);
    for (const line of out.split('\n')) {
      if (line.includes('│')) {
        // emoji count 2 cells; a rough upper bound still catches wrap bugs
        assert.ok(line.length <= parseInt(cols, 10) + 4, `line wider than ${cols}: ${line}`);
      }
    }
  }
});

test('context falls back to the transcript tail when context_window is absent', () => {
  const sb = sandbox();
  const tp = path.join(sb.dir, 'transcript.jsonl');
  fs.writeFileSync(tp, [
    JSON.stringify({ type: 'user' }),
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 199000 } } }),
  ].join('\n') + '\n');
  const input = { model: { id: 'claude-opus-4-8[1m]', display_name: 'Opus 4.8' }, transcript_path: tp };
  const out = strip(render(input, { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } }).out);
  assert.match(out, /ctx .*20%/); // 200002 of 1M
});

// ===========================================================================
// profile badge
// ===========================================================================
test('profile hides for a single-profile user on the default dir', () => {
  const sb = sandbox();
  const out = strip(render(baseInput(), { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } }).out);
  assert.ok(!out.includes('👤'));
});

test('profile shows with two profiles and derives labels from dir names', () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.home, '.claude-acme'), { recursive: true });
  fs.writeFileSync(path.join(sb.home, '.claude-acme', 'settings.json'), '{}'); // a real profile marker
  const env = { HOME: sb.home };
  const onDefault = strip(render(baseInput(), { env: { ...env, CLAUDE_CONFIG_DIR: sb.cfg } }).out);
  assert.match(onDefault, /👤/);
  const onAcme = strip(render(baseInput(), { env: { ...env, CLAUDE_CONFIG_DIR: path.join(sb.home, '.claude-acme') } }).out);
  assert.match(onAcme, /👤 acme/);
});

test('profileLabels config overrides the derived label', () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.home, '.claude-x'), { recursive: true });
  fs.writeFileSync(path.join(sb.home, '.claude-x', 'settings.json'), '{}'); // a real profile marker
  const script = scriptCopy(sb.dir, { profileLabels: { '.claude': 'work' } });
  const out = strip(render(baseInput(), { env: { HOME: sb.home, CLAUDE_CONFIG_DIR: sb.cfg }, script }).out);
  assert.match(out, /👤 work/);
});

// ===========================================================================
// near-limit warning + resume tickets
// ===========================================================================
test('warn threshold turns the hint on; below it stays off', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const calm = strip(render(baseInput({ rate_limits: { five_hour: { used_percentage: 50 } } }), { env }).out);
  assert.ok(!calm.includes('near limit'));
  const hot = strip(render(baseInput({ rate_limits: { five_hour: { used_percentage: 91 } } }), { env }).out);
  assert.match(hot, /near limit/);
  assert.match(hot, /claude --continue/);
});

test('critical usage writes a resume ticket once, with the exact command', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const input = baseInput({
    session_id: 'abc-123',
    session_name: 'Fix the billing bug',
    rate_limits: { five_hour: { used_percentage: 99, resets_at: Math.floor(Date.now() / 1000) + 600 } },
  });
  const out = strip(render(input, { env }).out);
  assert.match(out, /limit imminent/);
  const ticket = path.join(sb.cfg, 'resume-tickets', 'abc-123.md');
  assert.ok(fs.existsSync(ticket), 'ticket file written');
  const body = fs.readFileSync(ticket, 'utf8');
  assert.match(body, /claude --resume abc-123/);
  assert.match(body, /\/tmp\/proj/);
  assert.match(body, /Fix the billing bug/);
  const mtime = fs.statSync(ticket).mtimeMs;
  render(input, { env }); // second render must not rewrite
  assert.strictEqual(fs.statSync(ticket).mtimeMs, mtime);
});

test('no session_id means no ticket; resumeTickets:false disables it', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  render(baseInput({ rate_limits: { five_hour: { used_percentage: 99 } } }), { env });
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'resume-tickets')));
  const script = scriptCopy(sb.dir, { resumeTickets: false });
  render(baseInput({ session_id: 'zzz', rate_limits: { five_hour: { used_percentage: 99 } } }), { env, script });
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'resume-tickets', 'zzz.md')));
});

test('a session_id with path characters is refused (no traversal)', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  render(baseInput({ session_id: '../evil', rate_limits: { five_hour: { used_percentage: 99 } } }), { env });
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'resume-tickets')));
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'evil.md')));
});

test('a passed reset time shows "now" and clears the stale warning', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const past = Math.floor(Date.now() / 1000) - 300;   // reset was 5 min ago
  const future = Math.floor(Date.now() / 1000) + 3600;
  // window was at 96% but its reset has passed: no warning, reset reads "now"
  const passed = strip(render(baseInput({
    session_id: 'sx', rate_limits: { five_hour: { used_percentage: 96, resets_at: past } },
  }), { env }).out);
  assert.match(passed, /session .*96% ↺now/);
  assert.ok(!passed.includes('near limit'), 'no stale near-limit warning after reset passed');
  assert.ok(!passed.includes('⚠'), 'no stale warning glyph');
  // no resume ticket written for a window whose reset already passed
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'resume-tickets', 'sx.md')));
  // a still-active window at the same % keeps the warning
  const active = strip(render(baseInput({
    rate_limits: { five_hour: { used_percentage: 92, resets_at: future } },
  }), { env }).out);
  assert.match(active, /near limit/);
});

// ===========================================================================
// hostile configs never crash the render
// ===========================================================================
for (const [name, cfg] of Object.entries({
  'color null': { color: null },
  'show scalar': { show: 'nope' },
  'thresholds arrays': { thresholds: { context: [], usage: [] } },
  'threshold strings': { thresholds: { context: { green: 'a', yellow: null } } },
  'order junk': { order: 'x' },
  'order empty': { order: [] },
})) {
  test('hostile config survives: ' + name, () => {
    const sb = sandbox();
    const script = scriptCopy(sb.dir, cfg);
    const r = render(baseInput(), { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script });
    assert.strictEqual(r.code, 0);
    assert.match(strip(r.out), /Opus 4\.8/);
  });
}

test('non-numeric thresholds fall back: context bar is not red at 42%', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { thresholds: { context: [] } });
  const r = render(baseInput(), { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script });
  const bar = r.out.match(/\x1b\[38;5;(\d+)m█+/);
  assert.ok(bar, 'a filled bar rendered');
  assert.strictEqual(bar[1], '78', 'green (78) at 42%, not red');
});

// ===========================================================================
// display modes
// ===========================================================================
test('--mode writes config; minimal hides extras, expanded shows cost + name', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir);
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const input = baseInput({
    fast_mode: true, thinking: { enabled: false }, session_name: 'Task X',
    cost: { total_cost_usd: 1.5, total_lines_added: 10, total_lines_removed: 2 },
    rate_limits: { five_hour: { used_percentage: 40 }, seven_day: { used_percentage: 30 } },
  });
  const mode = (m) => { const r = run(['--mode', m], { env, script }); assert.strictEqual(r.code, 0, m); return strip(render(input, { env, script, cols: '200' }).out); };

  const min = mode('minimal');
  assert.match(min, /📂/); assert.match(min, /Opus/); assert.match(min, /ctx/);
  assert.ok(!min.includes('💳'), 'minimal hides billing');
  assert.ok(!min.includes('session'), 'minimal hides usage bars');
  assert.ok(!min.includes('⚡'), 'minimal hides effort');
  assert.ok(!min.includes('Task X'), 'minimal hides session name');

  const exp = mode('expanded');
  assert.match(exp, /💳/); assert.match(exp, /session/);
  assert.match(exp, /\$1\.50/, 'expanded shows cost'); assert.match(exp, /Task X/, 'expanded shows session name');

  const norm = mode('normal');
  assert.match(norm, /💳/); assert.match(norm, /session/);
  assert.ok(!norm.includes('$1.50'), 'normal hides cost by default');
  assert.ok(!norm.includes('Task X'), 'normal hides session name by default');
});

test('minimal mode still surfaces the near-limit warning', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { mode: 'minimal' });
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const out = strip(render(baseInput({ rate_limits: { five_hour: { used_percentage: 92 } } }), { env, script, cols: '200' }).out);
  assert.match(out, /near limit/);
});

test('--mode rejects an invalid mode', () => {
  const r = run(['--mode', 'huge']);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /minimal\|normal\|expanded/);
});

test('an invalid mode in config falls back to normal', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { mode: 'ludicrous' });
  const out = strip(render(baseInput({ rate_limits: { five_hour: { used_percentage: 40 } } }), { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script }).out);
  assert.match(out, /session/); // normal behavior restored
});

test('--config m cycles the mode and saves it', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { mode: 'normal' });
  const r = run(['--config'], { stdin: 'm\ns\n', env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script });
  assert.strictEqual(r.code, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(sb.dir, 'statusline.config.json'), 'utf8'));
  assert.strictEqual(cfg.mode, 'expanded'); // normal -> expanded (cycle order minimal,normal,expanded)
});

// ===========================================================================
// CLI: install / uninstall / doctor / misc
// ===========================================================================
test('--version and --help', () => {
  assert.match(run(['--version']).out, /CCRig v\d+\.\d+\.\d+/);
  const h = run(['--help']);
  assert.strictEqual(h.code, 0);
  for (const flag of ['--install', '--uninstall', '--doctor', '--config', '--demo', '--selftest']) assert.ok(h.out.includes(flag), flag + ' in help');
});

test('--install wires a fresh profile and is idempotent with a backup', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const first = run(['--install'], { env });
  assert.strictEqual(first.code, 0);
  const sp = path.join(sb.cfg, 'settings.json');
  const j = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.strictEqual(j.statusLine.type, 'command');
  assert.ok(j.statusLine.command.includes(SCRIPT));
  assert.strictEqual(j.statusLine.refreshInterval, 2);
  const again = run(['--install'], { env });
  assert.strictEqual(again.code, 0);
  assert.ok(fs.existsSync(sp + '.bak'), 'backup written on re-run');
});

test('the `init` subcommand is an alias for --install', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const r = run(['init'], { env });
  assert.strictEqual(r.code, 0);
  const j = JSON.parse(fs.readFileSync(path.join(sb.cfg, 'settings.json'), 'utf8'));
  assert.ok(j.statusLine && j.statusLine.command.includes(SCRIPT), 'ccrig init wired the status line');
});

test('install writes the native /ccrig slash commands; uninstall removes them', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  run(['--install'], { env });
  const cdir = path.join(sb.cfg, 'commands');
  assert.ok(fs.existsSync(path.join(cdir, 'ccrig.md')), '/ccrig hub written');
  assert.ok(fs.existsSync(path.join(cdir, 'statusline-config.md')), 'legacy /statusline-config kept');
  for (const f of ['config', 'status', 'sessions', 'doctor', 'update']) {
    assert.ok(fs.existsSync(path.join(cdir, 'ccrig', f + '.md')), '/ccrig:' + f + ' written');
  }
  assert.match(fs.readFileSync(path.join(cdir, 'ccrig', 'status.md'), 'utf8'), /--status/, 'the status command runs --status');
  run(['--uninstall'], { env });
  assert.ok(!fs.existsSync(path.join(cdir, 'ccrig')), 'the /ccrig subdir is removed on uninstall');
  assert.ok(!fs.existsSync(path.join(cdir, 'ccrig.md')), 'the /ccrig hub is removed on uninstall');
});

test('REGRESSION: --install wires EVERY profile, not just the active one (work + personal)', () => {
  const sb = sandbox(); // creates ~/.claude (the default / "work" profile)
  const personal = path.join(sb.home, '.claude-personal');
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, 'settings.json'), '{}'); // a Claude marker: a real profile, not a foreign tool dir
  // install pointed at the DEFAULT profile only — personal must still get wired
  const r = run(['--install'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  assert.strictEqual(r.code, 0);
  for (const dir of [sb.cfg, personal]) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.ok(j.statusLine && j.statusLine.command.includes(SCRIPT), 'statusLine wired in ' + dir);
    assert.ok(fs.existsSync(path.join(dir, 'commands', 'statusline-config.md')), 'slash command in ' + dir);
  }
  assert.match(r.out, /personal/, 'reports the personal profile by name');
  assert.match(r.out, /Set up 2 of 2 profiles/);
});

test('--install --this-profile scopes to the active profile only', () => {
  const sb = sandbox();
  const personal = path.join(sb.home, '.claude-personal');
  fs.mkdirSync(personal, { recursive: true });
  run(['--install', '--this-profile'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  assert.ok(fs.existsSync(path.join(sb.cfg, 'settings.json')), 'active profile wired');
  assert.ok(!fs.existsSync(path.join(personal, 'settings.json')), 'other profile untouched');
});

test('REGRESSION: --install never treats our own state dirs as profiles', () => {
  const sb = sandbox();
  for (const d of ['.claude-usage-ledger', '.claude-rig-sessions']) fs.mkdirSync(path.join(sb.home, d), { recursive: true });
  const r = run(['--install'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  assert.strictEqual(r.code, 0);
  for (const d of ['.claude-usage-ledger', '.claude-rig-sessions']) {
    assert.ok(!fs.existsSync(path.join(sb.home, d, 'settings.json')), d + ' must not be wired');
  }
});

test('--install: one broken profile is skipped, the rest still get wired', () => {
  const sb = sandbox();
  const personal = path.join(sb.home, '.claude-personal');
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, 'settings.json'), '{broken');
  const r = run(['--install'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  assert.strictEqual(r.code, 0, 'still succeeds for the good profile');
  assert.ok(JSON.parse(fs.readFileSync(path.join(sb.cfg, 'settings.json'), 'utf8')).statusLine, 'default wired');
  assert.strictEqual(fs.readFileSync(path.join(personal, 'settings.json'), 'utf8'), '{broken', 'corrupt one not clobbered');
  assert.match(r.out, /Could not set up the personal profile/);
});

test('--install preserves unrelated settings keys + a user hook, and wires the guardian by default', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.cfg, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'my-own-thing' }] }] } }));
  run(['--install'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  const j = JSON.parse(fs.readFileSync(path.join(sb.cfg, 'settings.json'), 'utf8'));
  assert.strictEqual(j.model, 'opus');
  assert.ok(JSON.stringify(j.hooks.PreToolUse).includes('my-own-thing'), 'unrelated user hook preserved');
  assert.ok(Array.isArray(j.hooks.Stop) && JSON.stringify(j.hooks.Stop).includes('--hook'), 'guardian wired by default install');
  assert.ok(j.statusLine);
});

test('--install --no-guardian installs the bar only (no guardian hooks)', () => {
  const sb = sandbox();
  run(['--install', '--no-guardian'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  const j = JSON.parse(fs.readFileSync(path.join(sb.cfg, 'settings.json'), 'utf8'));
  assert.ok(j.statusLine, 'status line wired');
  assert.ok(!j.hooks || !j.hooks.Stop, 'no guardian hooks with --no-guardian');
});

test('--install refuses corrupt settings.json without clobbering it', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.cfg, 'settings.json'), '{broken');
  const r = run(['--install'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(fs.readFileSync(path.join(sb.cfg, 'settings.json'), 'utf8'), '{broken');
});

test('REGRESSION: --install refuses an array/scalar settings.json instead of silently no-oping', () => {
  for (const content of ['[]', '42', 'null']) {
    const sb = sandbox();
    fs.writeFileSync(path.join(sb.cfg, 'settings.json'), content);
    const r = run(['--install'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
    assert.strictEqual(r.code, 1, content + ' must be refused');
    assert.strictEqual(fs.readFileSync(path.join(sb.cfg, 'settings.json'), 'utf8'), content, content + ' must not be clobbered');
  }
});

test('--uninstall removes statusLine, preserves the rest, and handles absence', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  fs.writeFileSync(path.join(sb.cfg, 'settings.json'), JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: `node "${SCRIPT}"` } }));
  const r = run(['--uninstall'], { env });
  assert.strictEqual(r.code, 0);
  const j = JSON.parse(fs.readFileSync(path.join(sb.cfg, 'settings.json'), 'utf8'));
  assert.strictEqual(j.statusLine, undefined);
  assert.strictEqual(j.model, 'opus');
  const again = run(['--uninstall'], { env });
  assert.strictEqual(again.code, 0);
  assert.match(again.out, /nothing to remove/);
});

test('--uninstall leaves a third-party status line untouched', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  fs.writeFileSync(path.join(sb.cfg, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'npx some-other-statusline' } }));
  const r = run(['--uninstall'], { env });
  assert.strictEqual(r.code, 0);
  const j = JSON.parse(fs.readFileSync(path.join(sb.cfg, 'settings.json'), 'utf8'));
  assert.ok(j.statusLine, 'foreign status line preserved');
  assert.match(r.out, /nothing to remove|untouched/);
});

test('REGRESSION: --uninstall on a read-only settings.json fails gracefully, no stack trace', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const sb = sandbox();
  const sp = path.join(sb.cfg, 'settings.json');
  fs.writeFileSync(sp, JSON.stringify({ statusLine: { command: `node "${SCRIPT}"` } }));
  fs.chmodSync(sp, 0o444);
  fs.chmodSync(sb.cfg, 0o555);
  const r = run(['--uninstall'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  fs.chmodSync(sb.cfg, 0o755); fs.chmodSync(sp, 0o644);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /Could not remove CCRig from the/);
  assert.ok(!r.out.includes('at runUninstall'), 'no raw stack trace');
});

test('--doctor passes on a healthy install and exits 0', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  run(['--install'], { env });
  const r = run(['--doctor'], { env });
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /All checks passed/);
});

test('--doctor fails with a fix hint when statusLine is unwired', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.cfg, 'settings.json'), '{}');
  const r = run(['--doctor'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /statusLine is not configured/);
  assert.match(r.out, /--install/);
});

test('REGRESSION: --doctor catches a dead SCRIPT path, not just a dead node path', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.cfg, 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: `"${NODE}" "/nonexistent/deleted/statusline.js"` },
  }));
  const r = run(['--doctor'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /do not exist/);
  assert.match(r.out, /\/nonexistent\/deleted\/statusline\.js/);
});

test('REGRESSION: --doctor does not false-fail a sh -c wrapper command', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.cfg, 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: `sh -c "node ${SCRIPT}"` },
  }));
  const r = run(['--doctor'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  assert.ok(!/do not exist/.test(r.out), 'no false path failure');
});

test('REGRESSION: --doctor survives a non-string statusLine.command', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.cfg, 'settings.json'), JSON.stringify({ statusLine: { command: 123 } }));
  const r = run(['--doctor'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /not a string/);
  assert.ok(!r.out.includes('TypeError'), 'no raw TypeError');
});

test('--doctor flags an invalid statusline.config.json', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir);
  fs.writeFileSync(path.join(sb.dir, 'statusline.config.json'), '{bad');
  run(['--install'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script });
  const r = run(['--doctor'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script });
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /config\.json is invalid/);
});

test('--options prints modes, segments, thresholds and exits 0', () => {
  const r = run(['--options']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /display mode:/);
  assert.match(r.out, /choices: minimal \| normal \| expanded/);
  assert.match(r.out, /segments/);
  assert.match(r.out, /thresholds/);
  assert.match(r.out, /\/statusline-config/);
});

test('--install writes the /statusline-config command; --uninstall removes it', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir);
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  run(['--install'], { env, script });
  const cmd = path.join(sb.cfg, 'commands', 'statusline-config.md');
  assert.ok(fs.existsSync(cmd), 'command written');
  const body = fs.readFileSync(cmd, 'utf8');
  assert.match(body, /description:/);
  assert.match(body, /\$ARGUMENTS/);
  assert.match(body, /AskUserQuestion/, 'drives an interactive menu');
  assert.ok(body.includes(script), 'bakes the script path');
  run(['--uninstall'], { env, script });
  assert.ok(!fs.existsSync(cmd), 'command removed on uninstall');
});

test('mutually exclusive flags are rejected', () => {
  const r = run(['--install', '--uninstall']);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /pick one of/);
});

test('REGRESSION: a value-setter combined with an action flag is rejected, not silently run', () => {
  const r = run(['--install', '--mode', 'minimal']);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /pick one of/);
});

test('REGRESSION: folder appends a true sub-dir but not a mere string-prefix', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const sub = strip(render(baseInput({ workspace: { project_dir: '/work/proj', current_dir: '/work/proj/api' } }), { env }).out);
  assert.match(sub, /proj\/api/);
  const pre = strip(render(baseInput({ workspace: { project_dir: '/work/proj', current_dir: '/work/proj-x' } }), { env }).out);
  assert.ok(!pre.includes('proj-x'), '/work/proj-x is not a child of /work/proj');
});

test('REGRESSION: context % label is clamped to 100', () => {
  const sb = sandbox();
  const out = strip(render(baseInput({ context_window: { used_percentage: 150 } }), { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } }).out);
  assert.match(out, /ctx .*100%/);
  assert.ok(!out.includes('150%'));
});

test('--demo renders three widths and leaves no side effects', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir);
  const r = run(['--demo'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script });
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /120 cols/); assert.match(r.out, /80 cols/); assert.match(r.out, /50 cols/);
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'resume-tickets')), 'demo must not write tickets');
});

test('--selftest passes', () => {
  const r = run(['--selftest']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /All self-tests passed/);
});

test('--config quits without writing when told q', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir);
  const r = run(['--config'], { stdin: 'q\n', env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script });
  assert.strictEqual(r.code, 0);
  assert.ok(!fs.existsSync(path.join(sb.dir, 'statusline.config.json')));
});

test('--config toggles a segment and saves valid JSON', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir);
  // segment #3 is 'folder' in the default order (profile, update, folder, ...)
  const r = run(['--config'], { stdin: '3\ns\n', env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script });
  assert.strictEqual(r.code, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(sb.dir, 'statusline.config.json'), 'utf8'));
  assert.strictEqual(cfg.show.folder, false);
});

// ===========================================================================
// git segment
// ===========================================================================
test('git: branch, dirty count, and ahead-of-upstream render', () => {
  const sb = sandbox();
  const bare = path.join(sb.dir, 'bare.git');
  const work = path.join(sb.dir, 'work');
  const g = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g(['init', '--bare', bare], sb.dir);
  g(['clone', bare, work], sb.dir);
  fs.writeFileSync(path.join(work, 'a.txt'), '1');
  g(['add', '.'], work); g(['commit', '-m', 'one'], work); g(['push', 'origin', 'HEAD'], work);
  fs.writeFileSync(path.join(work, 'b.txt'), '2');
  g(['add', '.'], work); g(['commit', '-m', 'two'], work); // ahead 1
  fs.writeFileSync(path.join(work, 'c.txt'), 'dirty');     // dirty 1
  const script = scriptCopy(sb.dir, { gitCacheMs: 0 });    // no cache: assert fresh state
  const input = baseInput({ workspace: { current_dir: work, project_dir: work }, cwd: work });
  const out = strip(render(input, { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script }).out);
  assert.match(out, /🌿 (master|main)/);
  assert.match(out, /●1/);
  assert.match(out, /↑1/);
});

test('git: absent repo hides the segment', () => {
  const sb = sandbox();
  const empty = path.join(sb.dir, 'empty'); fs.mkdirSync(empty);
  const script = scriptCopy(sb.dir, { gitCacheMs: 0 });
  const input = baseInput({ workspace: { current_dir: empty, project_dir: empty }, cwd: empty });
  const out = strip(render(input, { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script }).out);
  assert.ok(!out.includes('🌿'));
});

// ===========================================================================
// caveman badge (composes with the plugin when present)
// ===========================================================================
test('caveman badge shows from the flag file and refuses a symlink', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  fs.writeFileSync(path.join(sb.cfg, '.caveman-active'), 'full');
  assert.match(strip(render(baseInput(), { env }).out), /\[CAVEMAN\]/);
  fs.writeFileSync(path.join(sb.cfg, '.caveman-active'), 'ultra');
  assert.match(strip(render(baseInput(), { env }).out), /\[CAVEMAN:ULTRA\]/);
  fs.unlinkSync(path.join(sb.cfg, '.caveman-active'));
  fs.writeFileSync(path.join(sb.dir, 'target'), 'full');
  // symlink creation needs privilege / Developer Mode on Windows; skip the refusal check if we can't make one
  let linked = false;
  try { fs.symlinkSync(path.join(sb.dir, 'target'), path.join(sb.cfg, '.caveman-active')); linked = true; } catch {}
  if (linked) assert.ok(!strip(render(baseInput(), { env }).out).includes('CAVEMAN'), 'symlinked flag refused');
});

// ===========================================================================
// GUARDIAN: keep-working (Stop hook), auto-resume (checkpoint + SessionStart),
// PreCompact snapshot, burn-rate forecast, cross-profile ledger, installer.
// ===========================================================================
let tn = 0;
function transcript(dir, entries) {
  const p = path.join(dir, 'transcript-' + (++tn) + '.jsonl');
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}
const todoEntry = (todos) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos } }] } });
const userEntry = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const asstEntry = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
// djb2 mirror of statusline.js strHash, so tests can seed the forecast sample file
function strHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }
function seedSamples(sid, samples) { fs.writeFileSync(path.join(TESTTMP, 'ccbsl-usage-' + strHash(sid) + '.jsonl'), samples.map((s) => JSON.stringify(s)).join('\n') + '\n'); }
const hookRun = (event, payload, opts) => run(['--hook', event], { stdin: JSON.stringify(payload), ...opts });

// ---- Feature 2: keep-working / anti-stop Stop hook ----
test('keep-working: default off always allows stop', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const tp = transcript(sb.dir, [todoEntry([{ content: 'B', status: 'pending' }])]);
  const r = hookRun('stop', { session_id: 's1', transcript_path: tp }, { env });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out.trim(), '', 'no block when keep-working is off');
});

test('keep-working: blocks while todos remain, allows when all done', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { keepWorking: true });
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const tp = transcript(sb.dir, [userEntry('do the thing'), todoEntry([{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }]), asstEntry('working on B now.')]);
  const r = hookRun('stop', { session_id: 's1', transcript_path: tp }, { env, script });
  const o = JSON.parse(r.out);
  assert.strictEqual(o.decision, 'block');
  assert.match(o.reason, /1 todo\(s\) still open/);
  assert.match(o.reason, /- B/);
  assert.ok(!o.reason.includes('- A'), 'completed todo not listed');
  const tp2 = transcript(sb.dir, [todoEntry([{ content: 'A', status: 'completed' }, { content: 'B', status: 'completed' }])]);
  const done = hookRun('stop', { session_id: 's1', transcript_path: tp2 }, { env, script });
  assert.strictEqual(done.out.trim(), '', 'allows stop when nothing is pending');
});

test('keep-working: yields to a trailing question (human decision)', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { keepWorking: true });
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const tp = transcript(sb.dir, [todoEntry([{ content: 'B', status: 'pending' }]), asstEntry('Which database should I use?')]);
  const r = hookRun('stop', { session_id: 's2', transcript_path: tp }, { env, script });
  assert.strictEqual(r.out.trim(), '', 'does not talk over a question');
});

test('keep-working: stops forcing once progress stalls (stuck guard)', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { keepWorking: { maxStuck: 2 } });
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const tp = transcript(sb.dir, [todoEntry([{ content: 'B', status: 'pending' }]), asstEntry('still going')]);
  const hit = () => hookRun('stop', { session_id: 'stuck1', transcript_path: tp }, { env, script });
  assert.strictEqual(JSON.parse(hit().out).decision, 'block'); // stuck=0
  assert.strictEqual(JSON.parse(hit().out).decision, 'block'); // stuck=1
  assert.strictEqual(hit().out.trim(), '', 'allows stop once stalled');
});

test('unattended auto-resume never force-continues (CCBSL_UNATTENDED caps the loop)', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { keepWorking: true });
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_UNATTENDED: '1' };
  const tp = transcript(sb.dir, [todoEntry([{ content: 'B', status: 'pending' }]), asstEntry('working')]);
  const r = hookRun('stop', { session_id: 'u1', transcript_path: tp }, { env, script });
  assert.strictEqual(r.out.trim(), '', 'unattended -> allows stop despite pending todos');
});

test('--status lists armed watchers; --disarm clears them; --purge wipes state', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const gdir = path.join(sb.cfg, 'guardian'); fs.mkdirSync(gdir, { recursive: true });
  fs.writeFileSync(path.join(gdir, 'sess1.watch.pid'), '999999\n' + (Date.now() + 3600000));
  fs.writeFileSync(path.join(gdir, 'sess1.checkpoint.json'), JSON.stringify({ session_id: 'sess1', window: 'session', todos: [] }));
  assert.match(run(['--status'], { env }).out, /sess1/);
  const d = run(['--disarm'], { env });
  assert.match(d.out, /Stopped 1 watcher/);
  assert.ok(!fs.existsSync(path.join(gdir, 'sess1.watch.pid')), 'pid file cleared');
  assert.ok(!fs.existsSync(path.join(gdir, 'sess1.checkpoint.json')), 'checkpoint cleared');
  fs.mkdirSync(gdir, { recursive: true }); fs.writeFileSync(path.join(gdir, 'x.checkpoint.json'), '{}');
  fs.mkdirSync(path.join(sb.cfg, 'resume-tickets'), { recursive: true });
  fs.writeFileSync(path.join(sb.cfg, '.ccbsl-update.json'), '{}');
  assert.strictEqual(run(['--purge'], { env }).code, 0);
  assert.ok(!fs.existsSync(gdir) && !fs.existsSync(path.join(sb.cfg, 'resume-tickets')) && !fs.existsSync(path.join(sb.cfg, '.ccbsl-update.json')));
});

test('hooks tolerate garbage stdin and never block', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  for (const ev of ['stop', 'session-start', 'pre-compact']) {
    const r = run(['--hook', ev], { stdin: 'not json', env });
    assert.strictEqual(r.code, 0, ev + ' exits 0');
    assert.strictEqual(r.out.trim(), '', ev + ' emits nothing on garbage');
  }
});

// ---- workflow + subagent support ----
test('agents segment counts in-flight subagents (Task without a result yet)', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const tp = transcript(sb.dir, [
    userEntry('go'),
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'a1', name: 'Task', input: { description: 'scan' } },
      { type: 'tool_use', id: 'a2', name: 'Task', input: { description: 'review' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'done' }] } },
  ]);
  assert.match(strip(render(baseInput({ transcript_path: tp }), { env }).out), /🤖 1 agent/);
  // once the second finishes, the badge clears
  fs.appendFileSync(tp, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a2', content: 'done' }] } }) + '\n');
  assert.ok(!strip(render(baseInput({ transcript_path: tp }), { env }).out).includes('🤖'), 'all done -> no badge');
});

test('checkpoint records interrupted orchestration; manual resume warns but is NOT flagged unattended', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { autopilot: 'notify' }); // guardian on so a checkpoint is written
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const tp = transcript(sb.dir, [
    userEntry('run the pipeline'),
    todoEntry([{ content: 'ship', status: 'in_progress' }]),
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'Task', input: { description: 'build worker' } }] } },
  ]);
  const input = baseInput({ session_id: 'ag1', transcript_path: tp, rate_limits: { five_hour: { used_percentage: 99, resets_at: Math.floor(Date.now() / 1000) + 600 } } });
  render(input, { env, script });
  const cp = JSON.parse(fs.readFileSync(path.join(sb.cfg, 'guardian', 'ag1.checkpoint.json'), 'utf8'));
  assert.ok(cp.agents.includes('build worker'), 'in-flight agent captured in checkpoint');
  const r = hookRun('session-start', { session_id: 'ag1', source: 'resume' }, { env, script });
  const ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /did NOT survive/);
  assert.match(ctx, /build worker/);
  assert.ok(!ctx.includes('UNATTENDED'), 'a human-driven resume is not labelled unattended');
});

test('downgrade alert fires on a silent tier drop when usage is elevated', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const hot = { seven_day: { used_percentage: 88 } }; // elevated = the real auto-downgrade condition
  const opus = strip(render(baseInput({ session_id: 'm1', model: { display_name: 'Opus 4.8' }, rate_limits: hot }), { env }).out);
  assert.ok(!opus.includes('⬇'), 'no alert at the ceiling model');
  const sonnet = strip(render(baseInput({ session_id: 'm1', model: { display_name: 'Sonnet 5' }, rate_limits: hot }), { env }).out);
  assert.match(sonnet, /⬇ Sonnet \(was Opus\)/);
});

test('downgrade alert stays quiet on a low-usage (deliberate) model switch', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const cool = { seven_day: { used_percentage: 10 } };
  render(baseInput({ session_id: 'm2', model: { display_name: 'Opus 4.8' }, rate_limits: cool }), { env });
  const sonnet = strip(render(baseInput({ session_id: 'm2', model: { display_name: 'Sonnet 5' }, rate_limits: cool }), { env }).out);
  assert.ok(!sonnet.includes('⬇'), 'low usage -> assume deliberate, no false alarm');
});

test('--update verifies an Ed25519 signature when a key is pinned; rejects a bad one', () => {
  const crypto = require('crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const sb = sandbox();
  const remote = fakeRemote(path.join(sb.dir, 'remote'), '9.9.0');
  const body = fs.readFileSync(path.join(remote, 'statusline.js'));
  fs.writeFileSync(path.join(remote, 'statusline.js.sig'), crypto.sign(null, body, privateKey).toString('base64'));
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_UPDATE_BASE: remote };
  const mk = (dir) => { fs.mkdirSync(dir, { recursive: true }); const s = path.join(dir, 'statusline.js'); fs.copyFileSync(SCRIPT, s); fs.writeFileSync(path.join(dir, 'statusline.config.json'), JSON.stringify({ updatePubkey: pub })); return s; };
  const good = run(['--update'], { env, script: mk(path.join(sb.dir, 'a')) });
  assert.strictEqual(good.code, 0);
  assert.match(good.out, /Ed25519 signature verified/);
  // tamper: replace the .sig with a signature over different bytes
  fs.writeFileSync(path.join(remote, 'statusline.js.sig'), crypto.sign(null, Buffer.from('other'), privateKey).toString('base64'));
  const s2 = mk(path.join(sb.dir, 'b'));
  const before = fs.readFileSync(s2, 'utf8');
  const bad = run(['--update'], { env, script: s2 });
  assert.strictEqual(bad.code, 1);
  assert.match(bad.out, /did NOT verify/);
  assert.strictEqual(fs.readFileSync(s2, 'utf8'), before, 'rejected -> file untouched');
});

// ---- Feature 1: checkpoint + auto-resume ----
test('critical usage writes a rich checkpoint (todos + request + git-aware)', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { autopilot: 'notify' }); // guardian on: default is 'off' (no checkpoint on plain install)
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const tp = transcript(sb.dir, [userEntry('fix the billing bug'), todoEntry([{ content: 'write test', status: 'completed' }, { content: 'ship it', status: 'in_progress' }])]);
  const input = baseInput({ session_id: 'k1', transcript_path: tp, rate_limits: { five_hour: { used_percentage: 99, resets_at: Math.floor(Date.now() / 1000) + 600 } } });
  const out = strip(render(input, { env, script }).out);
  assert.match(out, /limit imminent/);
  const cp = JSON.parse(fs.readFileSync(path.join(sb.cfg, 'guardian', 'k1.checkpoint.json'), 'utf8'));
  assert.strictEqual(cp.window, 'session');
  assert.strictEqual(cp.todos.length, 2);
  assert.match(cp.last_request, /fix the billing bug/);
});

test('REGRESSION: autopilot:off (bar-only) writes NO checkpoint/notify at critical — only the ticket', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { autopilot: 'off' }); // explicit opt-out of the (now default-on) guardian
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const input = baseInput({ session_id: 'plain1', rate_limits: { five_hour: { used_percentage: 99, resets_at: Math.floor(Date.now() / 1000) + 600 } } });
  const out = strip(render(input, { env, script }).out);
  assert.match(out, /limit imminent/);
  assert.ok(fs.existsSync(path.join(sb.cfg, 'resume-tickets', 'plain1.md')), 'resume ticket still written (documented base feature)');
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'guardian', 'plain1.checkpoint.json')), 'no guardian checkpoint when opted out');
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'guardian', 'plain1.notified')), 'no desktop-notification side effect');
});

test('default install (autopilot notify) checkpoints + notifies at critical — guardian is on out of the box', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const input = baseInput({ session_id: 'def1', rate_limits: { five_hour: { used_percentage: 99, resets_at: Math.floor(Date.now() / 1000) + 600 } } });
  render(input, { env }); // DEFAULT config -> autopilot 'notify'
  assert.ok(fs.existsSync(path.join(sb.cfg, 'guardian', 'def1.checkpoint.json')), 'guardian on by default -> checkpoint written');
  assert.ok(fs.existsSync(path.join(sb.cfg, 'guardian', 'def1.notified')), 'notify marker written (real spawn gated off in tests)');
});

test('REGRESSION: setters persist only the diff from defaults (future default changes survive updates)', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir);
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  run(['--autopilot', 'resume'], { env, script });
  const cfg = JSON.parse(fs.readFileSync(path.join(sb.dir, 'statusline.config.json'), 'utf8'));
  assert.strictEqual(cfg.autopilot, 'resume', 'the actual override is saved');
  assert.ok(!('color' in cfg) && !('order' in cfg) && !('gitCacheMs' in cfg), 'unchanged defaults are NOT frozen into the file');
});

test('autopilot resume mode shows "autopilot armed" and marks the watcher', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { autopilot: 'resume' });
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const input = baseInput({ session_id: 'w1', rate_limits: { five_hour: { used_percentage: 99, resets_at: Math.floor(Date.now() / 1000) + 600 } } });
  const out = strip(render(input, { env, script }).out);
  assert.match(out, /autopilot armed/);
  assert.ok(fs.existsSync(path.join(sb.cfg, 'guardian', 'w1.watch')), 'watcher marker written (spawn itself is gated off in tests)');
});

test('SessionStart injects the checkpoint on resume, then consumes it', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const gdir = path.join(sb.cfg, 'guardian'); fs.mkdirSync(gdir, { recursive: true });
  const cp = { session_id: 'r1', session_name: 'X', cwd: '/tmp/proj', reason: 'session limit critical', todos: [{ content: 'Ship it', status: 'pending' }], last_request: 'ship the feature', git: { head: 'abcdef1234567890', dirty: true } };
  fs.writeFileSync(path.join(gdir, 'r1.checkpoint.json'), JSON.stringify(cp));
  const r = hookRun('session-start', { session_id: 'r1', source: 'resume' }, { env });
  const o = JSON.parse(r.out);
  assert.strictEqual(o.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(o.hookSpecificOutput.additionalContext, /Ship it/);
  assert.match(o.hookSpecificOutput.additionalContext, /do NOT redo/);
  assert.match(o.hookSpecificOutput.additionalContext, /abcdef123456/); // git reconciliation
  assert.ok(!fs.existsSync(path.join(gdir, 'r1.checkpoint.json')), 'checkpoint consumed');
  assert.strictEqual(hookRun('session-start', { session_id: 'r1', source: 'resume' }, { env }).out.trim(), '', 'no re-inject');
});

test('SessionStart on a fresh startup injects nothing', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const gdir = path.join(sb.cfg, 'guardian'); fs.mkdirSync(gdir, { recursive: true });
  fs.writeFileSync(path.join(gdir, 'x1.checkpoint.json'), JSON.stringify({ session_id: 'x1', todos: [], cwd: '/tmp' }));
  assert.strictEqual(hookRun('session-start', { session_id: 'x1', source: 'startup' }, { env }).out.trim(), '', 'startup is a fresh session');
});

// ---- Feature 5: PreCompact snapshot ----
test('PreCompact hook snapshots work state so compaction loses nothing', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const tp = transcript(sb.dir, [userEntry('build the widget'), todoEntry([{ content: 'step 1', status: 'pending' }])]);
  const r = hookRun('pre-compact', { session_id: 'c1', transcript_path: tp, cwd: '/tmp/proj' }, { env });
  assert.strictEqual(r.code, 0);
  const cp = JSON.parse(fs.readFileSync(path.join(sb.cfg, 'guardian', 'c1.checkpoint.json'), 'utf8'));
  assert.strictEqual(cp.reason, 'pre-compact');
  assert.strictEqual(cp.todos[0].content, 'step 1');
  assert.match(cp.last_request, /build the widget/);
});

// ---- Feature 3: burn-rate forecast ----
test('forecast: ~Xm-to-limit shows from a rising burn history', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir);
  const r = run(['--demo', '--cols', '200'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script });
  assert.strictEqual(r.code, 0);
  assert.match(strip(r.out), /⏳ ~\d+m to (session|weekly) limit/);
});

test('forecast: "safe" when the window resets before it would exhaust', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const now = Math.floor(Date.now() / 1000);
  seedSamples('safe1', [{ t: now - 120, s: 40 }, { t: now - 60, s: 41 }, { t: now, s: 42 }]); // slow burn
  const input = baseInput({ session_id: 'safe1', rate_limits: { five_hour: { used_percentage: 42, resets_at: now + 300 } } });
  const out = strip(render(input, { env }).out);
  assert.match(out, /session safe/);
});

test('REGRESSION: burn-rate stays accurate at a short span (no epoch-cancellation)', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const now = Math.floor(Date.now() / 1000);
  // 40s span, a clean 0.25%/s climb -> (100-70)/0.25 = 120s ~ 2m to limit.
  seedSamples('burn1', [{ t: now - 40, s: 60 }, { t: now - 20, s: 65 }, { t: now, s: 70 }]);
  const input = baseInput({ session_id: 'burn1', rate_limits: { five_hour: { used_percentage: 70, resets_at: now + 3 * 3600 } } });
  const out = strip(render(input, { env }).out);
  const m = out.match(/~(\d+)m to session limit/);
  assert.ok(m, 'forecast present: ' + out);
  const mins = parseInt(m[1], 10);
  assert.ok(mins >= 1 && mins <= 5, 'ETA is sane (~2m), not garbage: got ' + mins + 'm'); // cancellation bug gave wild values
});

test('REGRESSION: no forecast for a window that has usage but no reset time', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const now = Math.floor(Date.now() / 1000);
  seedSamples('nores1', [{ t: now - 60, s: 80 }, { t: now - 30, s: 85 }, { t: now, s: 90 }]);
  const input = baseInput({ session_id: 'nores1', rate_limits: { five_hour: { used_percentage: 90 } } }); // no resets_at
  const out = strip(render(input, { env }).out);
  assert.ok(!out.includes('⏳'), 'no absurd infinite-horizon forecast: ' + out);
});

test('REGRESSION: --demo writes no files even if config makes its data "critical"', () => {
  const sb = sandbox();
  // critical:90 would make the demo weekly (93%) critical, but --demo is not a live render
  const script = scriptCopy(sb.dir, { thresholds: { usage: { critical: 90 } } });
  const r = run(['--demo', '--cols', '200'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script });
  assert.strictEqual(r.code, 0);
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'resume-tickets')), 'no ticket from --demo');
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'guardian')), 'no checkpoint/markers from --demo');
});

test('REGRESSION: a safe soonest window does not mask a real threat in another window', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const now = Math.floor(Date.now() / 1000);
  // session climbs fast but resets in 60s (safe); weekly climbs and will exhaust in ~4m
  seedSamples('mix1', [{ t: now - 120, s: 55, w: 70 }, { t: now - 60, s: 58, w: 75 }, { t: now, s: 60, w: 80 }]);
  const input = baseInput({ session_id: 'mix1', rate_limits: {
    five_hour: { used_percentage: 60, resets_at: now + 60 },
    seven_day: { used_percentage: 80, resets_at: now + 5 * 86400 },
  } });
  const out = strip(render(input, { env }).out);
  assert.match(out, /to weekly limit/, 'the real threat is surfaced');
  assert.ok(!out.includes('session safe'), 'the safe window does not hide the threat');
});

// ---- Feature 4: cross-profile ledger + failover hint ----
test('failover hint points at another profile that still has headroom', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { ledger: true }); // opt-in: ledger is off by default
  const env = { HOME: sb.home, CLAUDE_CONFIG_DIR: sb.cfg };
  const ldir = path.join(sb.home, '.claude-usage-ledger'); fs.mkdirSync(ldir, { recursive: true });
  fs.writeFileSync(path.join(ldir, '.claude-spare.json'), JSON.stringify({ profile: '.claude-spare', session: 20, weekly: 15, ts: Math.floor(Date.now() / 1000) }));
  const input = baseInput({ session_id: 'f1', rate_limits: { five_hour: { used_percentage: 99, resets_at: Math.floor(Date.now() / 1000) + 600 } } });
  const out = strip(render(input, { env, script }).out);
  assert.match(out, /spare free 8\d%/);
});

test('a stale ledger entry is not offered for failover', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { ledger: true });
  const env = { HOME: sb.home, CLAUDE_CONFIG_DIR: sb.cfg };
  const ldir = path.join(sb.home, '.claude-usage-ledger'); fs.mkdirSync(ldir, { recursive: true });
  fs.writeFileSync(path.join(ldir, '.claude-old.json'), JSON.stringify({ profile: '.claude-old', session: 10, weekly: 10, ts: Math.floor(Date.now() / 1000) - 30 * 3600 }));
  const input = baseInput({ session_id: 'f2', rate_limits: { five_hour: { used_percentage: 99, resets_at: Math.floor(Date.now() / 1000) + 600 } } });
  const out = strip(render(input, { env, script }).out);
  assert.ok(!out.includes('free'), 'stale profile is not suggested');
});

// ---- installer + setters ----
test('--install-guardian wires the three hooks and turns on keep-working', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir);
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const r = run(['--install-guardian'], { env, script });
  assert.strictEqual(r.code, 0);
  const j = JSON.parse(fs.readFileSync(path.join(sb.cfg, 'settings.json'), 'utf8'));
  for (const ev of ['Stop', 'SessionStart', 'PreCompact']) {
    assert.ok(Array.isArray(j.hooks[ev]), ev + ' present');
    assert.ok(JSON.stringify(j.hooks[ev]).includes('--hook'), ev + ' wired to our script');
  }
  assert.ok(j.statusLine, 'status line wired too');
  const cfg = JSON.parse(fs.readFileSync(path.join(sb.dir, 'statusline.config.json'), 'utf8'));
  assert.strictEqual(cfg.keepWorking, true);
  // notify is now the shipped default, so the diff-only saver does not persist it (equals default) -> absent or 'notify', never 'resume' without --auto
  assert.ok(cfg.autopilot === undefined || cfg.autopilot === 'notify', 'autopilot stays at the notify default until --auto');
});

test('--install-guardian --auto enables full auto-resume', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir);
  run(['--install-guardian', '--auto'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(sb.dir, 'statusline.config.json'), 'utf8')).autopilot, 'resume');
});

test('--install-guardian preserves a user\'s own hooks', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir);
  fs.writeFileSync(path.join(sb.cfg, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-thing' }] }] } }));
  run(['--install-guardian'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script });
  const j = JSON.parse(fs.readFileSync(path.join(sb.cfg, 'settings.json'), 'utf8'));
  const cmds = JSON.stringify(j.hooks.Stop);
  assert.ok(cmds.includes('my-own-thing'), 'user hook kept');
  assert.ok(cmds.includes('--hook stop'), 'guardian hook added alongside');
});

test('--uninstall-guardian removes only guardian hooks, keeps the status line', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir);
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  run(['--install-guardian'], { env, script });
  const u = run(['--uninstall-guardian'], { env, script });
  assert.strictEqual(u.code, 0);
  const j = JSON.parse(fs.readFileSync(path.join(sb.cfg, 'settings.json'), 'utf8'));
  assert.ok(j.statusLine, 'status line stays');
  assert.ok(!j.hooks || !j.hooks.Stop, 'guardian Stop hook gone');
});

test('--uninstall removes both the status line and guardian hooks', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir);
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  run(['--install-guardian'], { env, script });
  const r = run(['--uninstall'], { env, script });
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /guardian hook/);
  const j = JSON.parse(fs.readFileSync(path.join(sb.cfg, 'settings.json'), 'utf8'));
  assert.strictEqual(j.statusLine, undefined);
  assert.ok(!j.hooks || !j.hooks.Stop);
});

test('REGRESSION: --install-guardian and --uninstall span every profile', () => {
  const sb = sandbox();
  const personal = path.join(sb.home, '.claude-personal');
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, 'settings.json'), '{}'); // a Claude marker: a real profile
  const script = scriptCopy(sb.dir);
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  run(['--install-guardian'], { env, script });
  for (const dir of [sb.cfg, personal]) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.ok(j.hooks && Array.isArray(j.hooks.Stop), 'guardian Stop hook wired in ' + dir);
  }
  const u = run(['--uninstall'], { env, script });
  assert.strictEqual(u.code, 0);
  for (const dir of [sb.cfg, personal]) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.strictEqual(j.statusLine, undefined, 'status line gone from ' + dir);
    assert.ok(!j.hooks || !j.hooks.Stop, 'guardian gone from ' + dir);
  }
});

test('--autopilot and --keep-working setters write config and reject junk', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir);
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  assert.strictEqual(run(['--autopilot', 'resume'], { env, script }).code, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(sb.dir, 'statusline.config.json'), 'utf8')).autopilot, 'resume');
  assert.strictEqual(run(['--keep-working', 'on'], { env, script }).code, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(sb.dir, 'statusline.config.json'), 'utf8')).keepWorking, true);
  assert.strictEqual(run(['--autopilot', 'bogus'], { env, script }).code, 1);
  assert.strictEqual(run(['--keep-working', 'maybe'], { env, script }).code, 1);
});

test('--doctor reports guardian hook status', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir);
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  run(['--install-guardian'], { env, script });
  const r = run(['--doctor'], { env, script });
  assert.match(r.out, /guardian hooks wired/);
});

test('--options prints the guardian block', () => {
  const r = run(['--options']);
  assert.match(r.out, /guardian/);
  assert.match(r.out, /autopilot:/);
  assert.match(r.out, /keep-working:/);
});

// ===========================================================================
// update system: badge, --check-update, --update (download/validate/swap), --whatsnew
// ===========================================================================
function fakeRemote(dir, version, changelog) {
  fs.mkdirSync(dir, { recursive: true });
  const js = fs.readFileSync(SCRIPT, 'utf8').replace(/const VERSION = '[0-9.]+';/, `const VERSION = '${version}';`);
  fs.writeFileSync(path.join(dir, 'statusline.js'), js);
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog || `# Changelog\n\n## [${version}] - 2026-08-01\n\n### Added\n- Something worth pulling.\n`);
  return dir;
}

test('update badge shows a newer cached version, hides an older one', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const cache = path.join(sb.cfg, '.ccbsl-update.json');
  fs.writeFileSync(cache, JSON.stringify({ latest: '99.0.0', current: '2.1.0', checkedAt: Date.now() }));
  assert.match(strip(render(baseInput(), { env }).out), /⬆ v99\.0\.0/);
  fs.writeFileSync(cache, JSON.stringify({ latest: '0.0.1', checkedAt: Date.now() }));
  assert.ok(!strip(render(baseInput(), { env }).out).includes('⬆'), 'older latest -> no badge');
});

test('update badge respects updateCheck:false', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { updateCheck: false });
  fs.writeFileSync(path.join(sb.cfg, '.ccbsl-update.json'), JSON.stringify({ latest: '99.0.0', checkedAt: Date.now() }));
  const out = strip(render(baseInput(), { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script }).out);
  assert.ok(!out.includes('⬆'), 'disabled -> no badge even with a cache');
});

test('--check-update detects a newer version and writes the cache', () => {
  const sb = sandbox();
  const remote = fakeRemote(path.join(sb.dir, 'remote'), '99.1.0');
  const r = run(['--check-update'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_UPDATE_BASE: remote } });
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /A newer version is ready: v99\.1\.0/);
  const info = JSON.parse(fs.readFileSync(path.join(sb.cfg, '.ccbsl-update.json'), 'utf8'));
  assert.strictEqual(info.latest, '99.1.0');
  assert.ok(info.notes && info.notes.includes('99.1.0'), 'changelog notes captured');
});

test('--check-update on an unreachable source fails silently (exit 0, no crash)', () => {
  const sb = sandbox();
  const r = run(['--check-update'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_UPDATE_BASE: path.join(sb.dir, 'does-not-exist') } });
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Could not check for updates/);
});

test('--update applies a newer version with a backup (standalone copy)', () => {
  const sb = sandbox();
  const inst = path.join(sb.dir, 'inst'); fs.mkdirSync(inst, { recursive: true });
  const instScript = path.join(inst, 'statusline.js');
  fs.copyFileSync(SCRIPT, instScript);
  const remote = fakeRemote(path.join(sb.dir, 'remote'), '99.2.0');
  const r = run(['--update'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_UPDATE_BASE: remote }, script: instScript });
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Updated v.+ to v99\.2\.0/);
  assert.match(r.out, /What changed/);
  assert.match(fs.readFileSync(instScript, 'utf8'), /const VERSION = '99\.2\.0'/);
  assert.ok(fs.readdirSync(inst).some((f) => f.startsWith('statusline.js.bak-')), 'backup written');
  assert.ok(!fs.readdirSync(inst).some((f) => f.includes('.download-')), 'no leftover temp file');
});

test('--update refuses a download that is not our script (leaves the file untouched)', () => {
  const sb = sandbox();
  const inst = path.join(sb.dir, 'inst'); fs.mkdirSync(inst, { recursive: true });
  const instScript = path.join(inst, 'statusline.js');
  fs.copyFileSync(SCRIPT, instScript);
  const remote = path.join(sb.dir, 'bad'); fs.mkdirSync(remote, { recursive: true });
  fs.writeFileSync(path.join(remote, 'statusline.js'), '<html>proxy error</html>');
  const before = fs.readFileSync(instScript, 'utf8');
  const r = run(['--update'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_UPDATE_BASE: remote }, script: instScript });
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /Update skipped/);
  assert.strictEqual(fs.readFileSync(instScript, 'utf8'), before, 'original untouched');
});

test('--update refuses to downgrade without --force, applies with it', () => {
  const sb = sandbox();
  const inst = path.join(sb.dir, 'inst'); fs.mkdirSync(inst, { recursive: true });
  const instScript = path.join(inst, 'statusline.js'); fs.copyFileSync(SCRIPT, instScript);
  const remote = fakeRemote(path.join(sb.dir, 'old'), '0.9.0'); // genuinely older than the installed VERSION
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_UPDATE_BASE: remote };
  const before = fs.readFileSync(instScript, 'utf8');
  const r = run(['--update'], { env, script: instScript });
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /not newer/);
  assert.strictEqual(fs.readFileSync(instScript, 'utf8'), before, 'not downgraded');
  const f = run(['--update', '--force'], { env, script: instScript });
  assert.strictEqual(f.code, 0);
  assert.match(fs.readFileSync(instScript, 'utf8'), /const VERSION = '0\.9\.0'/, 'force downgrades');
});

test('update badge is suppressed by dismissal (seen), staleness, and NO_UPDATE_NOTIFIER', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const cache = path.join(sb.cfg, '.ccbsl-update.json');
  fs.writeFileSync(cache, JSON.stringify({ latest: '99.0.0', seen: '99.0.0', checkedAt: Date.now() }));
  assert.ok(!strip(render(baseInput(), { env }).out).includes('⬆'), 'seen==latest -> dismissed');
  fs.writeFileSync(cache, JSON.stringify({ latest: '99.0.0', checkedAt: Date.now() - 40 * 86400 * 1000 }));
  assert.ok(!strip(render(baseInput(), { env }).out).includes('⬆'), 'stale check -> no nag');
  fs.writeFileSync(cache, JSON.stringify({ latest: '99.0.0', checkedAt: Date.now() }));
  assert.ok(!strip(render(baseInput(), { env: { ...env, NO_UPDATE_NOTIFIER: '1' } }).out).includes('⬆'), 'env opt-out');
});

// ---- cross-session board, resume-picker, compaction reinject ----
test('sessionBoard: off by default writes nothing; on, a live render publishes state that --board shows', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const boardDir = path.join(sb.home, '.claude-rig-sessions');
  render(baseInput({ session_id: 'b0', rate_limits: { five_hour: { used_percentage: 50 } } }), { env }); // default: off
  assert.ok(!fs.existsSync(boardDir), 'off by default -> no board dir');
  const script = scriptCopy(sb.dir, { sessionBoard: true });
  render(baseInput({ session_id: 'b1', workspace: { current_dir: '/work/myproj', project_dir: '/work/myproj' }, rate_limits: { five_hour: { used_percentage: 72 } } }), { env, script });
  assert.ok(fs.existsSync(path.join(boardDir, 'b1.json')), 'on -> board file written');
  const r = run(['--board'], { env, script });
  assert.match(r.out, /myproj/);
  assert.match(r.out, /1 live session/);
});

test('--board prunes stale entries (>1h) and only lists live ones', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const boardDir = path.join(sb.home, '.claude-rig-sessions'); fs.mkdirSync(boardDir, { recursive: true });
  fs.writeFileSync(path.join(boardDir, 'live.json'), JSON.stringify({ sid: 'live', project: 'nowproj', session: 30, ts: Date.now() }));
  fs.writeFileSync(path.join(boardDir, 'old.json'), JSON.stringify({ sid: 'old', project: 'oldproj', session: 10, ts: Date.now() - 2 * 3600 * 1000 }));
  const script = scriptCopy(sb.dir, { sessionBoard: true });
  const r = run(['--board'], { env, script });
  assert.match(r.out, /nowproj/);
  assert.ok(!r.out.includes('oldproj'), 'stale entry not listed');
  assert.ok(!fs.existsSync(path.join(boardDir, 'old.json')), 'stale entry pruned from disk');
});

test('--sessions lists recent transcripts with a resume command', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const proj = path.join(sb.cfg, 'projects', '-work-myproj'); fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'sess-xyz.jsonl'), [
    JSON.stringify({ type: 'user', cwd: '/work/myproj', message: { role: 'user', content: 'build the thing' } }),
  ].join('\n') + '\n');
  const r = run(['--sessions'], { env });
  assert.match(r.out, /myproj/);
  assert.match(r.out, /build the thing/);
  assert.match(r.out, /claude --resume sess-xyz/);
  assert.match(r.out, /cd '\/work\/myproj'/);
});

test('reinjectOnCompact re-injects a rules file on a compaction SessionStart', () => {
  const sb = sandbox();
  const proj = path.join(sb.dir, 'proj'); fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'ALWAYS use tabs. Never push to main.');
  const script = scriptCopy(sb.dir, { reinjectOnCompact: true });
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const r = hookRun('session-start', { session_id: 'rc1', source: 'compact', cwd: proj }, { env, script });
  const ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Never push to main/);
  assert.match(ctx, /compacted/);
  // on a fresh startup, nothing is injected
  assert.strictEqual(hookRun('session-start', { session_id: 'rc1', source: 'startup', cwd: proj }, { env, script }).out.trim(), '');
});

test('--whatsnew prints a changelog section', () => {
  const r = run(['--whatsnew']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /CCRig v/);
});

// note: the real-HTTP fetch path is unit-tested in-process in test-unit.js (fetchHttp*).
// A subprocess client cannot reach a parent-process localhost server in the sandbox, so
// that path is exercised there rather than via a spawned --check-update here.

test('--update refuses when a key is pinned but the signature is missing', () => {
  const crypto = require('crypto');
  const pub = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  const sb = sandbox();
  const remote = fakeRemote(path.join(sb.dir, 'remote'), '9.9.0'); // no .sig written
  const inst = path.join(sb.dir, 'inst'); fs.mkdirSync(inst, { recursive: true });
  const s = path.join(inst, 'statusline.js'); fs.copyFileSync(SCRIPT, s);
  fs.writeFileSync(path.join(inst, 'statusline.config.json'), JSON.stringify({ updatePubkey: pub }));
  const before = fs.readFileSync(s, 'utf8');
  const r = run(['--update'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_UPDATE_BASE: remote }, script: s });
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /no valid statusline\.js\.sig/);
  assert.strictEqual(fs.readFileSync(s, 'utf8'), before, 'unsigned -> file untouched');
});

test('config migration: a stale short `order` gets new segments unioned in (not silently dropped)', () => {
  const sb = sandbox();
  // an old order with none of the new segments; downgrade should still surface
  const script = scriptCopy(sb.dir, { order: ['profile', 'folder', 'model', 'git'] });
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const hot = { seven_day: { used_percentage: 88 } };
  render(baseInput({ session_id: 'mig1', model: { display_name: 'Opus 4.8' }, rate_limits: hot }), { env, script });
  const out = strip(render(baseInput({ session_id: 'mig1', model: { display_name: 'Sonnet 5' }, rate_limits: hot }), { env, script }).out);
  assert.match(out, /⬇ Sonnet/, 'downgrade segment migrated into a stale order');
});

// ===========================================================================
// harness hermeticity + Wave-0 unblocker regressions (TEST-01/02/03)
// ===========================================================================
// TEST-01: prove the suite never deletes host os.tmpdir() state. Planted before every
// test (including the --purge test) and checked after the whole run.
const HOST_TMP_CANARY = path.join(os.tmpdir(), 'ccbsl-usage-canary-' + process.pid + '.jsonl');
test.before(() => { try { fs.writeFileSync(HOST_TMP_CANARY, 'canary'); } catch {} });
test.after(() => {
  const survived = fs.existsSync(HOST_TMP_CANARY);
  try { fs.unlinkSync(HOST_TMP_CANARY); } catch {}
  assert.ok(survived, 'REGRESSION: the suite deleted a host os.tmpdir() canary (not hermetic to TMPDIR)');
});

test('REGRESSION: the default test script is isolated from the repo checkout', () => {
  assert.notStrictEqual(path.dirname(SCRIPT), __dirname);
  assert.ok(!fs.existsSync(path.join(path.dirname(SCRIPT), 'statusline.config.json')),
    'the clean script dir must have no statusline.config.json');
});

test('REGRESSION: host NO_UPDATE_NOTIFIER does not leak into spawned tests', () => {
  const sb = sandbox();
  const prev = process.env.NO_UPDATE_NOTIFIER;
  process.env.NO_UPDATE_NOTIFIER = '1';
  try {
    const now = Date.now();
    fs.writeFileSync(path.join(sb.cfg, '.ccbsl-update.json'),
      JSON.stringify({ current: '1.0.0', latest: '9.9.9', checkedAt: now, lastSuccessAt: now }));
    const out = strip(render(baseInput(), { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } }).out);
    assert.match(out, /⬆ v9\.9\.9/, 'update badge should still render; host NO_UPDATE_NOTIFIER must be scrubbed');
  } finally {
    if (prev === undefined) delete process.env.NO_UPDATE_NOTIFIER; else process.env.NO_UPDATE_NOTIFIER = prev;
  }
});

test('REGRESSION: --watch under CCBSL_NO_ACT never spawns claudeBin', () => {
  const sb = sandbox();
  const guardDir = path.join(sb.cfg, 'guardian');
  fs.mkdirSync(guardDir, { recursive: true });
  const marker = path.join(sb.dir, 'RELAUNCHED');
  const stub = path.join(sb.dir, 'claude-stub.sh');
  fs.writeFileSync(stub, '#!/bin/sh\ntouch "' + marker + '"\n');
  fs.chmodSync(stub, 0o755);
  const sid = 'watch-noact-1';
  // a checkpoint whose reset is already in the past -> the watcher fires on its first tick
  fs.writeFileSync(path.join(guardDir, sid + '.checkpoint.json'), JSON.stringify({
    session_id: sid, cwd: sb.dir, window: 'session',
    resets_at: Math.floor(Date.now() / 1000) - 60,
  }));
  const script = scriptCopy(sb.dir, { claudeBin: stub, autopilotBuffer: 0 });
  const r = run(['--watch', sid], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script });
  assert.strictEqual(r.code, 0, 'watcher exits cleanly under CCBSL_NO_ACT');
  assert.ok(!fs.existsSync(marker), 'claudeBin must NOT be spawned under CCBSL_NO_ACT');
  const log = fs.readFileSync(path.join(guardDir, 'logs', sid + '.log'), 'utf8');
  assert.match(log, /would relaunch/, 'watcher logs the suppressed relaunch');
});

test('REGRESSION: statusline.js exports DEFAULTS/DEFAULT_ORDER/MODES/helpText (quality-gate prereq)', () => {
  const SL = require(SCRIPT);
  assert.ok(SL.DEFAULTS && typeof SL.DEFAULTS === 'object', 'DEFAULTS exported');
  assert.ok(Array.isArray(SL.DEFAULT_ORDER) && SL.DEFAULT_ORDER.length > 0, 'DEFAULT_ORDER exported');
  assert.ok(Array.isArray(SL.MODES) && SL.MODES.includes('normal'), 'MODES exported');
  assert.strictEqual(typeof SL.helpText, 'function', 'helpText exported');
  assert.match(SL.helpText(), /--install/, 'helpText renders the flag list');
});

// ===========================================================================
// Wave 1: HIGH bugs + render quick wins (XPLAT-01, CLI-01, RENDER-01, RENDER-02)
// ===========================================================================
test("REGRESSION: a missing notifier binary never crashes the live render", () => {
  const sb = sandbox();
  const now = Math.floor(Date.now() / 1000);
  const script = scriptCopy(sb.dir, { autopilot: 'notify', updateCheck: false });
  const emptyBin = path.join(sb.dir, 'emptybin'); fs.mkdirSync(emptyBin, { recursive: true });
  const input = baseInput({
    session_id: 'xp1',
    rate_limits: { five_hour: { used_percentage: 99, resets_at: now + 3600 } },
  });
  // CCBSL_NO_ACT='' re-enables real spawns; an empty PATH makes the notifier binary ENOENT
  const r = render(input, { env: {
    CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home,
    CCBSL_NO_ACT: '', PATH: emptyBin, NO_UPDATE_NOTIFIER: '1',
  }, script });
  assert.strictEqual(r.code, 0, 'render must not crash when the notifier binary is missing');
  assert.ok(!/Unhandled 'error'/.test(r.out), 'no unhandled error event in the output');
});

test('REGRESSION: one-shot flags respect the exclusive gate', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const r1 = run(['--purge', '--install'], { env });
  assert.strictEqual(r1.code, 1, '--purge --install must exit 1');
  assert.match(r1.out, /pick one of/);
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'settings.json')), 'neither action ran');
  const r2 = run(['--disarm', '--purge'], { env });
  assert.strictEqual(r2.code, 1, '--disarm --purge must exit 1');
});

test('REGRESSION: a non-numeric reserveCols does not disable wrapping', () => {
  const SL = require(SCRIPT);
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { reserveCols: 'oops' });
  const out = render(baseInput({
    session_id: 'rc1',
    rate_limits: { five_hour: { used_percentage: 40 }, seven_day: { used_percentage: 30 } },
  }), { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, cols: '50', script }).out;
  for (const line of out.split('\n')) {
    assert.ok(SL.dispWidth(line) <= 50, 'line exceeds 50 cells (wrapping disabled): ' + strip(line));
  }
});

test('REGRESSION: hostile stdin degrades per-segment, never to the error banner', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  for (const stdin of ['null', '42', '"str"', '[]', '{"model":{"display_name":123}}', '{"workspace":42}', '{"session_name":99}']) {
    const r = run([], { stdin, env });
    assert.strictEqual(r.code, 0, 'exit 0 for stdin ' + stdin);
    assert.ok(!/statusline error/.test(r.out), 'no error banner for stdin ' + stdin);
    assert.ok(!fs.existsSync(path.join(sb.cfg, 'statusline-error.log')), 'no error log written for stdin ' + stdin);
  }
});

// ===========================================================================
// Wave 2: safety envelope + width + guardian state machine
// ===========================================================================
test('REGRESSION: a CJK folder does not overflow a narrow terminal', () => {
  const SL = require(SCRIPT);
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const out = render({ workspace: { current_dir: '/tmp/日本語のプロジェクト名前', project_dir: '/tmp/日本語のプロジェクト名前' }, model: { display_name: 'Opus 4.8' }, context_window: { used_percentage: 30 } }, { env, cols: '30' }).out;
  for (const line of out.split('\n')) assert.ok(SL.dispWidth(line) <= 30, 'CJK line exceeds 30 cells: ' + strip(line));
});

test('REGRESSION: the usage bar tracks the warn threshold, not yellow', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const now = Math.floor(Date.now() / 1000);
  const at = (p) => render(baseInput({ session_id: 'uc' + p, rate_limits: { five_hour: { used_percentage: p, resets_at: now + 3600 } } }), { env }).out;
  assert.ok(!at(85).includes('\x1b[38;5;203m'), 'no red anywhere at 85% (below warn 90)');
  assert.ok(at(91).includes('\x1b[38;5;203m'), 'red present at 91%');
});

test('REGRESSION: a second limit in a switched window re-arms/refreshes the checkpoint', () => {
  const sb = sandbox();
  const now = Math.floor(Date.now() / 1000);
  const script = scriptCopy(sb.dir, { autopilot: 'resume', autopilotWeekly: true, updateCheck: false });
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const sid = 'rearm1';
  const cpPath = path.join(sb.cfg, 'guardian', sid + '.checkpoint.json');
  render(baseInput({ session_id: sid, rate_limits: { five_hour: { used_percentage: 99, resets_at: now + 3600 }, seven_day: { used_percentage: 50, resets_at: now + 5 * 86400 } } }), { env, script });
  assert.strictEqual(JSON.parse(fs.readFileSync(cpPath, 'utf8')).window, 'session');
  render(baseInput({ session_id: sid, rate_limits: { five_hour: { used_percentage: 40, resets_at: now + 3600 }, seven_day: { used_percentage: 99, resets_at: now + 5 * 86400 } } }), { env, script });
  const cp = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
  assert.strictEqual(cp.window, 'weekly', 'checkpoint re-armed for the weekly window');
  assert.strictEqual(cp.resets_at, now + 5 * 86400);
});

test('REGRESSION: failover ignores a ledger entry with a traversal profile name', () => {
  const sb = sandbox();
  const now = Math.floor(Date.now() / 1000);
  const script = scriptCopy(sb.dir, { ledger: true, updateCheck: false });
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const ldir = path.join(sb.home, '.claude-usage-ledger'); fs.mkdirSync(ldir, { recursive: true });
  fs.writeFileSync(path.join(ldir, '.claude-evil.json'), JSON.stringify({ profile: '../../etc', session: 1, weekly: 1, ts: now }));
  const crit = baseInput({ session_id: 'fo1', rate_limits: { five_hour: { used_percentage: 99, resets_at: now + 3600 } } });
  const out = strip(render(crit, { env, script }).out);
  assert.ok(!out.includes('..') && !out.includes('etc'), 'traversal profile never surfaces in a failover hint');
  fs.writeFileSync(path.join(ldir, '.claude-spare.json'), JSON.stringify({ profile: '.claude-spare', session: 1, weekly: 1, ts: now }));
  assert.match(strip(render(crit, { env, script }).out), /spare/, 'a valid profile still surfaces');
});

test('REGRESSION: guardian ignores an inline subagent (isSidechain) turn', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const script = scriptCopy(sb.dir, { keepWorking: true });
  const tp = transcript(sb.dir, [
    todoEntry([{ content: 'main', status: 'completed' }]),
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'sub', status: 'pending' }] } }] } },
  ]);
  const r = hookRun('stop', { session_id: 'sc1', transcript_path: tp }, { env, script });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out.trim(), '', 'a sidechain pending todo must not block stop');
});

test('REGRESSION: --uninstall from a moved copy removes the guardian hooks too', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const dirA = path.join(sb.dir, 'a'); fs.mkdirSync(dirA, { recursive: true });
  const scriptA = path.join(dirA, 'statusline.js'); fs.copyFileSync(SCRIPT, scriptA);
  run(['--install-guardian'], { env, script: scriptA });
  const dirB = path.join(sb.dir, 'b'); fs.mkdirSync(dirB, { recursive: true });
  const scriptB = path.join(dirB, 'statusline.js'); fs.copyFileSync(SCRIPT, scriptB);
  run(['--uninstall'], { env, script: scriptB });
  const j = JSON.parse(fs.readFileSync(path.join(sb.cfg, 'settings.json'), 'utf8'));
  const anyHook = j.hooks && ['Stop', 'SessionStart', 'PreCompact'].some((e) => Array.isArray(j.hooks[e]) && j.hooks[e].some((g) => g.hooks && g.hooks.some((h) => (h.command || '').includes('--hook'))));
  assert.ok(!anyHook, 'guardian hooks removed even though uninstall ran from a moved copy');
});

test('REGRESSION: --uninstall leaves a LIVE third-party statusline.js untouched', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const bin = path.join(sb.home, 'bin'); fs.mkdirSync(bin, { recursive: true });
  const foreign = path.join(bin, 'statusline.js'); fs.writeFileSync(foreign, '// someone else\n');
  fs.writeFileSync(path.join(sb.cfg, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'node "' + foreign + '"' } }));
  const r = run(['--uninstall'], { env });
  assert.ok(JSON.parse(fs.readFileSync(path.join(sb.cfg, 'settings.json'), 'utf8')).statusLine, 'live foreign statusline.js preserved');
  assert.match(r.out, /left untouched|nothing to remove/);
});

test('REGRESSION: --doctor fails on a dead UNQUOTED statusLine command', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.cfg, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'node /dead/nowhere/statusline.js' } }));
  const r = run(['--doctor'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /do not exist/);
});

test('REGRESSION: --doctor fails when guardian hook paths are dead', () => {
  const sb = sandbox();
  const gn = process.execPath;
  const hc = (slug) => '"' + gn + '" "/dead/gone/statusline.js" --hook ' + slug;
  fs.writeFileSync(path.join(sb.cfg, 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: '"' + gn + '" "' + SCRIPT + '"' },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: hc('stop') }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: hc('session-start') }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: hc('pre-compact') }] }],
    },
  }));
  const r = run(['--doctor'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /guardian hook|re-run --install-guardian/);
});

test('REGRESSION: --doctor flags a stale /statusline-config command path', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  run(['--install'], { env });
  const scp = path.join(sb.cfg, 'commands', 'statusline-config.md');
  fs.writeFileSync(scp, fs.readFileSync(scp, 'utf8').split(SCRIPT).join('/dead/moved/statusline.js'));
  const r = run(['--doctor'], { env });
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /statusline-config command points at a missing script|re-run --install/);
});

test('REGRESSION: replacing a foreign status line is announced and its backup survives a second install', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  fs.writeFileSync(path.join(sb.cfg, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: '/usr/local/bin/my-custom-bar --fancy' } }));
  const first = run(['--install'], { env });
  assert.match(first.out, /Replaced the status line/);
  run(['--install'], { env });
  const backups = fs.readdirSync(sb.cfg).filter((f) => f.startsWith('settings.json.bak'));
  assert.ok(backups.some((f) => fs.readFileSync(path.join(sb.cfg, f), 'utf8').includes('my-custom-bar')), 'a backup still holds the original custom bar');
});

test('REGRESSION: --install does not wire a marker-less .claude-* directory', () => {
  const sb = sandbox();
  const foreign = path.join(sb.home, '.claude-code-router'); fs.mkdirSync(foreign, { recursive: true });
  const r = run(['--install'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  assert.strictEqual(r.code, 0);
  assert.ok(!fs.existsSync(path.join(foreign, 'settings.json')), 'a foreign tool dir must not be wired');
});

test('REGRESSION: --uninstall removes the /statusline-config command even when the status line is foreign', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  run(['--install'], { env });
  const sp = path.join(sb.cfg, 'settings.json');
  const j = JSON.parse(fs.readFileSync(sp, 'utf8')); j.statusLine = { type: 'command', command: 'npx other-bar' };
  fs.writeFileSync(sp, JSON.stringify(j));
  run(['--uninstall'], { env });
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'commands', 'statusline-config.md')), 'slash command removed even for a foreign bar');
});

test('REGRESSION: --install summary does not claim all profiles wired when one was skipped', () => {
  const sb = sandbox();
  const personal = path.join(sb.home, '.claude-personal');
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, 'settings.json'), '{broken');
  const r = run(['--install'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  assert.ok(!/All your Claude profiles now show the bar/.test(r.out), 'no false all-profiles claim');
  assert.match(r.out, /of 2|skipped/);
});

test('REGRESSION: an unknown flag errors instead of rendering', () => {
  const r = run(['--instal'], { stdin: '{}' });
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /unknown flag/);
});

test('--purge names its target profile', () => {
  const sb = sandbox();
  const r = run(['--purge'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  assert.strictEqual(r.code, 0);
  assert.ok(r.out.includes(sb.cfg), '--purge output names the profile dir');
});

test('REGRESSION: --sessions resume command is runnable on this platform', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const proj = path.join(sb.cfg, 'projects', '-tmp-proj'); fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'abc-123.jsonl'), JSON.stringify({ cwd: '/tmp/proj', type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
  const out = run(['--sessions'], { env }).out;
  // Windows uses PowerShell-native syntax ($env: + ; separators); POSIX uses inline env + &&.
  if (process.platform === 'win32') assert.match(out, /\$env:CLAUDE_CONFIG_DIR=/);
  else assert.match(out, /cd '/);
});

test('REGRESSION: writeJsonAtomic never strands a .tmp file', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  fs.mkdirSync(path.join(sb.cfg, '.ccbsl-update.json'), { recursive: true }); // force renameSync to fail
  const base = path.join(sb.dir, 'ub'); fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'statusline.js'), "const VERSION = '1.0.1';\n");
  run(['--check-update'], { env: { ...env, CCBSL_UPDATE_BASE: base } });
  assert.ok(fs.readdirSync(sb.cfg).every((f) => !f.endsWith('.tmp')), 'no stranded .tmp in the config dir');
});

test('resetStyle clock24 renders 24-hour times', () => {
  const sb = sandbox();
  const now = Math.floor(Date.now() / 1000);
  const script = scriptCopy(sb.dir, { resetStyle: 'clock24' });
  const out = strip(render(baseInput({ session_id: 'c24', rate_limits: { five_hour: { used_percentage: 20, resets_at: now + 3 * 3600 + 25 * 60 } } }), { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script }).out);
  assert.match(out, /↺\d{2}:\d{2}\b/, 'a 24-hour HH:MM reset time');
  assert.ok(!/↺\d{1,2}:\d{2}[ap]\b/.test(out), 'no 12-hour a/p suffix');
});

// ===========================================================================
// Wave 3: update subsystem + perf
// ===========================================================================
test('REGRESSION: the update badge stays suppressed after a failed check refreshes a 40-day-old cache', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const old = Date.now() - 40 * 86400 * 1000;
  fs.writeFileSync(path.join(sb.cfg, '.ccbsl-update.json'), JSON.stringify({ current: '1.0.1', latest: '99.0.0', checkedAt: old, lastSuccessAt: old }));
  run(['--check-update'], { env: { ...env, CCBSL_UPDATE_BASE: path.join(sb.dir, 'nope-does-not-exist') } }); // fails: refreshes checkedAt, NOT lastSuccessAt
  const out = strip(render(baseInput(), { env }).out);
  assert.ok(!out.includes('⬆'), 'a failed check must not resurrect a stale badge');
});

test('--dismiss-update silences the badge for the cached version', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const now = Date.now();
  fs.writeFileSync(path.join(sb.cfg, '.ccbsl-update.json'), JSON.stringify({ current: '1.0.1', latest: '9.9.9', checkedAt: now, lastSuccessAt: now }));
  assert.match(run(['--dismiss-update'], { env }).out, /dismissed/);
  assert.ok(!strip(render(baseInput(), { env }).out).includes('⬆'), 'badge gone after dismiss');
});

test('REGRESSION: --update in a repo whose remote merely CONTAINS ccrig uses the download path', () => {
  const sb = sandbox();
  const { execFileSync } = require('child_process');
  const repo = path.join(sb.dir, 'repo'); fs.mkdirSync(repo, { recursive: true });
  const s = path.join(repo, 'statusline.js');
  const G = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore', timeout: 8000 });
  try {
    G('init', '-q');
    G('config', 'user.email', 't@t.co'); G('config', 'user.name', 't'); G('config', 'commit.gpgsign', 'false');
    G('remote', 'add', 'origin', 'https://gitlab.invalid/mccrigan/dotfiles.git'); // CONTAINS "ccrig" but not as a path segment
    fs.copyFileSync(SCRIPT, s);
    G('add', 'statusline.js'); G('commit', '-q', '-m', 'x');
  } catch { return; } // git unavailable -> skip
  const base = path.join(sb.dir, 'rem'); fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'statusline.js'), fs.readFileSync(SCRIPT, 'utf8').replace(/const VERSION = '[^']+'/, "const VERSION = '99.0.0'"));
  fs.copyFileSync(path.join(__dirname, 'CHANGELOG.md'), path.join(base, 'CHANGELOG.md'));
  const r = run(['--update'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_UPDATE_BASE: base }, script: s });
  assert.ok(!/git pull/.test(r.out), 'must not take the git-pull path for an unrelated remote');
  assert.match(r.out, /Updated v.+ to v99|What changed/, 'took the download path');
});

test('REGRESSION: --update --force re-applies the same version (repair a modified copy)', () => {
  const sb = sandbox();
  const inst = path.join(sb.dir, 'inst'); fs.mkdirSync(inst, { recursive: true });
  const s = path.join(inst, 'statusline.js'); fs.copyFileSync(SCRIPT, s);
  const pristine = fs.readFileSync(SCRIPT, 'utf8');
  fs.appendFileSync(s, '\n// locally corrupted\n');
  const base = path.join(sb.dir, 'rem'); fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'statusline.js'), pristine);
  fs.copyFileSync(path.join(__dirname, 'CHANGELOG.md'), path.join(base, 'CHANGELOG.md'));
  const noForce = run(['--update'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_UPDATE_BASE: base }, script: s });
  assert.match(noForce.out, /already on/, 'without --force, same-version is a no-op');
  const r = run(['--update', '--force'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_UPDATE_BASE: base }, script: s });
  assert.match(r.out, /Updated|Verified/);
  assert.strictEqual(fs.readFileSync(s, 'utf8'), pristine, 'file repaired to the pristine remote');
  assert.ok(fs.readdirSync(inst).some((f) => f.startsWith('statusline.js.bak')), 'a backup was written');
});

// ===========================================================================
// Wave 4: shell + coverage gaps (SHELL-02, TEST-09)
// ===========================================================================
const _posixShells = ['bash', 'zsh'].filter((s) => {
  try { require('child_process').execFileSync(s, ['-c', 'true'], { stdio: 'ignore' }); return true; } catch { return false; }
});
// claude-profiles.sh is a POSIX (bash/zsh) helper with no Windows equivalent; skip where no such shell exists.
test('REGRESSION: claude-profile rejects slashed/dot-dot profile names (bash + zsh)', { skip: _posixShells.length === 0 && 'no POSIX shell (bash/zsh) on this host' }, () => {
  const { spawnSync } = require('child_process');
  const sh = path.join(__dirname, 'claude-profiles.sh');
  for (const shell of _posixShells) {
    const sb = sandbox();
    const victim = path.join(path.dirname(sb.home), 'outside-victim');
    const r = spawnSync(shell, ['-c', 'source "' + sh + '"; claude-profile new "x/../../outside-victim"'], { env: { ...process.env, HOME: sb.home }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, shell + ': a slashed name must be rejected');
    assert.ok(!fs.existsSync(victim), shell + ': nothing created outside the .claude-* namespace');
  }
});

test('--board notes when sessionBoard is off and lists no live sessions', () => {
  const sb = sandbox();
  const r = run(['--board'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /session board is off|No sessions are active/);
});

test('billing shows api for ANTHROPIC_AUTH_TOKEN too', () => {
  const sb = sandbox();
  const out = strip(render(baseInput(), { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, ANTHROPIC_AUTH_TOKEN: 'x' } }).out);
  assert.match(out, /💳 api/);
});

test('reinjectOnCompact re-injects an absolute rules file, capped at 8000 chars', () => {
  const sb = sandbox();
  const rules = path.join(sb.dir, 'RULES.md');
  fs.writeFileSync(rules, 'RULETOKEN ' + 'x'.repeat(9000));
  const script = scriptCopy(sb.dir, { reinjectOnCompact: rules });
  const r = hookRun('session-start', { session_id: 'ric1', source: 'compact', cwd: sb.dir }, { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script });
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /RULETOKEN/, 'the rules file is re-injected on a compaction');
});

// ===========================================================================
// autopilotBypassPermissions: the unattended relaunch can bypass permission prompts (opt-in)
// ===========================================================================
function armedCheckpoint(cfg, dir, sid) {
  const gd = path.join(cfg, 'guardian'); fs.mkdirSync(gd, { recursive: true });
  fs.writeFileSync(path.join(gd, sid + '.checkpoint.json'), JSON.stringify({
    session_id: sid, cwd: dir, window: 'session', resets_at: Math.floor(Date.now() / 1000) - 60,
  }));
}
// A cross-platform executable stub the product can spawn as `claude`: a node recorder plus a launcher
// this platform can run (a .cmd shim on Windows, which relaunchResume's winLaunch resolves back to
// node against the .js; a #!/usr/bin/env node script on POSIX). `body` runs with `fs` in scope.
function nodeStub(dir, name, body) {
  const js = path.join(dir, name + '.js');
  fs.writeFileSync(js, '#!/usr/bin/env node\nconst fs=require("fs");\n' + body + '\n');
  if (process.platform === 'win32') {
    const cmd = path.join(dir, name + '.cmd');
    fs.writeFileSync(cmd, '@node "' + js + '" %*\r\n');
    return cmd;
  }
  fs.chmodSync(js, 0o755);
  return js;
}
function recordingStub(dir, argsFile) {
  return nodeStub(dir, 'claude-record', 'fs.writeFileSync(' + JSON.stringify(argsFile) + ', process.argv.slice(2).join("\\n") + "\\n");');
}

test('autopilotBypassPermissions off (default): the relaunch does NOT bypass permissions', () => {
  const sb = sandbox();
  const sid = 'byp-off';
  const argsFile = path.join(sb.dir, 'args-off.txt');
  const stub = recordingStub(sb.dir, argsFile);
  const script = scriptCopy(sb.dir, { claudeBin: stub, autopilotBuffer: 0, updateCheck: false });
  armedCheckpoint(sb.cfg, sb.dir, sid);
  // CCBSL_NO_ACT='' re-enables the real relaunch so the stub records the argv
  run(['--watch', sid], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_NO_ACT: '' }, script });
  const args = fs.readFileSync(argsFile, 'utf8');
  assert.ok(!/bypassPermissions/.test(args), 'no permission bypass by default');
  assert.match(args, /--resume/);
  assert.match(args, /-p/);
});

test('autopilotBypassPermissions on: the relaunch passes --permission-mode bypassPermissions', () => {
  const sb = sandbox();
  const sid = 'byp-on';
  const argsFile = path.join(sb.dir, 'args-on.txt');
  const stub = recordingStub(sb.dir, argsFile);
  const script = scriptCopy(sb.dir, { claudeBin: stub, autopilotBuffer: 0, updateCheck: false, autopilotBypassPermissions: true });
  armedCheckpoint(sb.cfg, sb.dir, sid);
  run(['--watch', sid], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_NO_ACT: '' }, script });
  const args = fs.readFileSync(argsFile, 'utf8').split('\n');
  const i = args.indexOf('--permission-mode');
  assert.ok(i >= 0 && args[i + 1] === 'bypassPermissions', 'passes --permission-mode bypassPermissions');
  assert.ok(args.includes('--resume') && args.includes(sid), 'still resumes the exact session');
});

test('--options reports the bypass-permissions setting', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { autopilotBypassPermissions: true });
  const r = run(['--options'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script });
  assert.match(r.out, /bypass perms:\s*on/);
});

// ===========================================================================
// END-TO-END: the limit pause -> wait-for-reset -> resume-exactly flow, emulated
// in full (real detached watcher, a stub `claude` that records the relaunch).
// CCBSL_WATCH_INTERVAL_MS shrinks the watcher's 30s poll so the real timeline
// runs in a few seconds. This is the flagship guardian test.
// ===========================================================================
test('END-TO-END: guardian checkpoints at the limit, WAITS for the reset, then auto-resumes exactly where it left off', async () => {
  const { execFileSync } = require('child_process');
  const sb = sandbox();
  // a real git repo so the checkpoint captures HEAD + a dirty tree (the reconcile hint)
  const repo = path.join(sb.dir, 'proj'); fs.mkdirSync(repo, { recursive: true });
  let gitReady = false;
  try {
    const G = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore', timeout: 8000 });
    G('init', '-q'); G('config', 'user.email', 't@t.co'); G('config', 'user.name', 't'); G('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'billing.js'), 'module.exports = 1;\n');
    G('add', '-A'); G('commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(repo, 'billing.js'), 'module.exports = 2; // wip\n'); // leave the tree dirty
    gitReady = true;
  } catch { /* git absent: still exercises the todo/request/resume core */ }

  // the exact work state at the moment the limit hits: one done, one in-progress, one pending
  const tp = transcript(sb.dir, [
    userEntry('Refactor the billing module and add regression tests'),
    todoEntry([
      { content: 'Read the billing module', status: 'completed', activeForm: 'Reading the billing module' },
      { content: 'Refactor calculateTotal', status: 'in_progress', activeForm: 'Refactoring calculateTotal' },
      { content: 'Add regression tests', status: 'pending', activeForm: 'Adding regression tests' },
    ]),
  ]);

  const sid = 'e2e-resume-1';
  const marker = path.join(sb.dir, 'RELAUNCH_ARGS.txt');
  // emulate `claude`: record every argument (the last is the resume prompt) AND the profile it ran under
  const stub = nodeStub(sb.dir, 'claude-emu', 'fs.writeFileSync(' + JSON.stringify(marker) + ', process.argv.slice(2).join("\\n") + "\\nCFG=" + (process.env.CLAUDE_CONFIG_DIR || "") + "\\n");');

  const script = scriptCopy(sb.dir, { autopilot: 'resume', autopilotBuffer: 0, updateCheck: false, claudeBin: stub });
  const gd = path.join(sb.cfg, 'guardian');
  const now = Math.floor(Date.now() / 1000);
  const resetIn = 4; // seconds until the window "resets"
  const input = {
    session_id: sid, session_name: 'billing refactor', transcript_path: tp,
    workspace: { current_dir: repo, project_dir: repo },
    model: { id: 'claude-opus-4-8[1m]', display_name: 'Opus 4.8' },
    context_window: { used_percentage: 55 },
    rate_limits: { five_hour: { used_percentage: 99, resets_at: now + resetIn }, seven_day: { used_percentage: 60, resets_at: now + 5 * 86400 } },
  };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const pidFile = path.join(gd, sid + '.watch.pid');
  const cpFile = path.join(gd, sid + '.checkpoint.json');
  const watcherPids = [];
  try {
    // 1) the live render at 99%: writes the checkpoint and arms a REAL detached watcher.
    //    CCBSL_NO_ACT='' re-enables the real spawn; CCBSL_WATCH_INTERVAL_MS makes the poll fast.
    const r = run([], { stdin: JSON.stringify(input), env: {
      CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_NO_ACT: '', CCBSL_NO_NOTIFY: '1', CCBSL_WATCH_INTERVAL_MS: '250', NO_UPDATE_NOTIFIER: '1',
    }, script });
    assert.strictEqual(r.code, 0, 'the render itself never fails');
    assert.match(strip(r.out), /limit imminent|autopilot armed/, 'the bar shows the armed state');

    // the checkpoint captured the exact left-off state
    const cp = JSON.parse(fs.readFileSync(cpFile, 'utf8'));
    assert.strictEqual(cp.window, 'session');
    assert.strictEqual(cp.resets_at, now + resetIn);
    assert.match(cp.last_request, /Refactor the billing module/);
    assert.strictEqual(cp.todos.length, 3);
    if (gitReady) { assert.ok(cp.git && cp.git.head, 'HEAD captured'); assert.strictEqual(cp.git.dirty, true, 'dirty tree captured'); }

    // the watcher is armed (an inspectable PID file) and has NOT fired yet (still before the reset)
    for (let i = 0; i < 20 && !fs.existsSync(pidFile); i++) await sleep(100);
    assert.ok(fs.existsSync(pidFile), 'watcher armed a PID file');
    watcherPids.push(parseInt(fs.readFileSync(pidFile, 'utf8').split('\n')[0], 10) || 0);
    assert.ok(!fs.existsSync(marker), 'the watcher must NOT relaunch before the reset (it waits in its tracks)');

    // 2) wait past the reset -> the watcher relaunches `claude --resume`
    for (let i = 0; i < 75 && !fs.existsSync(marker); i++) await sleep(200);
    assert.ok(fs.existsSync(marker), 'the watcher relaunched after the reset');
    const relaunch = fs.readFileSync(marker, 'utf8');

    // 3) it resumed the EXACT session, headless, picking up exactly where it left off
    assert.match(relaunch, /--resume/);
    assert.match(relaunch, new RegExp(sid));
    assert.match(relaunch, /(^|\n)-p(\n|$)/);
    assert.match(relaunch, /Refactor the billing module/, 'carries the original request');
    assert.match(relaunch, /Already DONE[\s\S]*Read the billing module/, 'tells it NOT to repeat the finished step');
    assert.match(relaunch, /Remaining TODO[\s\S]*Refactor calculateTotal[\s\S]*Add regression tests/, 'continues from the unfinished steps');
    assert.match(relaunch, /UNATTENDED/, 'flagged as an unattended relaunch');
    if (gitReady) assert.match(relaunch, /git status/, 'tells it to reconcile the working tree');
    // resumes UNDER THE OWNING PROFILE, not whatever profile the watcher inherited
    assert.ok(relaunch.includes('CFG=' + sb.cfg), 'relaunch pins CLAUDE_CONFIG_DIR to the session owner profile');

    // 4) the checkpoint is consumed once the relaunch starts, so it cannot double-run
    for (let i = 0; i < 20 && fs.existsSync(cpFile); i++) await sleep(100);
    assert.ok(!fs.existsSync(cpFile), 'checkpoint consumed after the relaunch');
  } finally {
    for (const pid of watcherPids) { try { if (pid) process.kill(pid); } catch {} }
  }
});

test('END-TO-END: if the user manually resumes during the wait, the watcher stands down instead of double-running', async () => {
  const sb = sandbox();
  const sid = 'e2e-standdown-1';
  const marker = path.join(sb.dir, 'RELAUNCH2.txt');
  const stub = path.join(sb.dir, 'claude-emu2.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$@" > "' + marker + '"\n'); fs.chmodSync(stub, 0o755);
  const script = scriptCopy(sb.dir, { autopilot: 'resume', autopilotBuffer: 0, updateCheck: false, claudeBin: stub });
  const gd = path.join(sb.cfg, 'guardian'); fs.mkdirSync(gd, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  // a transcript that will be touched AFTER the reset -> looks like the user picked it back up by hand
  const tp = transcript(sb.dir, [userEntry('do the thing'), todoEntry([{ content: 'step', status: 'pending' }])]);
  fs.writeFileSync(path.join(gd, sid + '.checkpoint.json'), JSON.stringify({
    session_id: sid, cwd: sb.dir, window: 'session', resets_at: now - 1, transcript_path: tp,
  }));
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const watcherPids = [];
  try {
    // touch the transcript "after" the reset (mtime > resets_at + 2) so resumedManuallySince() is true
    const future = (now + 10) * 1000; fs.utimesSync(tp, future / 1000, future / 1000);
    const r = run(['--watch', sid], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_NO_ACT: '', CCBSL_NO_NOTIFY: '1', CCBSL_WATCH_INTERVAL_MS: '200' }, script });
    assert.strictEqual(r.code, 0);
    await sleep(400);
    assert.ok(!fs.existsSync(marker), 'a manual resume means the watcher must NOT also relaunch');
    const log = fs.readFileSync(path.join(gd, 'logs', sid + '.log'), 'utf8');
    assert.match(log, /standing down/);
  } finally {
    for (const pid of watcherPids) { try { if (pid) process.kill(pid); } catch {} }
  }
});

// ===========================================================================
// LIMIT-RECOVERY HARDENING (G1/G2/G6/G7): the guardian's job is to survive a usage
// limit, but the limit shows as a plain error the user recovers from in-session (a
// plan upgrade or /usage-credits grows the quota) or that arrives without a >=critical
// render. These encode the four verified gaps from the limit-behavior audit.
// ===========================================================================

// G1: a window that was armed at the limit but RECOVERED before its reset (quota grew
// mid-window) must disarm — otherwise the watcher relaunches on stale, finished work.
test('G1: autopilot disarms when the armed window recovers mid-cycle', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { autopilot: 'resume' });
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const now = Math.floor(Date.now() / 1000);
  const cpFile = path.join(sb.cfg, 'guardian', 'rec1.checkpoint.json');
  render(baseInput({ session_id: 'rec1', rate_limits: { five_hour: { used_percentage: 99, resets_at: now + 3600 } } }), { env, script });
  assert.ok(fs.existsSync(cpFile), 'armed at the limit');
  // same active window, but usage is now well below warn -> quota grew (upgrade / extra usage)
  render(baseInput({ session_id: 'rec1', rate_limits: { five_hour: { used_percentage: 30, resets_at: now + 3600 } } }), { env, script });
  assert.ok(!fs.existsSync(cpFile), 'recovered -> checkpoint dropped so the watcher stands down');
});

// G1 guard: a MISSING usage reading (rate_limits can drop out while blocked) is not recovery.
test('G1: a null usage reading does NOT falsely disarm', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { autopilot: 'resume' });
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const now = Math.floor(Date.now() / 1000);
  const cpFile = path.join(sb.cfg, 'guardian', 'rec2.checkpoint.json');
  render(baseInput({ session_id: 'rec2', rate_limits: { five_hour: { used_percentage: 99, resets_at: now + 3600 } } }), { env, script });
  assert.ok(fs.existsSync(cpFile));
  render(baseInput({ session_id: 'rec2', rate_limits: {} }), { env, script }); // no five_hour at all
  assert.ok(fs.existsSync(cpFile), 'absent usage keeps the checkpoint armed');
});

// G2: a checkpoint is written from the WARN band, so a wall that arrives with no >=critical
// render still leaves recovery state — and it upgrades to a critical snapshot at critical.
test('G2: guardian checkpoints from the warn band and upgrades it at critical', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { autopilot: 'notify' });
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const now = Math.floor(Date.now() / 1000);
  const cpFile = path.join(sb.cfg, 'guardian', 'warn1.checkpoint.json');
  const tp = transcript(sb.dir, [userEntry('do the work'), todoEntry([{ content: 'step', status: 'pending' }])]);
  const out = strip(render(baseInput({ session_id: 'warn1', transcript_path: tp, rate_limits: { five_hour: { used_percentage: 93, resets_at: now + 600 } } }), { env, script }).out);
  assert.match(out, /near limit/);
  let cp = JSON.parse(fs.readFileSync(cpFile, 'utf8'));
  assert.match(cp.reason, /near/, 'warn-band checkpoint marked "near"');
  assert.strictEqual(cp.window, 'session');
  // the same session then crosses critical -> the checkpoint is upgraded
  render(baseInput({ session_id: 'warn1', transcript_path: tp, rate_limits: { five_hour: { used_percentage: 99, resets_at: now + 600 } } }), { env, script });
  cp = JSON.parse(fs.readFileSync(cpFile, 'utf8'));
  assert.match(cp.reason, /critical/, 'upgraded to a critical checkpoint at critical usage');
});

// G2 invariant: opting OUT (autopilot off) still checkpoints NOTHING, even at warn.
test('G2: autopilot:off writes no checkpoint at the warn band', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { autopilot: 'off' });
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const now = Math.floor(Date.now() / 1000);
  render(baseInput({ session_id: 'warn2', rate_limits: { five_hour: { used_percentage: 93, resets_at: now + 600 } } }), { env, script });
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'guardian', 'warn2.checkpoint.json')), 'no guardian side effect when opted out');
});

// continuous-refresh (default-on): the guardian checkpoints from the warn band with no opt-in.
test('continuous-refresh: the default guardian checkpoints from the warn band', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const now = Math.floor(Date.now() / 1000);
  const tp = transcript(sb.dir, [userEntry('do it'), todoEntry([{ content: 'step', status: 'pending' }])]);
  render(baseInput({ session_id: 'cr1', transcript_path: tp, rate_limits: { five_hour: { used_percentage: 92, resets_at: now + 600 } } }), { env });
  const cp = JSON.parse(fs.readFileSync(path.join(sb.cfg, 'guardian', 'cr1.checkpoint.json'), 'utf8'));
  assert.match(cp.reason, /near/, 'warn-band checkpoint written by default (no opt-in)');
});

// G7: a PRE-reset manual peek must not forfeit auto-resume — inject context, stay armed.
test('G7: a pre-reset resume keeps the checkpoint and watcher armed', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { autopilot: 'resume' });
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const gdir = path.join(sb.cfg, 'guardian'); fs.mkdirSync(gdir, { recursive: true });
  const future = Math.floor(Date.now() / 1000) + 3600;
  fs.writeFileSync(path.join(gdir, 'peek1.checkpoint.json'), JSON.stringify({ session_id: 'peek1', cwd: '/tmp/proj', window: 'session', reason: 'session limit critical', resets_at: future, todos: [{ content: 'finish it', status: 'pending' }], last_request: 'do it' }));
  const r = hookRun('session-start', { session_id: 'peek1', source: 'resume' }, { env, script });
  const ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /finish it/, 'still injects the checkpoint context');
  assert.match(ctx, /still armed/, 'tells the user auto-resume survives the peek');
  assert.ok(fs.existsSync(path.join(gdir, 'peek1.checkpoint.json')), 'checkpoint NOT consumed before the reset');
});

// G7: once the reset has passed, a human resume consumes the checkpoint as before.
test('G7: a post-reset resume consumes the checkpoint (unchanged)', () => {
  const sb = sandbox();
  const script = scriptCopy(sb.dir, { autopilot: 'resume' });
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const gdir = path.join(sb.cfg, 'guardian'); fs.mkdirSync(gdir, { recursive: true });
  const past = Math.floor(Date.now() / 1000) - 10;
  fs.writeFileSync(path.join(gdir, 'peek2.checkpoint.json'), JSON.stringify({ session_id: 'peek2', cwd: '/tmp/proj', window: 'session', reason: 'session limit critical', resets_at: past, todos: [{ content: 'finish it', status: 'pending' }], last_request: 'do it' }));
  const r = hookRun('session-start', { session_id: 'peek2', source: 'resume' }, { env, script });
  assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /finish it/);
  assert.ok(!fs.existsSync(path.join(gdir, 'peek2.checkpoint.json')), 'checkpoint consumed once the reset has passed');
});

// G6: a relaunch that launches but exits non-zero (still blocked / auth / network) must KEEP
// the checkpoint for a manual resume instead of consuming it and reporting a false success.
test('END-TO-END: a failed relaunch keeps the checkpoint (no false success)', async () => {
  const sb = sandbox();
  const sid = 'e2e-fail-1';
  const stub = nodeStub(sb.dir, 'claude-fail', 'process.exit(7);'); // emulate a resume that dies immediately
  const script = scriptCopy(sb.dir, { autopilot: 'resume', autopilotBuffer: 0, updateCheck: false, claudeBin: stub });
  const gd = path.join(sb.cfg, 'guardian'); fs.mkdirSync(gd, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  const tp = transcript(sb.dir, [userEntry('do it'), todoEntry([{ content: 'step', status: 'pending' }])]);
  const cpFile = path.join(gd, sid + '.checkpoint.json');
  fs.writeFileSync(cpFile, JSON.stringify({ session_id: sid, cwd: sb.dir, window: 'session', resets_at: now - 1, transcript_path: tp, todos: [{ content: 'step', status: 'pending' }] }));
  // real spawn (CCBSL_NO_ACT='') so the watcher actually launches the stub and sees its exit code
  const r = run(['--watch', sid], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_NO_ACT: '', CCBSL_NO_NOTIFY: '1', CCBSL_WATCH_INTERVAL_MS: '200' }, script });
  assert.strictEqual(r.code, 1, 'the watcher itself exits non-zero when the relaunch fails');
  const log = fs.readFileSync(path.join(gd, 'logs', sid + '.log'), 'utf8');
  assert.match(log, /exited code=7/, 'recorded the non-zero exit');
  assert.ok(fs.existsSync(cpFile), 'checkpoint KEPT after a failed relaunch so a manual resume still works');
});

// ===========================================================================
// profile-aware resume: a session belongs to a profile, and every resume path
// must resume UNDER that profile (not whatever profile the shell is set to).
// ===========================================================================
test('--sessions spans every profile and pins CLAUDE_CONFIG_DIR per session', () => {
  const sb = sandbox();
  // a work session (default ~/.claude) and a personal session (~/.claude-personal)
  const personal = path.join(sb.home, '.claude-personal');
  fs.mkdirSync(path.join(personal, 'projects', '-p-app'), { recursive: true });
  fs.writeFileSync(path.join(personal, 'projects', '-p-app', 'psess-1.jsonl'),
    JSON.stringify({ type: 'user', cwd: '/p/app', message: { role: 'user', content: 'personal work' } }) + '\n');
  fs.mkdirSync(path.join(sb.cfg, 'projects', '-w-app'), { recursive: true });
  fs.writeFileSync(path.join(sb.cfg, 'projects', '-w-app', 'wsess-1.jsonl'),
    JSON.stringify({ type: 'user', cwd: '/w/app', message: { role: 'user', content: 'work work' } }) + '\n');
  const r = run(['--sessions'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  assert.strictEqual(r.code, 0);
  // both profiles' sessions listed
  assert.match(r.out, /psess-1/, 'personal-profile session listed');
  assert.match(r.out, /wsess-1/, 'work-profile session listed');
  assert.match(r.out, /\[personal\]/, 'rows are labelled with their profile');
  // each resume command pins the OWNING profile's config dir
  assert.ok(r.out.includes('CLAUDE_CONFIG_DIR=' + shellQuoteJs(personal) + ' claude --resume psess-1')
    || r.out.includes('CLAUDE_CONFIG_DIR=\'' + personal + '\' claude --resume psess-1')
    || r.out.includes('$env:CLAUDE_CONFIG_DIR=\'' + personal + '\'; claude --resume psess-1'),
    'personal session resume pins the personal profile:\n' + r.out);
  assert.ok(r.out.includes('claude --resume wsess-1') && r.out.includes('CLAUDE_CONFIG_DIR='),
    'work session resume pins a profile');
});

test('a resume ticket pins the owning profile so it resumes on the right account', () => {
  const sb = sandbox();
  const personal = path.join(sb.home, '.claude-personal', '.claude'); // treat this cfg as the owner
  const cfg = path.join(sb.home, '.claude-personal');
  fs.mkdirSync(cfg, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  const input = baseInput({
    session_id: 'tick-1', session_name: 'personal task',
    workspace: { current_dir: '/p/app', project_dir: '/p/app' },
    rate_limits: { five_hour: { used_percentage: 99, resets_at: now + 3600 } },
  });
  // resumeTickets are on by default; render at critical under the personal profile writes one
  run([], { stdin: JSON.stringify(input), env: { CLAUDE_CONFIG_DIR: cfg, HOME: sb.home } });
  const ticket = fs.readFileSync(path.join(cfg, 'resume-tickets', 'tick-1.md'), 'utf8');
  assert.match(ticket, /Profile: personal/, 'names the owning profile');
  assert.ok(ticket.includes('CLAUDE_CONFIG_DIR=') && ticket.includes(cfg) && ticket.includes('claude --resume tick-1'),
    'the ticket command pins CLAUDE_CONFIG_DIR to the owning profile:\n' + ticket);
});
