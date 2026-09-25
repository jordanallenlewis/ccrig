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
  assert.deepStrictEqual(lin.args, ['--', 't', 'm'], 'a label starting with "-" is never parsed as an option');
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
  // stub DNS so the direct path fails locally instead of touching the network (the suite is hermetic)
  const dns = require('dns'); const realLookup = dns.lookup;
  dns.lookup = (h, o, cb) => { (typeof o === 'function' ? o : cb)(Object.assign(new Error('stubbed'), { code: 'ENOTFOUND' })); };
  try { await new Promise((resolve) => SL.httpGetText('http://sub.example.com/x', 0, () => resolve())); } // resolves via error or data; we only care about the proxy
  finally { dns.lookup = realLookup; }
  proxy.close();
  for (const k of ['HTTP_PROXY', 'NO_PROXY']) { if (restore[k] === undefined) delete process.env[k]; else process.env[k] = restore[k]; }
  assert.strictEqual(proxyHits, 0, 'a *.example.com host must bypass the proxy (direct, not via proxy)');
});

// ---------------------------------------------------------------------------
// Session-board lamps (v1.7.0). All pure: state classification, sanitization, ping dedupe.
const DECAY = 30 * 60000;

test('cleanLabel: strips control bytes, collapses whitespace, caps length', () => {
  assert.strictEqual(SL.cleanLabel('\x1b[31mRED\x1b[0m'), '[31mRED [0m', 'ESC becomes a space, so what is left is inert text');
  assert.ok(!SL.cleanLabel('\x1b[31mRED').includes('\x1b'), 'no ESC survives');
  assert.ok(!SL.cleanLabel('a\x9b31mb').includes('\x9b'), 'the 8-bit CSI is removed too');
  assert.strictEqual(SL.cleanLabel('a\x7fb'), 'a b', 'DEL becomes a space');
  assert.strictEqual(SL.cleanLabel('  a\n\tb  '), 'a b', 'newlines and tabs collapse to one space');
  assert.strictEqual(SL.cleanLabel('abcdef', 3), 'abc');
  assert.strictEqual(SL.cleanLabel(undefined), '', 'a non-string is empty, never a crash');
  assert.strictEqual(SL.cleanLabel(12345), '');
  // REGRESSION: capping by UTF-16 unit split a surrogate pair, and the lone half made the macOS
  // notifier's AppleScript literal a syntax error, so the "waiting on you" ping never arrived.
  const rockets = SL.cleanLabel('a' + '\u{1F680}'.repeat(40), 32);
  assert.ok(!/[\uD800-\uDBFF]$/.test(rockets), 'never ends on a lone high surrogate');
  assert.strictEqual([...rockets].length, 32, 'the cap counts code points');
});

test('padCell: pads to exact display width for ASCII, CJK, and emoji', () => {
  for (const s of ['', 'abc', '日本語', '🚀x', 'a日b']) {
    assert.strictEqual(SL.dispWidth(SL.padCell(s, 10)), 10, JSON.stringify(s) + ' pads to 10 cells');
  }
  assert.strictEqual(SL.padCell('abc', 3), 'abc', 'an exact fit is untouched');
  assert.ok(SL.padCell('abcdefgh', 4).startsWith('abc'), 'overflow truncates');
  assert.ok(SL.padCell('abcdefgh', 4).includes('…'), 'overflow is marked');
  assert.strictEqual(SL.dispWidth(SL.padCell('日本語プロ', 5)), 5, 'a wide overflow still lands on the column');
});

