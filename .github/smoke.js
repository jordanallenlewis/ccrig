#!/usr/bin/env node
'use strict';
// Cross-OS smoke test of the PACKAGED tool, run by CI on macOS, Linux and Windows (not shipped to npm).
// It exercises what the unit suite cannot: the command strings settings.json runs, executed through
// every shell Claude Code may use (sh, Git Bash, cmd, PowerShell 5.1 and 7); npm pack -> global install
// -> postinstall -> upgrade -> uninstall; an auto-resume relaunch through a real npm `claude` shim; and
// autoUpdate against the live npm registry. Every path has spaces, unicode and parentheses. It prints
// PASS/FAIL/INFO lines, runs every section even after a failure, and exits 1 if anything FAILed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const WIN = process.platform === 'win32';
const out = [];
function rec(kind, name, detail) {
  const line = kind + ' ' + name + (detail ? '\n      ' + String(detail).trim().split(/\r?\n/).slice(0, 25).join('\n      ') : '');
  out.push({ kind, name });
  console.log(line);
}
const PASS = (n, d) => rec('PASS', n, d), FAIL = (n, d) => rec('FAIL', n, d), INFO = (n, d) => rec('INFO', n, d);

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rig smoke ü-'));
const tmp = path.join(base, 'tmp'); fs.mkdirSync(tmp);
function mkHome(tag) { const h = path.join(base, 'home ' + tag); fs.mkdirSync(path.join(h, '.claude'), { recursive: true }); return h; }
function envFor(home, extra) {
  const e = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp, CCBSL_NO_NOTIFY: '1', NO_UPDATE_NOTIFIER: '1', COLUMNS: '120', ...(extra || {}) };
  for (const k of ['CLAUDE_CONFIG_DIR', 'CCBSL_UPDATE_BASE', 'CCRIG_SESSION_NAME']) delete e[k];
  if (!extra || !('CCBSL_NO_ACT' in extra)) e.CCBSL_NO_ACT = '1';
  if (extra && extra.CCBSL_NO_ACT === null) delete e.CCBSL_NO_ACT;
  return e;
}
function node(args, opts) { return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, ...opts }); }
function sh(cmd, opts) { return spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: 180000, ...opts }); }
const both = (r) => ((r.stdout || '') + (r.stderr || '') + (r.error ? '\n[spawn error] ' + r.error.message : '')).trim();
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return { __err: e.message }; } };

INFO('platform', `${process.platform} ${os.release()} node ${process.version} arch ${process.arch}\nbase=${base}`);

// shells to execute a settings.json command string through (what Claude Code might use)
const shells = [];
if (WIN) {
  for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']) if (fs.existsSync(p)) { shells.push({ name: 'git-bash', run: (c, o) => spawnSync(p, ['-c', c], { encoding: 'utf8', timeout: 60000, ...o }) }); break; }
  shells.push({ name: 'cmd(shell:true)', run: (c, o) => spawnSync(c, { shell: true, encoding: 'utf8', timeout: 60000, ...o }) });
  shells.push({ name: 'powershell -Command', run: (c, o) => spawnSync('powershell', ['-NoProfile', '-Command', c], { encoding: 'utf8', timeout: 60000, ...o }) });
  shells.push({ name: 'pwsh -Command', run: (c, o) => spawnSync('pwsh', ['-NoProfile', '-Command', c], { encoding: 'utf8', timeout: 60000, ...o }) });
} else {
  shells.push({ name: 'sh(shell:true)', run: (c, o) => spawnSync(c, { shell: true, encoding: 'utf8', timeout: 60000, ...o }) });
}

const renderInput = (cwd) => JSON.stringify({
  session_id: 'smoke-1', transcript_path: path.join(base, 'transcript.jsonl'), cwd,
  model: { id: 'claude-opus-4-8[1m]', display_name: 'Opus 4.8 (1M context)' }, effort: { level: 'high' },
  context_window: { used_percentage: 42 }, workspace: { current_dir: cwd, project_dir: cwd },
  rate_limits: { five_hour: { used_percentage: 30, resets_at: Math.floor(Date.now() / 1000) + 3600 }, seven_day: { used_percentage: 20, resets_at: Math.floor(Date.now() / 1000) + 86400 } },
});
fs.writeFileSync(path.join(base, 'transcript.jsonl'), '');

