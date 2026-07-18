#!/usr/bin/env node
/*
 * Test suite for claude-code-better-status-line. Zero dependencies: Node's built-in
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

const SCRIPT = path.join(__dirname, 'statusline.js');
const NODE = process.execPath;

// every sandbox lives under one scratch root, removed at the end
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-test-'));
test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

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
  const r = spawnSync(NODE, [script, ...args], {
    input: stdin,
    encoding: 'utf8',
    timeout: 15000,
    // CCBSL_NO_ACT keeps the guardian from spawning real notifications / watcher
    // processes during tests; file side effects (checkpoints, tickets) still run.
    env: { ...process.env, COLUMNS: '120', CCBSL_NO_ACT: '1', ...env },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function render(input, { env = {}, script = SCRIPT, cols = '120' } = {}) {
  return run([], { stdin: JSON.stringify(input), env: { ...env, COLUMNS: cols }, script });
}
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
  // guard: only when no key is inherited from the outer environment
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) assert.ok(!strip(none.out).includes('💳'));
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
  const env = { HOME: sb.home };
  const onDefault = strip(render(baseInput(), { env: { ...env, CLAUDE_CONFIG_DIR: sb.cfg } }).out);
  assert.match(onDefault, /👤/);
  const onAcme = strip(render(baseInput(), { env: { ...env, CLAUDE_CONFIG_DIR: path.join(sb.home, '.claude-acme') } }).out);
  assert.match(onAcme, /👤 acme/);
});

test('profileLabels config overrides the derived label', () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.home, '.claude-x'), { recursive: true });
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
    rate_limits: { five_hour: { used_percentage: 96, resets_at: future } },
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
  const out = strip(render(baseInput({ rate_limits: { five_hour: { used_percentage: 95 } } }), { env, script, cols: '200' }).out);
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
  assert.match(run(['--version']).out, /claude-code-better-status-line v\d+\.\d+\.\d+/);
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

test('--install preserves unrelated settings keys', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.cfg, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { a: 1 } }));
  run(['--install'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home } });
  const j = JSON.parse(fs.readFileSync(path.join(sb.cfg, 'settings.json'), 'utf8'));
  assert.strictEqual(j.model, 'opus');
  assert.deepStrictEqual(j.hooks, { a: 1 });
  assert.ok(j.statusLine);
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
  assert.match(r.out, /uninstall failed/);
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
  fs.symlinkSync(path.join(sb.dir, 'target'), path.join(sb.cfg, '.caveman-active'));
  assert.ok(!strip(render(baseInput(), { env }).out).includes('CAVEMAN'), 'symlinked flag refused');
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
function seedSamples(sid, samples) { fs.writeFileSync(path.join(os.tmpdir(), 'ccbsl-usage-' + strHash(sid) + '.jsonl'), samples.map((s) => JSON.stringify(s)).join('\n') + '\n'); }
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
  assert.match(d.out, /disarmed 1/);
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

test('REGRESSION: plain install (autopilot off) writes NO checkpoint/notify at critical — only the ticket', () => {
  const sb = sandbox();
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home };
  const input = baseInput({ session_id: 'plain1', rate_limits: { five_hour: { used_percentage: 99, resets_at: Math.floor(Date.now() / 1000) + 600 } } });
  const out = strip(render(input, { env }).out); // default config -> autopilot 'off'
  assert.match(out, /limit imminent/);
  assert.ok(fs.existsSync(path.join(sb.cfg, 'resume-tickets', 'plain1.md')), 'resume ticket still written (documented base feature)');
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'guardian', 'plain1.checkpoint.json')), 'no guardian checkpoint without opting in');
  assert.ok(!fs.existsSync(path.join(sb.cfg, 'guardian', 'plain1.notified')), 'no desktop-notification side effect');
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
  assert.strictEqual(cfg.autopilot, 'notify', 'safe default until --auto');
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
  assert.match(r.out, /update available: v99\.1\.0/);
  const info = JSON.parse(fs.readFileSync(path.join(sb.cfg, '.ccbsl-update.json'), 'utf8'));
  assert.strictEqual(info.latest, '99.1.0');
  assert.ok(info.notes && info.notes.includes('99.1.0'), 'changelog notes captured');
});

test('--check-update on an unreachable source fails silently (exit 0, no crash)', () => {
  const sb = sandbox();
  const r = run(['--check-update'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_UPDATE_BASE: path.join(sb.dir, 'does-not-exist') } });
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /update check failed/);
});

test('--update applies a newer version with a backup (standalone copy)', () => {
  const sb = sandbox();
  const inst = path.join(sb.dir, 'inst'); fs.mkdirSync(inst, { recursive: true });
  const instScript = path.join(inst, 'statusline.js');
  fs.copyFileSync(SCRIPT, instScript);
  const remote = fakeRemote(path.join(sb.dir, 'remote'), '99.2.0');
  const r = run(['--update'], { env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_UPDATE_BASE: remote }, script: instScript });
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /updated v.+ -> v99\.2\.0/);
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
  assert.match(r.out, /refusing to apply/);
  assert.strictEqual(fs.readFileSync(instScript, 'utf8'), before, 'original untouched');
});

test('--update refuses to downgrade without --force, applies with it', () => {
  const sb = sandbox();
  const inst = path.join(sb.dir, 'inst'); fs.mkdirSync(inst, { recursive: true });
  const instScript = path.join(inst, 'statusline.js'); fs.copyFileSync(SCRIPT, instScript);
  const remote = fakeRemote(path.join(sb.dir, 'old'), '1.0.0');
  const env = { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, CCBSL_UPDATE_BASE: remote };
  const before = fs.readFileSync(instScript, 'utf8');
  const r = run(['--update'], { env, script: instScript });
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /not newer/);
  assert.strictEqual(fs.readFileSync(instScript, 'utf8'), before, 'not downgraded');
  const f = run(['--update', '--force'], { env, script: instScript });
  assert.strictEqual(f.code, 0);
  assert.match(fs.readFileSync(instScript, 'utf8'), /const VERSION = '1\.0\.0'/, 'force downgrades');
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

test('--whatsnew prints a changelog section', () => {
  const r = run(['--whatsnew']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /claude-code-better-status-line v/);
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
