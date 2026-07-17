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
    env: { ...process.env, COLUMNS: '120', ...env },
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
  fs.writeFileSync(path.join(sb.cfg, 'settings.json'), JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: 'x' } }));
  const r = run(['--uninstall'], { env });
  assert.strictEqual(r.code, 0);
  const j = JSON.parse(fs.readFileSync(path.join(sb.cfg, 'settings.json'), 'utf8'));
  assert.strictEqual(j.statusLine, undefined);
  assert.strictEqual(j.model, 'opus');
  const again = run(['--uninstall'], { env });
  assert.strictEqual(again.code, 0);
  assert.match(again.out, /nothing to remove/);
});

test('REGRESSION: --uninstall on a read-only settings.json fails gracefully, no stack trace', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const sb = sandbox();
  const sp = path.join(sb.cfg, 'settings.json');
  fs.writeFileSync(sp, JSON.stringify({ statusLine: { command: 'x' } }));
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
  const r = run(['--config'], { stdin: '2\ns\n', env: { CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home }, script });
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