function allCommands(settings) {
  const cmds = [];
  if (settings.statusLine && settings.statusLine.command) cmds.push({ ev: 'statusLine', cmd: settings.statusLine.command });
  for (const [ev, groups] of Object.entries(settings.hooks || {})) for (const g of groups || []) for (const h of g.hooks || []) if (h && h.command) cmds.push({ ev, cmd: h.command });
  return cmds;
}
function execCommands(tag, settings, env) {
  for (const { ev, cmd } of allCommands(settings)) {
    for (const s of shells) {
      const input = ev === 'statusLine' ? renderInput(base)
        : JSON.stringify({ session_id: 'smoke-1', transcript_path: path.join(base, 'transcript.jsonl'), cwd: base, hook_event_name: ev, source: 'startup', prompt: 'hi', notification_type: 'permission_prompt', message: 'Claude needs your permission', reason: 'exit', stop_hook_active: false });
      const r = s.run(cmd, { input, env });
      const txt = both(r);
      if (ev === 'statusLine') {
        (r.status === 0 && /ctx/.test(txt) ? PASS : FAIL)(`${tag}: statusLine via ${s.name}`, `cmd=${cmd}\nexit=${r.status}\n${txt.slice(0, 600)}`);
      } else {
        let jsonOk = true; if ((r.stdout || '').trim()) { try { JSON.parse(r.stdout); } catch { jsonOk = false; } }
        ((r.status === 0 && jsonOk) ? PASS : FAIL)(`${tag}: hook ${ev} via ${s.name}`, `cmd=${cmd}\nexit=${r.status} jsonOk=${jsonOk}\n${txt.slice(0, 400)}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 1. standalone copy in a path with spaces/parens: install, run commands via shells, doctor, idempotency, uninstall
// ---------------------------------------------------------------------------
try {
  const home = mkHome('A (x) ü');
  const app = path.join(base, 'app dir (x86) ü');
  fs.mkdirSync(app, { recursive: true });
  for (const f of ['statusline.js', 'CHANGELOG.md']) fs.copyFileSync(path.join(REPO, f), path.join(app, f));
  const js = path.join(app, 'statusline.js');
  const env = envFor(home);
  let r = node([js, '--install'], { env });
  (r.status === 0 ? PASS : FAIL)('standalone --install', both(r).slice(0, 1500));
  const sp = path.join(home, '.claude', 'settings.json');
  let s = readJson(sp);
  INFO('settings after install', JSON.stringify(s, null, 1).slice(0, 2500));
  execCommands('standalone', s, env);
  r = node([js, '--doctor'], { env }); INFO('standalone --doctor exit=' + r.status, both(r).slice(0, 3000));
  node([js, '--install'], { env }); node([js, '--install'], { env });
  s = readJson(sp);
  const counts = {};
  for (const c of allCommands(s)) { const k = c.ev + ':' + ((c.cmd.match(/--hook (\S+)/) || [])[1] || 'bar'); counts[k] = (counts[k] || 0) + 1; }
  (Object.values(counts).every((n) => n === 1) ? PASS : FAIL)('install x3 idempotent hook counts (per slug)', JSON.stringify(counts));
  // BOM + CRLF settings (Notepad-style) must still be accepted and preserved
  const home2 = mkHome('BOM');
  fs.writeFileSync(path.join(home2, '.claude', 'settings.json'), '\uFEFF{\r\n  "model": "opus",\r\n  "env": { "FOO": "bar" }\r\n}\r\n');
  r = node([js, '--install'], { env: envFor(home2) });
  const s2 = readJson(path.join(home2, '.claude', 'settings.json'));
  ((r.status === 0 && s2.model === 'opus' && s2.statusLine) ? PASS : FAIL)('install over BOM+CRLF settings.json', both(r).slice(0, 800) + '\n' + JSON.stringify(s2).slice(0, 400));
  r = node([js, '--uninstall'], { env });
  s = readJson(sp);
  const left = allCommands(s).filter((c) => /statusline\.js/.test(c.cmd));
  ((r.status === 0 && left.length === 0) ? PASS : FAIL)('standalone --uninstall removes all our commands', both(r).slice(0, 800) + '\nleft=' + JSON.stringify(left));
} catch (e) { FAIL('standalone section threw', e.stack); }

// ---------------------------------------------------------------------------
// 2. npm lifecycle: pack -> global install into a prefix -> postinstall wiring -> bin shim -> init
//    -> config write -> upgrade to a bumped version -> path/config survival -> npm uninstall -> dangling refs
// ---------------------------------------------------------------------------
try {
  const home = mkHome('npm ü');
  const env = envFor(home);
  const prefix = path.join(base, 'npm prefix ü');
  const packDir = path.join(base, 'packs'); fs.mkdirSync(packDir);
  let r = sh(`npm pack --silent --pack-destination "${packDir}"`, { cwd: REPO, env: { ...env, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE } });
  const tgz1 = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  (tgz1 ? PASS : FAIL)('npm pack', both(r).slice(0, 500));
  const listing = sh(`tar -tzf "${path.join(packDir, tgz1)}"`, {}); INFO('tarball contents', both(listing));
  r = sh(`npm install -g --no-fund --no-audit --prefix "${prefix}" "${path.join(packDir, tgz1)}"`, { env });
  (r.status === 0 ? PASS : FAIL)('npm install -g --prefix (v1)', both(r).slice(0, 1500));
  const sp = path.join(home, '.claude', 'settings.json');
  let s = readJson(sp);
  INFO('settings after postinstall', JSON.stringify(s, null, 1).slice(0, 2000));
  const cmd1 = s.statusLine && s.statusLine.command;
  (cmd1 ? PASS : FAIL)('postinstall wired statusLine', cmd1 || '(none)');
  const bin = WIN ? path.join(prefix, 'ccrig.cmd') : path.join(prefix, 'bin', 'ccrig');
  r = WIN ? sh(`"${bin}" --version`, { env }) : spawnSync(bin, ['--version'], { encoding: 'utf8', env });
  ((r.status === 0 && /1\.\d+\.\d+/.test(both(r))) ? PASS : FAIL)('bin shim ccrig --version', both(r));
  r = WIN ? sh(`"${bin}" init`, { env }) : spawnSync(bin, ['init'], { encoding: 'utf8', env });
  (r.status === 0 ? PASS : FAIL)('ccrig init via shim', both(r).slice(0, 1200));
  r = WIN ? sh(`"${bin}" --mode minimal`, { env }) : spawnSync(bin, ['--mode', 'minimal'], { encoding: 'utf8', env });
  INFO('ccrig --mode minimal', both(r));
  s = readJson(sp);
  execCommands('npm-v1', s, env);
  const pkgDir = path.dirname(cmd1.match(/"([^"]*statusline\.js)"/)[1]);
  INFO('config next to installed script before upgrade', fs.existsSync(path.join(pkgDir, 'statusline.config.json')) ? fs.readFileSync(path.join(pkgDir, 'statusline.config.json'), 'utf8') : '(none)');
  // bump copy
  const bump = path.join(base, 'bump'); fs.mkdirSync(bump);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  for (const f of pkg.files.concat(['package.json', 'README.md', 'LICENSE'])) { try { fs.copyFileSync(path.join(REPO, f), path.join(bump, f)); } catch {} }
  const newV = '9.9.9';
  fs.writeFileSync(path.join(bump, 'statusline.js'), fs.readFileSync(path.join(bump, 'statusline.js'), 'utf8').replace(/const VERSION = '[^']+'/, `const VERSION = '${newV}'`));
  pkg.version = newV; fs.writeFileSync(path.join(bump, 'package.json'), JSON.stringify(pkg, null, 2));
  const packDir2 = path.join(base, 'packs2'); fs.mkdirSync(packDir2);
  sh(`npm pack --silent --pack-destination "${packDir2}"`, { cwd: bump, env: { ...env, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE } });
  const tgz2 = fs.readdirSync(packDir2).find((f) => f.endsWith('.tgz'));
  r = sh(`npm install -g --no-fund --no-audit --prefix "${prefix}" "${path.join(packDir2, tgz2)}"`, { env });
  (r.status === 0 ? PASS : FAIL)('npm upgrade to ' + newV, both(r).slice(0, 1200));
  s = readJson(sp);
  const missing = allCommands(s).map((c) => ({ ...c, file: (c.cmd.match(/"([^"]*statusline\.js)"/) || [])[1] })).filter((c) => c.file && !fs.existsSync(c.file));
  (missing.length === 0 ? PASS : FAIL)('after upgrade every command references an existing file', JSON.stringify(missing));
  r = WIN ? sh(`"${bin}" --version`, { env }) : spawnSync(bin, ['--version'], { encoding: 'utf8', env });
  (new RegExp(newV.replace(/\./g, '\\.')).test(both(r)) ? PASS : FAIL)('shim runs upgraded version', both(r));
  const cfgAfter = path.join(home, '.ccrig', 'statusline.config.json');
  (fs.existsSync(cfgAfter) ? PASS : FAIL)('user config (--mode minimal) survives npm upgrade', fs.existsSync(cfgAfter) ? fs.readFileSync(cfgAfter, 'utf8') : 'statusline.config.json is GONE after upgrade: ' + cfgAfter);
  const guardHooks = allCommands(s).filter((c) => /--hook (stop|session-start|pre-compact)/.test(c.cmd));
  (guardHooks.length === 3 ? PASS : FAIL)('guardian hooks still wired after upgrade', JSON.stringify(guardHooks));
  execCommands('npm-v2', s, env);
  r = sh(`npm uninstall -g --no-fund --no-audit --prefix "${prefix}" ccrig`, { env });
  INFO('npm uninstall -g', both(r).slice(0, 600));
  s = readJson(sp);
  const dangling = allCommands(s).filter((c) => { const f = (c.cmd.match(/"([^"]*statusline\.js)"/) || [])[1]; return f && !fs.existsSync(f); });
  INFO('dangling commands after npm uninstall -g (documented: run ccrig --uninstall first)', dangling.length + ' dangling: ' + JSON.stringify(dangling.map((d) => d.ev)));
  if (dangling.length) { const sres = shells[0].run(dangling[0].cmd, { input: renderInput(base), env }); INFO('what a dangling command does (' + shells[0].name + ')', 'exit=' + sres.status + '\n' + both(sres).slice(0, 500)); }
} catch (e) { FAIL('npm section threw', e.stack); }

// ---------------------------------------------------------------------------
// 3. guardian watcher relaunch through a REAL npm-generated `claude` shim (claude.cmd on Windows),
//    with a multi-line prompt containing shell metacharacters; then --status/--disarm on an armed watcher
// ---------------------------------------------------------------------------
try {
  const home = mkHome('guard ü');
  const cfg = path.join(home, '.claude');
  const fakePkg = path.join(base, 'fake claude');
  fs.mkdirSync(fakePkg);
  const argLog = path.join(base, 'claude-argv.json');
  fs.writeFileSync(path.join(fakePkg, 'package.json'), JSON.stringify({ name: 'fake-claude', version: '1.0.0', bin: { claude: 'cli.js' } }));
  fs.writeFileSync(path.join(fakePkg, 'cli.js'), '#!/usr/bin/env node\nrequire("fs").writeFileSync(' + JSON.stringify(argLog) + ', JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd(), cfg: process.env.CLAUDE_CONFIG_DIR, unattended: process.env.CCBSL_UNATTENDED}));\n');
  const cprefix = path.join(base, 'claude prefix');
  let r = sh(`npm install -g --no-fund --no-audit --prefix "${cprefix}" "${fakePkg}"`, { env: envFor(home) });
  const shimDir = WIN ? cprefix : path.join(cprefix, 'bin');
  INFO('fake claude shim install', both(r).slice(0, 300) + '\nshims: ' + fs.readdirSync(shimDir).join(', '));
  if (WIN) { try { INFO('claude.cmd content', fs.readFileSync(path.join(cprefix, 'claude.cmd'), 'utf8')); } catch {} }
  const app = path.join(base, 'guard app ü');
  fs.mkdirSync(app);
  fs.copyFileSync(path.join(REPO, 'statusline.js'), path.join(app, 'statusline.js'));
  fs.writeFileSync(path.join(app, 'statusline.config.json'), JSON.stringify({ autopilot: 'resume', autopilotBuffer: 0 }));
  const js = path.join(app, 'statusline.js');
  const gd = path.join(cfg, 'guardian'); fs.mkdirSync(gd, { recursive: true });
  const tp = path.join(base, 'guard transcript.jsonl');
  fs.writeFileSync(tp, JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix the "quoted" bug & run %PATH% $(whoami) `id`\nsecond line' } }) + '\n');
  const old = new Date(Date.now() - 3600 * 1000); fs.utimesSync(tp, old, old);
  const sid = 'smoke-guard-1';
  const now = Math.floor(Date.now() / 1000);
  const workdir = path.join(base, 'work dir ü'); fs.mkdirSync(workdir);
  fs.writeFileSync(path.join(gd, sid + '.checkpoint.json'), JSON.stringify({ session_id: sid, session_name: 'smoke "name"', cwd: workdir, config_dir: cfg, saved_at: new Date().toISOString(), reason: 'session limit critical', window: 'session', resets_at: now - 30, transcript_path: tp, todos: [], last_request: 'fix the "quoted" bug & run %PATH% $(whoami) `id`\nsecond line', agents: [], git: null }));
  const genv = envFor(home, { CCBSL_NO_ACT: null, CCBSL_WATCH_INTERVAL_MS: '100', PATH: shimDir + path.delimiter + process.env.PATH });
  r = node([js, '--watch', sid], { env: genv, timeout: 60000 });
  INFO('--watch exit=' + r.status, both(r).slice(0, 500));
  let logs = ''; try { logs = fs.readdirSync(path.join(gd, 'logs')).map((f) => f + ':\n' + fs.readFileSync(path.join(gd, 'logs', f), 'utf8')).join('\n'); } catch {}
  INFO('guardian logs', logs.slice(0, 2500));
  let got = null; for (let i = 0; i < 50 && !got; i++) { try { got = JSON.parse(fs.readFileSync(argLog, 'utf8')); } catch { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},200)']); } }
  if (!got) FAIL('relaunch reached fake claude', 'fake claude never ran');
  else {
    const pi = got.argv.indexOf('-p');
    const prompt = pi >= 0 ? got.argv[pi + 1] : '';
    const okArgs = got.argv.includes('--resume') && got.argv.includes(sid) && pi >= 0 && got.argv.length === pi + 2;
    const okPrompt = /\n/.test(prompt) && prompt.includes('"quoted"') && prompt.includes('%PATH%') && prompt.includes('$(whoami)');
    ((okArgs && okPrompt) ? PASS : FAIL)('relaunch argv intact (multi-line prompt, metachars verbatim)', JSON.stringify({ argc: got.argv.length, argvHead: got.argv.slice(0, 4), promptHead: prompt.slice(0, 300) }));
    (fs.realpathSync(got.cwd).toLowerCase() === fs.realpathSync(workdir).toLowerCase() ? PASS : FAIL)('relaunch cwd', got.cwd); // realpath: macOS /var is /private/var
    (got.cfg && path.resolve(got.cfg).toLowerCase() === path.resolve(cfg).toLowerCase() ? PASS : FAIL)('relaunch CLAUDE_CONFIG_DIR', String(got.cfg));
    (got.unattended === '1' ? PASS : FAIL)('relaunch CCBSL_UNATTENDED=1', String(got.unattended));
  }
  // Windows: claudeBin pointed straight at the npm .cmd shim (and at the .ps1) must also relaunch intact
  if (WIN) {
    for (const shimName of ['claude.cmd', 'claude.ps1']) {
      try { fs.unlinkSync(argLog); } catch {}
      const sidW = 'smoke-guard-w' + shimName.replace(/\W/g, '');
      fs.writeFileSync(path.join(app, 'statusline.config.json'), JSON.stringify({ autopilot: 'resume', autopilotBuffer: 0, claudeBin: path.join(cprefix, shimName) }));
      fs.writeFileSync(path.join(gd, sidW + '.checkpoint.json'), JSON.stringify({ session_id: sidW, cwd: workdir, config_dir: cfg, reason: 'session limit critical', window: 'session', resets_at: now - 30, transcript_path: tp, todos: [], last_request: 'line one "q" %PATH%\nline two' }));
      const rr = node([js, '--watch', sidW], { env: genv, timeout: 60000 });
      let g2 = null; for (let i = 0; i < 30 && !g2; i++) { try { g2 = JSON.parse(fs.readFileSync(argLog, 'utf8')); } catch { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},200)']); } }
      const pi2 = g2 ? g2.argv.indexOf('-p') : -1;
      const ok2 = g2 && pi2 >= 0 && g2.argv.length === pi2 + 2 && /\n/.test(g2.argv[pi2 + 1]) && g2.argv[pi2 + 1].includes('%PATH%');
      let lg = ''; try { lg = fs.readFileSync(path.join(gd, 'logs', sidW + '.log'), 'utf8') + fs.readFileSync(path.join(gd, 'logs', sidW + '.resume.log'), 'utf8'); } catch {}
      (ok2 ? PASS : FAIL)('relaunch with claudeBin=' + shimName + ' argv intact', 'exit=' + rr.status + ' ' + (g2 ? JSON.stringify({ argc: g2.argv.length, argvHead: g2.argv.slice(0, 5) }) : 'fake claude never ran') + '\n' + lg.slice(0, 800));
    }
    fs.writeFileSync(path.join(app, 'statusline.config.json'), JSON.stringify({ autopilot: 'resume', autopilotBuffer: 0 }));
  }
  // armed watcher far in the future: --status must list it, --disarm must kill it
  const sid2 = 'smoke-guard-2';
  fs.writeFileSync(path.join(gd, sid2 + '.checkpoint.json'), JSON.stringify({ session_id: sid2, cwd: workdir, config_dir: cfg, reason: 'session limit critical', window: 'session', resets_at: now + 7200, transcript_path: tp, todos: [] }));
  // launch through a short-lived intermediate (double fork) so the watcher is reparented and gets reaped
  // when killed; a direct child of this blocked script would linger as a zombie and fool kill(pid, 0)
  spawnSync(process.execPath, ['-e', 'require("child_process").spawn(process.execPath, ' + JSON.stringify([js, '--watch', sid2]) + ', { detached: true, stdio: "ignore", windowsHide: true }).unref()'], { env: genv });
  for (let i = 0; i < 40 && !fs.existsSync(path.join(gd, sid2 + '.watch.pid')); i++) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},150)']);
  const w = { pid: parseInt(fs.readFileSync(path.join(gd, sid2 + '.watch.pid'), 'utf8'), 10) };
  r = node([js, '--status'], { env: envFor(home) });
  (new RegExp(sid2).test(both(r)) ? PASS : FAIL)('--status lists armed watcher', both(r).slice(0, 800));
  r = node([js, '--disarm'], { env: envFor(home) });
  INFO('--disarm', both(r).slice(0, 500));
  let alive = true; for (let i = 0; i < 30 && alive; i++) { try { process.kill(w.pid, 0); spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},150)']); } catch { alive = false; } }
  (!alive ? PASS : FAIL)('--disarm killed the watcher', 'pid ' + w.pid + ' alive=' + alive);
  if (alive) { try { process.kill(w.pid); } catch {} }
} catch (e) { FAIL('guardian section threw', e.stack); }

// ---------------------------------------------------------------------------
// 4. notification spec actually executes (Windows toast via powershell -EncodedCommand, notify-send, osascript is skipped)
// ---------------------------------------------------------------------------
try {
  const SL = require(path.join(REPO, 'statusline.js'));
  if (WIN) {
    const spec = SL.notifySpec('win32', 'Title "q" $(x) `y`', "msg 'z' %PATH%");
    const r = spawnSync(spec.cmd, spec.args, { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...spec.env } });
    INFO('win32 toast spec exit=' + r.status, both(r).slice(0, 800) || '(no output)');
  }
} catch (e) { FAIL('notify section threw', e.stack); }

// ---------------------------------------------------------------------------
// 5. claude-profiles.ps1 under Windows PowerShell 5.1 and pwsh; claude-profiles.sh under bash (and zsh where present)
// ---------------------------------------------------------------------------
try {
  const home = mkHome('prof ü');
  fs.mkdirSync(path.join(home, '.claude-work'));
  fs.mkdirSync(path.join(home, '.claude-rig-sessions'));
  const env = envFor(home);
  const ps1 = path.join(REPO, 'claude-profiles.ps1').replace(/'/g, "''");
  const psScript = `$ErrorActionPreference='Stop'; . '${ps1}'; claude-profile list; claude-profile new smoke; claude-profile list; claude-profile use work; Write-Host "CFG=$env:CLAUDE_CONFIG_DIR"; claude-profile current; claude-profile use '..\\evil'; claude-profile help | Out-Null; Write-Host 'PS-DONE'`;
  for (const exe of (WIN ? ['powershell', 'pwsh'] : ['pwsh'])) {
    const r = spawnSync(exe, ['-NoProfile', '-Command', psScript], { encoding: 'utf8', timeout: 60000, env });
    if (r.error && r.error.code === 'ENOENT') { INFO(exe + ' not present'); continue; }
    ((r.status === 0 && /PS-DONE/.test(both(r)) && /\.claude-work/.test(both(r))) ? PASS : FAIL)('claude-profiles.ps1 under ' + exe, both(r).slice(0, 1500));
  }
  const shp = path.join(REPO, 'claude-profiles.sh');
  for (const exe of ['bash', 'zsh']) {
    if (WIN && exe === 'zsh') continue;
    const bashExe = WIN ? 'C:\\Program Files\\Git\\bin\\bash.exe' : exe;
    const script = `. "${shp.replace(/\\/g, '/')}" && claude-profile list && claude-profile new smoke && claude-profile use work && echo "CFG=$CLAUDE_CONFIG_DIR" && claude-profile current; claude-profile use ../evil; echo SH-DONE`;
    const r = spawnSync(bashExe, ['-c', script], { encoding: 'utf8', timeout: 60000, env });
    if (r.error && r.error.code === 'ENOENT') { INFO(exe + ' not present'); continue; }
    ((/SH-DONE/.test(both(r)) && /work/.test(both(r))) ? PASS : FAIL)('claude-profiles.sh under ' + exe, both(r).slice(0, 1500));
  }
} catch (e) { FAIL('profiles section threw', e.stack); }

// ---------------------------------------------------------------------------
// 6. render timing (Claude Code re-runs the bar every refresh)
// ---------------------------------------------------------------------------
try {
  const home = mkHome('perf');
  const env = envFor(home);
  const times = [];
  for (let i = 0; i < 5; i++) { const t = process.hrtime.bigint(); node([path.join(REPO, 'statusline.js')], { input: renderInput(REPO), env }); times.push(Number(process.hrtime.bigint() - t) / 1e6); }
  INFO('render wall ms (in repo git dir)', times.map((x) => x.toFixed(0)).join(', '));
} catch (e) { FAIL('perf section threw', e.stack); }

// ---------------------------------------------------------------------------
// 7. autoUpdate against the REAL npm registry + GitHub tag: a copy that claims 0.0.1 must end up on npm latest
// ---------------------------------------------------------------------------
try {
  const latest = (sh('npm view ccrig version', {}).stdout || '').trim();
  INFO('npm latest', latest);
  const old = (js) => js.replace(/const VERSION = '[^']+'/, "const VERSION = '0.0.1'");
  // (a) npm global install in a prefix
  const home = mkHome('auto npm');
  const env = envFor(home, { CCBSL_BG_CHECK: '1' });
  const prefix = path.join(base, 'auto prefix');
  const src = path.join(base, 'auto src'); fs.mkdirSync(src);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  for (const f of pkg.files.concat(['package.json'])) { try { fs.copyFileSync(path.join(REPO, f), path.join(src, f)); } catch {} }
  fs.writeFileSync(path.join(src, 'statusline.js'), old(fs.readFileSync(path.join(src, 'statusline.js'), 'utf8')));
  pkg.version = '0.0.1'; fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify(pkg));
  const pd = path.join(base, 'auto packs'); fs.mkdirSync(pd);
  sh(`npm pack --silent --pack-destination "${pd}"`, { cwd: src, env: { ...env, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE } });
  let r = sh(`npm install -g --no-fund --no-audit --prefix "${prefix}" "${path.join(pd, fs.readdirSync(pd)[0])}"`, { env });
  fs.mkdirSync(path.join(home, '.ccrig'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ccrig', 'statusline.config.json'), JSON.stringify({ autoUpdate: true }));
  const pkgJs = WIN ? path.join(prefix, 'node_modules', 'ccrig', 'statusline.js') : path.join(prefix, 'lib', 'node_modules', 'ccrig', 'statusline.js');
  r = node([pkgJs, '--check-update'], { env, timeout: 300000 });
  const after = (fs.readFileSync(pkgJs, 'utf8').match(/const VERSION = '([^']+)'/) || [])[1];
  let cache = ''; try { cache = fs.readFileSync(path.join(home, '.claude', '.ccbsl-update.json'), 'utf8'); } catch {}
  (after === latest ? PASS : FAIL)('autoUpdate (npm prefix) 0.0.1 -> ' + latest, 'now ' + after + '\n' + both(r).slice(0, 400) + '\ncache: ' + cache.slice(0, 600));
  // (b) standalone copy
  const home2 = mkHome('auto standalone');
  const dir = path.join(base, 'auto standalone app'); fs.mkdirSync(dir);
  const js = path.join(dir, 'statusline.js');
  fs.writeFileSync(js, old(fs.readFileSync(path.join(REPO, 'statusline.js'), 'utf8')));
  fs.writeFileSync(path.join(dir, 'statusline.config.json'), JSON.stringify({ autoUpdate: true }));
  r = node([js, '--check-update'], { env: envFor(home2, { CCBSL_BG_CHECK: '1' }), timeout: 120000 });
  const after2 = (fs.readFileSync(js, 'utf8').match(/const VERSION = '([^']+)'/) || [])[1];
  (after2 === latest ? PASS : FAIL)('autoUpdate (standalone) 0.0.1 -> ' + latest, 'now ' + after2 + '\n' + both(r).slice(0, 400) + '\nbackups: ' + fs.readdirSync(dir).join(', '));
} catch (e) { FAIL('autoUpdate section threw', e.stack); }

const fails = out.filter((o) => o.kind === 'FAIL');
console.log('\n==== SUMMARY ' + process.platform + ' ' + process.version + ': ' + out.filter((o) => o.kind === 'PASS').length + ' pass, ' + fails.length + ' fail ====');
for (const f of fails) console.log('  FAIL ' + f.name);
try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
process.exit(fails.length ? 1 : 0);