test('sessionLabel: env > project file > session_name > folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbsl-unit-label-'));
  const proj = path.join(root, 'myproj');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  const prev = process.env.CCRIG_SESSION_NAME;
  try {
    delete process.env.CCRIG_SESSION_NAME; // the developer's own shell may export it: this test owns the var
    assert.strictEqual(SL.sessionLabel({}, proj), 'myproj', 'folder name is the floor');
    assert.strictEqual(SL.sessionLabel({ session_name: 'cc name' }, proj), 'cc name');
    fs.writeFileSync(path.join(proj, '.claude', 'ccrig-name'), 'file label\nignored second line\n');
    assert.strictEqual(SL.sessionLabel({ session_name: 'cc name' }, proj), 'file label', 'the project file wins over session_name');
    process.env.CCRIG_SESSION_NAME = 'env label';
    assert.strictEqual(SL.sessionLabel({ session_name: 'cc name' }, proj), 'env label', 'the env var wins over the file');
    delete process.env.CCRIG_SESSION_NAME;
    fs.writeFileSync(path.join(proj, '.claude', 'ccrig-name'), '\x1b[31mred\x1b[0m\n');
    assert.ok(!SL.sessionLabel({}, proj).includes('\x1b'), 'a label from disk is sanitized');
  } finally {
    if (prev === undefined) delete process.env.CCRIG_SESSION_NAME; else process.env.CCRIG_SESSION_NAME = prev;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('lampSupersedes: clock wins when ordered, priority wins inside 1.5s', () => {
  const now = 1700000000000;
  assert.ok(SL.lampSupersedes(null, { state: 'done', at: now }), 'no previous stamp -> write');
  assert.ok(SL.lampSupersedes({ state: 'nonsense', at: now }, { state: 'done', at: now }), 'a corrupt stamp -> write');
  assert.ok(!SL.lampSupersedes({ state: 'blocked', at: now }, { state: 'done', at: now + 200 }),
    'a Stop 200ms after a block must not paint over the red lamp');
  assert.ok(SL.lampSupersedes({ state: 'blocked', at: now }, { state: 'done', at: now + 2000 }),
    'a Stop two seconds later is a real transition');
  assert.ok(SL.lampSupersedes({ state: 'working', at: now }, { state: 'blocked', at: now + 10 }),
    'blocked outranks working in a tie');
  assert.ok(SL.lampSupersedes({ state: 'done', at: now }, { state: 'done', at: now + 10 }), 'equal priority refreshes');
});

test('lampFor: event state, decay, self-heal, and liveness', () => {
  const now = 1700000000000;
  const fresh = { ts: now - 2000 };
  assert.strictEqual(SL.lampFor(fresh, null, now, DECAY), 'ready', 'a live session with no lamp yet (fresh, /clear, resume) is ready, not working');
  assert.strictEqual(SL.lampFor({ ts: now - 20 * 60000 }, null, now, DECAY), 'idle', 'a stale heartbeat is idle');
  assert.strictEqual(SL.lampFor(fresh, { state: 'working', at: now - 1000 }, now, DECAY), 'working');
  assert.strictEqual(SL.lampFor(fresh, { state: 'blocked', at: now - 1000, tsize: 0 }, now, DECAY), 'blocked',
    'an unknown transcript size never self-heals');
  assert.strictEqual(SL.lampFor({ ts: now - 2000, tsize: 500 }, { state: 'blocked', at: now - 1000, tsize: 100 }, now, DECAY), 'working',
    'the transcript grew past the prompt: the session moved on');
  assert.strictEqual(SL.lampFor({ ts: now - 2000, tsize: 100 }, { state: 'blocked', at: now - 1000, tsize: 100 }, now, DECAY), 'blocked',
    'the transcript did not grow: still waiting on you');
  assert.strictEqual(SL.lampFor({ ts: now - 90 * 60000 }, { state: 'blocked', at: now - 90 * 60000, tsize: 5 }, now, DECAY), 'idle',
    'a closed terminal cannot pin a red row forever');
  assert.strictEqual(SL.lampFor(fresh, { state: 'done', since: now - (DECAY - 1000) }, now, DECAY), 'done', 'just inside the decay window');
  assert.strictEqual(SL.lampFor(fresh, { state: 'done', since: now - DECAY }, now, DECAY), 'idle', 'the boundary is inclusive');
  assert.strictEqual(SL.lampFor(fresh, { state: 'garbage', at: now }, now, DECAY), 'ready', 'an unknown state degrades, never throws');
  assert.strictEqual(SL.lampFor(null, null, now, DECAY), 'idle', 'a missing record is idle');
  // REGRESSION: the bar stops redrawing the moment a session finishes, so gating `done` on the
  // 10-minute liveness window capped green at 10 minutes and made boardDecayMinutes inert.
  assert.strictEqual(SL.lampFor({ ts: now - 11 * 60000 }, { state: 'done', since: now - 60000 }, now, DECAY), 'done',
    'a session that finished a minute ago is green even though its heartbeat stopped 11 minutes ago');
  assert.strictEqual(SL.lampFor({ ts: now - 11 * 60000 }, { state: 'done', since: now - 60000 }, now, 30000), 'idle',
    'a short decay window still greys it out');
  // a shared board dir can hold a record from a machine whose clock is ahead
  assert.strictEqual(SL.lampFor({ ts: now + 86400000 }, null, now, DECAY), 'ready', 'a future heartbeat reads as fresh, never as negative age');
  assert.strictEqual(SL.lampFor(fresh, { state: 'done', since: now + 86400000 }, now, DECAY), 'done', 'a future `since` does not instantly decay');
});

test('lampPings: one ping per blocked stamp, never one per poll', () => {
  const seen = new Map();
  const row = (sid, lampKey, at, since) => ({ sid, lampKey, lamp: { state: 'blocked', at, since: since == null ? at : since }, e: {} });
  const blocked = [row('s1', 'blocked', 1000)];
  assert.strictEqual(SL.lampPings(blocked, seen, true).length, 0, 'the first frame seeds silently');
  assert.strictEqual(SL.lampPings(blocked, seen, false).length, 0, 'the same stamp does not ping again');
  assert.strictEqual(SL.lampPings([row('s1', 'blocked', 2000)], seen, false).length, 1, 'a new stamp pings');
  assert.strictEqual(SL.lampPings([row('s1', 'working', 2000)], seen, false).length, 0, 'leaving blocked never pings');
  assert.strictEqual(SL.lampPings([row('s1', 'blocked', 3000)], seen, false).length, 1, 'and blocking again pings once more');
  // REGRESSION: a second permission prompt carries `since` forward from the first, and the healed
  // frame between them is easy for a 2s poll to miss. Keying the dedupe on `since` swallowed this ping.
  assert.strictEqual(SL.lampPings([row('s1', 'blocked', 4000, 3000)], seen, false).length, 1,
    'a back-to-back second prompt still pings, even with since carried forward');
});

test('winLaunch resolves both npm cmd-shim spellings (%dp0% and %~dp0) to node + cli.js', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrig-shim-'));
  try {
    fs.mkdirSync(path.join(dir, 'node_modules', 'fake'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'fake', 'cli.js'), '');
    for (const spell of ['%dp0%', '%~dp0']) {
      const shim = path.join(dir, 'claude' + (spell === '%dp0%' ? 'A' : 'B') + '.cmd');
      fs.writeFileSync(shim, '@ECHO off\r\nSET PATHEXT=%PATHEXT:;.JS;=;%\r\n"%_prog%"  "' + spell + '/node_modules/fake/cli.js" %*\r\n');
      const wl = SL.winLaunch(shim);
      assert.ok(wl, spell + ' resolved');
      assert.strictEqual(wl.cmd, process.execPath);
      assert.strictEqual(path.resolve(wl.pre[0]), path.join(dir, 'node_modules', 'fake', 'cli.js'));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('parseJsonText tolerates a UTF-8 BOM', () => {
  assert.deepStrictEqual(SL.parseJsonText('﻿{"a":1}'), { a: 1 });
  assert.throws(() => SL.parseJsonText('{bad'));
});

test('glyphWidth: BMP emoji with emoji presentation are two cells', () => {
  for (const ch of ['✅', '❌', '⭐', '☕', '⌛', '✨']) assert.strictEqual(SL.dispWidth(ch), 2, ch);
  assert.strictEqual(SL.dispWidth('⬆'), 1, 'text-presentation arrows stay one cell');
});

test('httpGetText refuses a truncated body and an unframed one', async () => {
  const net = require('net');
  const replies = [
    'HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n' + 'x'.repeat(40),   // cut short
    'HTTP/1.0 200 OK\r\n\r\n' + 'y'.repeat(40),                                                // no framing
    'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello',                  // whole
  ];
  let i = 0;
  const srv = net.createServer((c) => { c.once('data', () => { c.end(replies[i++]); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/x';
  const get = () => new Promise((r) => SL.httpGetText(url, 0, (e, d) => r({ e, d })));
  try {
    for (const k of ['HTTP_PROXY', 'http_proxy']) delete process.env[k];
    assert.match(String((await get()).e), /truncated|aborted/);
    assert.match(String((await get()).e), /no length framing/);
    assert.strictEqual((await get()).d, 'hello');
  } finally { srv.close(); }
});

test('profileLabelOf: one naming rule, the same as claude-profile', () => {
  assert.strictEqual(SL.profileLabelOf('.claude'), 'default');
  assert.strictEqual(SL.profileLabelOf('.claude-work'), 'work');
  assert.strictEqual(SL.profileLabelOf('claude-alt'), 'claude-alt', 'a custom dir keeps its own name, as the helpers show it');
});

test('latestTodos: reads TaskCreate / TaskUpdate when there is no TodoWrite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrig-tasks-'));
  const tp = path.join(dir, 't.jsonl');
  const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const res = (id, text) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
  fs.writeFileSync(tp, [use('a', 'TaskCreate', { subject: 'write parser' }), res('a', 'Task #1 created successfully'),
    use('b', 'TaskCreate', { subject: 'add tests' }), res('b', 'Task #2 created successfully'),
    use('c', 'TaskCreate', { subject: 'scratch' }), res('c', 'Task #3 created successfully'),
    use('d', 'TaskUpdate', { taskId: '1', status: 'completed' }), use('e', 'TaskUpdate', { taskId: '3', status: 'deleted' }),
    use('f', 'TaskUpdate', { taskId: '2', status: 'in_progress' })].map((x) => JSON.stringify(x)).join('\n') + '\n');
  try {
    assert.deepStrictEqual(SL.latestTodos(tp, true).map((t) => [t.content, t.status]), [['write parser', 'completed'], ['add tests', 'in_progress']]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
