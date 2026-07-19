#!/usr/bin/env node
/*
 * Unit tests for ccrig. These require statusline.js as a
 * module (it exports its pure helpers when required, and does NOT run the CLI), so
 * they test the internal logic directly and fast — complementing the black-box
 * subprocess suite in test.js. Zero dependencies (node:test, Node 18+). Run:
 *   node --test test-unit.js     (or: node --test  to run both files)
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SL = require('./statusline.js');

// ---------------------------------------------------------------------------
test('semverGt: dotted numeric comparison, each field', () => {
  assert.ok(SL.semverGt('2.0.0', '1.9.9'));
  assert.ok(SL.semverGt('2.1.0', '2.0.9'));
  assert.ok(SL.semverGt('2.0.1', '2.0.0'));
  assert.ok(!SL.semverGt('2.0.0', '2.0.0'), 'equal is not greater');
  assert.ok(!SL.semverGt('2.0.0', '2.1.0'));
  assert.ok(SL.semverGt('2.1', '2.0.9'), 'missing patch treated as 0');
  assert.ok(!SL.semverGt('bad', '1.0.0'), 'non-numeric is 0.0.0, never greater');
  assert.ok(SL.semverGt('10.0.0', '9.9.9'), 'numeric, not lexicographic');
});

test('modelTier: opus>sonnet>haiku>unknown, case-insensitive', () => {
  assert.strictEqual(SL.modelTier('Opus 4.8 (1M context)'), 3);
  assert.strictEqual(SL.modelTier('claude-opus-4-8[1m]'), 3);
  assert.strictEqual(SL.modelTier('Sonnet 5'), 2);
  assert.strictEqual(SL.modelTier('HAIKU 4.5'), 1);
  assert.strictEqual(SL.modelTier('Gemini'), 0);
  assert.strictEqual(SL.modelTier(''), 0);
  assert.strictEqual(SL.modelTier(null), 0);
  assert.ok(SL.modelTier('Opus') > SL.modelTier('Sonnet'));
  assert.ok(SL.modelTier('Sonnet') > SL.modelTier('Haiku'));
});

test('parseRemoteVersion: extracts VERSION, null on garbage', () => {
  assert.strictEqual(SL.parseRemoteVersion("const VERSION = '3.4.5';"), '3.4.5');
  assert.strictEqual(SL.parseRemoteVersion("const VERSION  =  '10.20.30' ;"), '10.20.30');
  assert.strictEqual(SL.parseRemoteVersion('<html>proxy error</html>'), null);
  assert.strictEqual(SL.parseRemoteVersion(''), null);
  assert.strictEqual(SL.parseRemoteVersion("const VERSION = '2.2.0-rc1';"), null, 'non-numeric suffix degrades to null (safe no-op)');
});

test('parseChangelogTop: skips [Unreleased], grabs first released section', () => {
  const md = '# Changelog\n\n## [Unreleased]\n- wip\n\n## [2.2.0] - 2026-07-18\n\n### Added\n- a thing\n- another\n\n## [2.1.0]\n- old\n';
  const top = SL.parseChangelogTop(md);
  assert.match(top, /\[2\.2\.0\]/);
  assert.match(top, /- a thing/);
  assert.ok(!top.includes('- old'), 'stops at the next heading');
  assert.ok(!top.includes('wip'), 'skips Unreleased');
  assert.strictEqual(SL.parseChangelogTop(''), '');
  assert.strictEqual(SL.parseChangelogTop('# Changelog\n\nno versions here'), '');
});

test('dispWidth: strips ANSI, counts emoji as 2 cells', () => {
  assert.strictEqual(SL.dispWidth('abc'), 3);
  assert.strictEqual(SL.dispWidth('\x1b[38;5;203mabc\x1b[0m'), 3, 'ANSI is zero-width');
  assert.strictEqual(SL.dispWidth('🤖'), 2, 'emoji = 2');
  assert.strictEqual(SL.dispWidth('⚡'), 2);
  assert.strictEqual(SL.dispWidth('⏳'), 2, 'hourglass U+23F3 is emoji-presentation, 2 cells');
  assert.strictEqual(SL.dispWidth('⬆'), 1, 'up-arrow is text-presentation, 1 cell');
  assert.strictEqual(SL.dispWidth('⬇'), 1, 'down-arrow is text-presentation, 1 cell');
  assert.strictEqual(SL.dispWidth('a🌿b'), 4);
});

test('deepMerge: nested override, arrays replaced, base untouched', () => {
  const base = { a: 1, b: { c: 2, d: 3 }, arr: [1, 2] };
  const out = SL.deepMerge(base, { b: { d: 9 }, arr: [3] });
  assert.strictEqual(out.a, 1);
  assert.strictEqual(out.b.c, 2, 'untouched nested key kept');
  assert.strictEqual(out.b.d, 9, 'nested override applied');
  assert.deepStrictEqual(out.arr, [3], 'arrays replaced, not merged');
  assert.strictEqual(base.b.d, 3, 'base object not mutated');
});

test('truncFolder: keeps the tail with an ellipsis', () => {
  assert.strictEqual(SL.truncFolder('short', 20), 'short');
  const t = SL.truncFolder('a-very-long-folder-name-here', 10);
  assert.ok(t.length <= 10);
  assert.ok(t.startsWith('…'), 'ellipsis prefix');
  assert.ok(t.endsWith('here'), 'keeps the most specific tail');
});

test('fmtReset: "now" for a passed reset, a string for the future', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.strictEqual(SL.fmtReset(now - 100), 'now');
  assert.strictEqual(typeof SL.fmtReset(now + 3600), 'string');
  assert.ok(SL.fmtReset(now + 3600).length > 0);
});

test('inflightAgents: Task tool_use without a tool_result is in-flight', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbsl-unit-'));
  const tp = path.join(dir, 't.jsonl');
  fs.writeFileSync(tp, [
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'x1', name: 'Task', input: { description: 'alpha' } },
      { type: 'tool_use', id: 'x2', name: 'Task', input: { description: 'beta' } },
    ] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x1' }] } }),
  ].join('\n') + '\n');
  const inflight = SL.inflightAgents(tp);
  assert.strictEqual(inflight.length, 1, 'one still running');
  assert.strictEqual(inflight[0].desc, 'beta');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepStrictEqual(SL.inflightAgents('/no/such/file'), [], 'missing transcript -> empty, no throw');
});

test('resumePromptFromCheckpoint: same-account vs cross-account wording', () => {
  const cp = { reason: 'session limit critical', last_request: 'ship it', todos: [
    { content: 'wrote tests', status: 'completed' }, { content: 'ship', status: 'in_progress' },
  ], git: { head: 'abcdef1234567890', dirty: true }, agents: ['build worker'] };
  const attended = SL.resumePromptFromCheckpoint(cp, false, false);
  assert.match(attended, /transcript above is intact/);
  assert.match(attended, /do NOT redo/);
  assert.match(attended, /build worker/);
  assert.ok(!attended.includes('UNATTENDED'), 'attended resume must NOT claim unattended');
  const unattended = SL.resumePromptFromCheckpoint(cp, false, true);
  assert.match(unattended, /UNATTENDED/, 'watcher relaunch is flagged unattended');
  const cross = SL.resumePromptFromCheckpoint(cp, true, true);
  assert.match(cross, /transcript is NOT here/, 'cross-account tells the truth about the missing transcript');
  assert.ok(!cross.includes('transcript above is intact'));
});

test('fetchHttp: fetchText GETs over real HTTP and follows a redirect (in-process)', async () => {
  const http = require('http');
  const server = http.createServer((req, res) => {
    if (req.url === '/r/x') { res.writeHead(302, { location: '/x' }); res.end(); }
    else if (req.url === '/x') { res.writeHead(200); res.end('hello-body'); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const got = await new Promise((resolve) => SL.fetchText(`http://127.0.0.1:${port}/r/x`, (e, d) => resolve(e ? 'ERR:' + e.message : d)));
  server.close();
  assert.strictEqual(got, 'hello-body', 'followed the 302 and returned the body');
});

test('fetchHttp: fetchText delivers HTTP errors and reads a local path', async () => {
  const http = require('http');
  const server = http.createServer((req, res) => { res.writeHead(500); res.end('nope'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const err = await new Promise((resolve) => SL.fetchText(`http://127.0.0.1:${port}/x`, (e) => resolve(e && e.message)));
  server.close();
  assert.match(err, /HTTP 500/, 'non-200 surfaces as an error, once');
  // local-path branch (CCBSL_UPDATE_BASE pointing at a dir)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbsl-ft-'));
  fs.writeFileSync(path.join(dir, 'f'), 'localdata');
  const local = await new Promise((resolve) => SL.fetchText(path.join(dir, 'f'), (e, d) => resolve(e ? 'ERR' : d)));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(local, 'localdata');
});

test('bar: fills proportionally and clamps', () => {
  const t = { green: 50, yellow: 80 };
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  assert.strictEqual(strip(SL.bar(0, 10, t)).replace(/█/g, '').length, 10, '0% -> no filled blocks');
  assert.strictEqual((strip(SL.bar(100, 10, t)).match(/█/g) || []).length, 10, '100% -> all filled');
  assert.strictEqual((strip(SL.bar(150, 10, t)).match(/█/g) || []).length, 10, 'clamped at 100%');
  assert.strictEqual((strip(SL.bar(50, 10, t)).match(/█/g) || []).length, 5, '50% -> half');
});

// ---------------------------------------------------------------------------
// Wave 2 units: RENDER-03/04, GUARD-04, XPLAT-04
test('glyphWidth/dispWidth: East Asian Wide counts as 2 cells', () => {
  assert.strictEqual(SL.dispWidth('漢字'), 4);
  assert.strictEqual(SL.dispWidth('ＡＢ'), 4, 'fullwidth latin');
  assert.strictEqual(SL.dispWidth('한글'), 4, 'Hangul');
  assert.strictEqual(SL.dispWidth('日本語'), 6, 'kanji');
  assert.strictEqual(SL.dispWidth('ｱｲｳ'), 3, 'halfwidth kana stays 1 cell');
  assert.strictEqual(SL.dispWidth('abc'), 3, 'ascii unchanged');
  assert.strictEqual(SL.dispWidth('🤖'), 2);
  assert.strictEqual(SL.dispWidth('👩‍💻'), 4, 'ZWJ sequence over-counts (conscious, safe: wraps early)');
  assert.strictEqual(SL.glyphWidth(0x200D), 0, 'ZWJ is zero-width');
  assert.strictEqual(SL.glyphWidth(0x4E00), 2);
  assert.strictEqual(SL.glyphWidth(0x41), 1);
});

test('truncFolder: cell-aware, never emits a lone surrogate', () => {
  const t = SL.truncFolder('😀😀😀😀😀', 6);
  assert.ok(![...t].some((ch) => { const c = ch.codePointAt(0); return c >= 0xD800 && c <= 0xDFFF; }), 'no lone surrogate');
  assert.ok(SL.dispWidth(t) <= 6);
  assert.ok(SL.dispWidth(SL.truncFolder('非常に長いフォルダ名です', 10)) <= 10, 'CJK folder shortened to its cell budget');
  assert.strictEqual(SL.truncFolder('short', 20), 'short', 'untouched when it fits');
});

test('bar: reserves the final block for a true 100%', () => {
  const t = { green: 50, yellow: 80 };
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const filled = (p, w) => (strip(SL.bar(p, w, t)).match(/█/g) || []).length;
  assert.ok(filled(94, 8) < 8, '94% must not read full');
  assert.strictEqual(filled(100, 8), 8, '100% fills all blocks');
  assert.strictEqual(filled(0, 10), 0);
  assert.strictEqual(filled(50, 10), 5);
});

test('watcherCmdMatches: only a --watch <sid> cmdline is ours', () => {
  assert.ok(SL.watcherCmdMatches('node statusline.js --watch abc', 'abc'));
  assert.ok(!SL.watcherCmdMatches('node other.js', 'abc'));
  assert.ok(!SL.watcherCmdMatches('node --watch xyz', 'abc'));
  assert.ok(!SL.watcherCmdMatches(null, 'abc'));
});

test('notifySpec: win32 keeps the payload out of code position (injection-safe)', () => {
  const title = 'Claude', msg = 'Fix $(Get-Date) `whoami` "x" bug';
  const w = SL.notifySpec('win32', title, msg);
  assert.ok(w.args.includes('-EncodedCommand'), 'uses -EncodedCommand');
  const script = Buffer.from(w.args[w.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.ok(script.includes('$env:CCBSL_N_TITLE') && script.includes('$env:CCBSL_N_MSG'), 'reads title/msg from env');
  assert.ok(!script.includes('Get-Date') && !script.includes('whoami'), 'payload is NOT embedded in the script');
  assert.strictEqual(w.env.CCBSL_N_TITLE, title);
  assert.strictEqual(w.env.CCBSL_N_MSG, msg);
  const mac = SL.notifySpec('darwin', 't', 'm');
  assert.strictEqual(mac.cmd, 'osascript');
  assert.ok(mac.args[1].includes('display notification'), 'macOS args shape unchanged');
  const lin = SL.notifySpec('linux', 't', 'm');
  assert.strictEqual(lin.cmd, 'notify-send');
  assert.deepStrictEqual(lin.args, ['t', 'm']);
});

// ---------------------------------------------------------------------------
// Wave 3 units: UPD-02/03/06/09
test('parseRemoteVersion: strict x.y.z (4-part or suffixed -> null)', () => {
  assert.strictEqual(SL.parseRemoteVersion("const VERSION = '99.2.0.1';"), null, '4-part is refused');
  assert.strictEqual(SL.parseRemoteVersion("const VERSION = '1.2.3';"), '1.2.3');
  assert.strictEqual(SL.parseRemoteVersion("const VERSION = '2.2.0-rc1';"), null);
});

test('maybeCheckUpdate: throttled on a fresh cache; gated by CCBSL_NO_ACT (no spawn)', () => {
  const prev = process.env.CCBSL_NO_ACT; process.env.CCBSL_NO_ACT = '1';
  try {
    assert.strictEqual(SL.maybeCheckUpdate({ checkedAt: Date.now() }), false, 'fresh cache -> throttled');
    assert.strictEqual(SL.maybeCheckUpdate(null), false, 'CCBSL_NO_ACT gates the spawn');
  } finally { if (prev === undefined) delete process.env.CCBSL_NO_ACT; else process.env.CCBSL_NO_ACT = prev; }
});

test('httpGetText refuses a redirect to a non-http(s) scheme', async () => {
  const http = require('http');
  const server = http.createServer((req, res) => { res.writeHead(302, { location: 'file:///etc/hosts' }); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const err = await new Promise((resolve) => SL.httpGetText('http://127.0.0.1:' + port + '/x', 0, (e) => resolve(e && e.message)));
  server.close();
  assert.match(err, /unsupported redirect/);
});

test('NO_PROXY *.example.com bypasses the proxy', async () => {
  const http = require('http');
  let proxyHits = 0;
  const proxy = http.createServer((req, res) => { proxyHits++; res.writeHead(200); res.end('via proxy'); });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const pport = proxy.address().port;
  const restore = { HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY };
  process.env.HTTP_PROXY = 'http://127.0.0.1:' + pport;
  process.env.NO_PROXY = '*.example.com';
  await new Promise((resolve) => SL.httpGetText('http://sub.example.com/x', 0, () => resolve())); // resolves via error or data; we only care about the proxy
  proxy.close();
  for (const k of ['HTTP_PROXY', 'NO_PROXY']) { if (restore[k] === undefined) delete process.env[k]; else process.env[k] = restore[k]; }
  assert.strictEqual(proxyHits, 0, 'a *.example.com host must bypass the proxy (direct, not via proxy)');
});
