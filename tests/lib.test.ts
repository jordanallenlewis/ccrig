// Unit tests for the mod's pure helpers. Run with `claude plugin test` (no session, no network).
import { expect, test } from 'claude-code/testing'
import {
  alertFor, alertKey, ansiToSpans, classicResult, cliArgs, configFrom, crossings, detectWiring,
  displayModel, fmtDayMonth, fmtReset, localeDateParts, nativeSegments, nodeFromSettings, packLines, parseRigOutput, plainText,
  resumeCommand, splitArgs, statusInput, summaryLine, thresholdsFrom, useClock, useDateParts, withFable, xterm256, DEFAULT_THRESHOLDS,
} from '../hooks/lib'

const NOW = Date.UTC(2026, 9, 1, 15, 0, 0)
const IN_2H = new Date(NOW + 2 * 3600 * 1000).toISOString()
const IN_3D = new Date(NOW + 3 * 86400 * 1000).toISOString()
const AGO = new Date(NOW - 60 * 1000).toISOString()

test('xterm256 maps the cube, the grays and the base colors', () => {
  expect(xterm256(196)).toBe('#ff0000')
  expect(xterm256(245)).toBe('#8a8a8a')
  expect(xterm256(78)).toBe('#5fd787')
  expect(xterm256(9)).toBe('#ff0000')
  expect(xterm256(999)).toBe('#c0c0c0')
})

test('ansiToSpans keeps colors and bold, merges runs, drops other escapes', () => {
  const s = '\x1b[38;5;245m★\x1b[0m \x1b[1m\x1b[38;5;203m⚠ weekly\x1b[0m\x1b[2K'
  expect(ansiToSpans(s)).toEqual([
    { text: '★', color: '#8a8a8a' },
    { text: ' ' },
    { text: '⚠ weekly', color: '#ff5f5f', bold: true },
  ])
  expect(plainText('\x1b[38;5;78mmain\x1b[0m \x1b[38;5;214m●3\x1b[0m')).toBe('main ●3')
  expect(ansiToSpans('a\x07b')).toEqual([{ text: 'ab' }])
})

test('packLines wraps whole segments and never starts a line with a separator', () => {
  const seg = (t: string) => ({ spans: [{ text: t }], width: t.length })
  const lines = packLines([seg('aaaa'), seg('bbbb'), seg('cccc')], 12)
  expect(lines.map((l) => l.map((s) => s.text).join(''))).toEqual(['aaaa │ bbbb', 'cccc'])
})

test('parseRigOutput reads the segments statusline.js prints, and refuses anything else', () => {
  const old = parseRigOutput(JSON.stringify({ v: '1.7.0', segments: ['\x1b[38;5;75mccrig\x1b[0m'], widths: [5] }))
  expect(old).toEqual({ segs: [{ spans: [{ text: 'ccrig', color: '#5fafff' }], width: 5 }], state: null, lines: null, width: null })
  const state = { thresholds: { green: 50, yellow: 80, warn: 85, critical: 93 }, mode: 'normal', autopilot: 'resume', keepWorking: true, sessionBoard: false, forecast: { window: 'session', etaSec: 2700, safe: false, text: '⏳ ~45m to session limit' }, resume: { armed: false, window: '', resetsAt: null }, update: { latest: null, hint: '' } }
  const withState = parseRigOutput(JSON.stringify({ v: '1.8.0', segments: [], widths: [], state }))
  expect(withState!.state).toEqual(state)
  expect(parseRigOutput(JSON.stringify({ segments: [], state: { thresholds: { warn: 'x' } } }))!.state).toBe(null)
  expect(parseRigOutput('statusline error: run node statusline.js --doctor')).toBe(null)
  expect(parseRigOutput(JSON.stringify({ segments: [1] }))).toBe(null)
})

test('displayModel turns ids into names', () => {
  expect(displayModel('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(displayModel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
  expect(displayModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(displayModel('Opus 5.5 (1M context)')).toBe('Opus 5.5')
  expect(displayModel('')).toBe('')
})

test('fmtReset reads like the status line', () => {
  expect(fmtReset(AGO, NOW)).toBe('now')
  expect(fmtReset(undefined, NOW)).toBe('')
  expect(fmtReset(IN_2H, NOW)).toMatch(/^\d{1,2}:\d\d[ap]$|^\d{1,2}\/\d{1,2} \d{1,2}:\d\d[ap]$/)
  // inside the coming week a reset reads as its weekday, later as a date, like the refined status line
  expect(fmtReset(IN_3D, NOW)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}:\d\d[ap]$/)
  expect(fmtReset(new Date(NOW + 6.5 * 86400 * 1000).toISOString(), NOW, localeDateParts('en-US'))).toMatch(/^\d{1,2}\/\d{1,2} \d{1,2}:\d\d[ap]$/)
})

test('fmtReset dates a reset a week out in the locale\'s day/month order, like the status line', () => {
  const later = new Date(NOW + 6.5 * 86400 * 1000)
  const iso = later.toISOString()
  const m = later.getMonth() + 1
  const d = later.getDate()
  expect(fmtReset(iso, NOW, localeDateParts('en-US')).startsWith(m + '/' + d + ' ')).toBe(true)
  expect(fmtReset(iso, NOW, localeDateParts('en-GB')).startsWith(d + '/' + m + ' ')).toBe(true)
  expect(fmtReset(iso, NOW, localeDateParts('de-DE')).startsWith(d + '.' + m + '. ')).toBe(true)
  const nov30 = new Date(2026, 10, 30, 20, 4)
  expect(fmtDayMonth(nov30, localeDateParts('en-US'))).toBe('11/30')
  expect(fmtDayMonth(nov30, localeDateParts('en-GB'))).toBe('30/11')
  expect(fmtDayMonth(nov30, localeDateParts('de-DE'))).toBe('30.11.')
  expect(fmtDayMonth(nov30, localeDateParts('ja-JP'))).toBe('11/30')
})

test('fmtDayMonth falls back to month/day for anything that is not a sound layout', () => {
  const dec5 = new Date(2026, 11, 5, 9, 0)
  for (const bad of [undefined, null, {}, { first: 'y', sep: '/', end: '' }, { first: 'd', sep: '', end: '' },
    { first: 'd', sep: '1', end: '' }, { first: 'd', sep: '/', end: '\x1b[2J' }, { first: 'd', sep: 'abcd', end: '' }]) {
    expect(fmtDayMonth(dec5, bad)).toBe('12/5')
  }
  expect(fmtDayMonth(dec5, { first: 'd', sep: '.', end: '.' })).toBe('5.12.')
})

test('the date layout statusline.js read from the locale reaches the pane', () => {
  const thresholds = { green: 50, yellow: 80, warn: 85, critical: 93 }
  const base = { thresholds, autopilot: 'notify', keepWorking: false, sessionBoard: false }
  const gb = parseRigOutput(JSON.stringify({ segments: [], state: { ...base, date: { first: 'd', sep: '/', end: '' } } }))!.state!
  expect(gb.date).toEqual({ first: 'd', sep: '/', end: '' })
  // an older statusline.js sends none, and an unsound one is dropped, never drawn
  expect('date' in parseRigOutput(JSON.stringify({ segments: [], state: base }))!.state!).toBe(false)
  expect('date' in parseRigOutput(JSON.stringify({ segments: [], state: { ...base, date: { first: 'd', sep: '\x1b[2J', end: '' } } }))!.state!).toBe(false)
  const later = new Date(NOW + 6.5 * 86400 * 1000)
  const dm = later.getDate() + '/' + (later.getMonth() + 1) + ' '
  try {
    useDateParts(gb.date)
    expect(fmtReset(later.toISOString(), NOW).startsWith(dm)).toBe(true)
    useDateParts({ first: 'x' })
    expect(fmtReset(later.toISOString(), NOW).startsWith(dm)).toBe(true)
  } finally {
    useDateParts(localeDateParts('en-US'))
  }
})

test('the bar\'s clock and weekday names reach the pane (#58)', () => {
  const thresholds = { green: 50, yellow: 80, warn: 85, critical: 93 }
  const base = { thresholds, autopilot: 'notify', keepWorking: false, sessionBoard: false }
  const DE = ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.']
  const EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const st = (clock: unknown) => parseRigOutput(JSON.stringify({ segments: [], state: { ...base, clock } }))!.state!
  expect(st({ style: 'clock24', days: DE }).clock).toEqual({ style: 'clock24', days: DE })
  // an older statusline.js sends none, and an unsound one is dropped, never drawn
  expect('clock' in parseRigOutput(JSON.stringify({ segments: [], state: base }))!.state!).toBe(false)
  for (const bad of [null, 'clock24', { style: 'auto', days: EN }, { style: 'clock24' }, { style: 'clock24', days: EN.slice(1) },
    { style: 'clock24', days: [...EN.slice(1), ''] }, { style: 'clock24', days: [...EN.slice(1), '\x1b[2J'] },
    { style: 'clock24', days: [...EN.slice(1), 'Saturday-long-name'] }, { style: 'clock24', days: [...EN.slice(1), 6] },
    { style: 'clock24', days: [...EN.slice(1), 'Sa\u202e'] }, { style: 'clock24', days: [...EN.slice(1), '\ufeffSa'] },
    { style: 'clock24', days: [...EN.slice(1), 'S\u2028a'] }]) {
    expect('clock' in st(bad)).toBe(false)
  }
  // Persian writes a zero-width non-joiner inside Tuesday: kept
  const FA = ['یکشنبه', 'دوشنبه', 'سه\u200cشنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه']
  expect(st({ style: 'clock24', days: FA }).clock).toEqual({ style: 'clock24', days: FA })
  const at = new Date(2026, 9, 6, 20, 5) // a Tuesday, 20:05 local
  const now = at.getTime() - 3 * 86400000
  const later = new Date(at.getTime() + 4 * 86400000) // 7 days out: dated
  const iso = at.toISOString()
  // no clock: today's output (an older statusline.js)
  expect(fmtReset(iso, now)).toBe('Tue 8:05p')
  expect(fmtReset(iso, now, undefined, { style: 'clock24', days: DE })).toBe('Di. 20:05')
  expect(fmtReset(iso, now, undefined, { style: 'clock24', days: EN })).toBe('Tue 20:05')
  expect(fmtReset(iso, now, undefined, { style: 'clock', days: DE })).toBe('Di. 8:05p')
  expect(fmtReset(later.toISOString(), now, { first: 'd', sep: '/', end: '' }, { style: 'clock24', days: EN }))
    .toBe(later.getDate() + '/' + (later.getMonth() + 1) + ' 20:05')
  expect(fmtReset(new Date(now + 2 * 3600000 + 14 * 60000).toISOString(), now, undefined, { style: 'relative', days: EN })).toBe('2h14m')
  expect(fmtReset(iso, now, undefined, { style: 'relative', days: EN })).toBe('3d')
  expect(fmtReset(new Date(now + 40 * 60000).toISOString(), now, undefined, { style: 'relative', days: EN })).toBe('40m')
  expect(fmtReset(new Date(now - 1000).toISOString(), now, undefined, { style: 'relative', days: EN })).toBe('now')
  // the state's clock is kept for every later reset; an unsound one leaves the last good one
  try {
    useClock({ style: 'clock24', days: DE })
    expect(fmtReset(iso, now)).toBe('Di. 20:05')
    useClock({ style: 'nope' })
    expect(fmtReset(iso, now)).toBe('Di. 20:05')
    useClock(undefined)
    expect(fmtReset(iso, now)).toBe('Di. 20:05')
  } finally {
    useClock({ style: 'clock', days: EN })
  }
  expect(fmtReset(iso, now)).toBe('Tue 8:05p')
})

test('thresholdsFrom reads thresholds.usage and ignores junk', () => {
  expect(thresholdsFrom(null)).toEqual(DEFAULT_THRESHOLDS)
  expect(thresholdsFrom('{oops')).toEqual(DEFAULT_THRESHOLDS)
  const t = thresholdsFrom('\uFEFF{"thresholds":{"usage":{"warn":80,"critical":"x","yellow":500}}}')
  expect(t).toEqual({ green: 50, yellow: 80, warn: 80, critical: 95 })
})

test('alertFor picks the fullest live window past warn, and ignores a passed reset', () => {
  const usage = {
    rateLimits: [
      { kind: 'five_hour', percentUsed: 91, resetsAt: IN_2H },
      { kind: 'seven_day', percentUsed: 96, resetsAt: IN_3D },
      { kind: 'spend_limit', percentUsed: 99, resetsAt: AGO },
    ],
  }
  const a = alertFor(usage, DEFAULT_THRESHOLDS, NOW)
  expect(a).toMatchObject({ kind: 'seven_day', label: 'weekly', level: 'critical' })
  expect(alertFor({ rateLimits: [{ kind: 'five_hour', percentUsed: 40 }] }, DEFAULT_THRESHOLDS, NOW)).toBe(null)
  expect(alertKey(a!)).toBe('seven_day:critical:' + IN_3D)
})

test('crossings reports each threshold once, the highest one crossed', () => {
  const usage = (p: number) => ({ rateLimits: [{ kind: 'five_hour', percentUsed: p, resetsAt: IN_2H }] })
  expect(crossings({ five_hour: 88 }, usage(91), DEFAULT_THRESHOLDS, NOW).map((a) => a.level)).toEqual(['warn'])
  expect(crossings({ five_hour: 88 }, usage(97), DEFAULT_THRESHOLDS, NOW).map((a) => a.level)).toEqual(['critical'])
  expect(crossings({ five_hour: 92 }, usage(93), DEFAULT_THRESHOLDS, NOW)).toEqual([])
})

test('configFrom reads the guardian settings with the statusline.js defaults', () => {
  expect(configFrom(null)).toEqual({ thresholds: DEFAULT_THRESHOLDS, autopilot: 'notify', keepWorking: false, sessionBoard: false })
  expect(configFrom('{"autopilot":"resume","keepWorking":{"maxContinues":5},"sessionBoard":true,"mode":"minimal"}'))
    .toEqual({ thresholds: DEFAULT_THRESHOLDS, autopilot: 'resume', keepWorking: true, sessionBoard: true, mode: 'minimal' })
  expect(configFrom('{"autopilot":"sometimes"}').autopilot).toBe('notify')
})

// what `ccrig init` wires, by version and flags (statusline.js GUARD_EVENTS + BOARD_EVENTS)
const hook = (slug: string) => ({ hooks: [{ type: 'command', command: '"C:/n/node.exe" "C:/x/statusline.js" --hook ' + slug }] })
const BAR = { type: 'command', command: '"C:/n/node.exe" "C:/x/statusline.js"' }
const FULL_170 = { statusLine: BAR, hooks: {
  Stop: [hook('stop'), hook('board-stop')], SessionStart: [hook('session-start')], PreCompact: [hook('pre-compact')],
  UserPromptSubmit: [hook('user-prompt')], Notification: [hook('notification')], SessionEnd: [hook('session-end')],
} }
const LAMPS_ONLY_170 = { statusLine: BAR, hooks: {
  Stop: [hook('board-stop')], UserPromptSubmit: [hook('user-prompt')], Notification: [hook('notification')], SessionEnd: [hook('session-end')],
} }

test('detectWiring names each CCRig hook by its slug', () => {
  expect(detectWiring(FULL_170)).toEqual({
    statusLine: true,
    hooks: ['board-stop', 'notification', 'pre-compact', 'session-end', 'session-start', 'stop', 'user-prompt'],
  })
  expect(detectWiring(LAMPS_ONLY_170)).toEqual({ statusLine: true, hooks: ['board-stop', 'notification', 'session-end', 'user-prompt'] })
  expect(detectWiring({ statusLine: BAR })).toEqual({ statusLine: true, hooks: [] })
  expect(detectWiring({ statusLine: { command: 'my-bar.sh' }, hooks: { Stop: [{ hooks: [{ command: 'echo --hook stop' }] }] } }))
    .toEqual({ statusLine: false, hooks: [] })
  expect(detectWiring(null)).toEqual({ statusLine: false, hooks: [] })
})

test('detectWiring and nodeFromSettings read exec-form hooks (Windows, no Git Bash)', () => {
  const exec = (slug: string) => ({ hooks: [{ type: 'command', command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\npm\\node_modules\\ccrig\\statusline.js', '--hook', slug] }] })
  const settings = { statusLine: { command: 'node C:/npm/node_modules/ccrig/statusline.js' }, hooks: { Stop: [exec('stop'), exec('board-stop')], UserPromptSubmit: [exec('user-prompt')] } }
  expect(detectWiring(settings)).toEqual({ statusLine: true, hooks: ['board-stop', 'stop', 'user-prompt'] })
  expect(nodeFromSettings({ hooks: { Stop: [exec('stop')] } })).toBe('C:\\Program Files\\nodejs\\node.exe')
})

test('nodeFromSettings finds the node a wired CCRig command runs', () => {
  expect(nodeFromSettings({ statusLine: { command: '"C:\\Program Files\\nodejs\\node.exe" "C:\\x\\statusline.js"' } })).toBe('C:\\Program Files\\nodejs\\node.exe')
  expect(nodeFromSettings({ statusLine: { command: 'C:/nodejs/node.exe C:/x/statusline.js' } })).toBe('C:/nodejs/node.exe')
  expect(nodeFromSettings({ statusLine: { command: 'node /x/statusline.js' } })).toBe('node')
  expect(nodeFromSettings({ hooks: { Stop: [hook('stop')] } })).toBe('C:/n/node.exe')
  expect(nodeFromSettings({ statusLine: { command: '/usr/bin/node /x/my-bar.js' } })).toBe(null)
  expect(nodeFromSettings({ statusLine: { command: 'bash /x/statusline.js' } })).toBe(null)
})

test('cliArgs passes only the arguments each command takes, and never a flag', () => {
  expect(cliArgs('status', [])).toEqual({ argv: ['status'] })
  expect(cliArgs('check-update', [])).toEqual({ argv: ['check-update'] })
  expect(cliArgs('mode', ['minimal'])).toEqual({ argv: ['mode', 'minimal'] })
  expect(cliArgs('autopilot', ['resume'])).toEqual({ argv: ['autopilot', 'resume'] })
  expect(cliArgs('keep-working', ['off'])).toEqual({ argv: ['keep-working', 'off'] })
  expect(cliArgs('name', ['auth', 'refactor'])).toEqual({ argv: ['name', 'auth', 'refactor'] })
  for (const [sub, rest] of [
    ['mode', ['--watch', 'x']], ['mode', []], ['mode', ['minimal', 'extra']], ['status', ['--purge']],
    ['autopilot', ['on']], ['name', ['-x']], ['name', ['--hook', 'stop']], ['name', []],
    ['name', ['a-label-much-longer-than-eighteen']], ['install', []], ['purge', []],
  ] as const) {
    expect('error' in cliArgs(sub, rest)).toBe(true)
  }
})

test('REGRESSION: cliArgs treats built-in object names as unknown commands', () => {
  // CHOICES and USAGE were plain objects, so `constructor` found Object and `toString` found a function
  for (const [sub, rest] of [
    ['constructor', []], ['constructor', ['x']], ['toString', []], ['toString', ['x']],
    ['hasOwnProperty', ['x']], ['valueOf', []], ['__proto__', []], ['__proto__', ['x']],
  ] as const) {
    expect(cliArgs(sub, rest)).toEqual({ error: 'No /ccrig ' + sub + '.' })
  }
})

test('statusInput builds the JSON statusline.js reads', () => {
  const input = statusInput({
    sessionId: 'abc-1', transcriptPath: '/t.jsonl', cwd: '/w/app', projectDir: '/w', model: 'claude-opus-5-5[1m]',
    version: '2.1.287', effort: 'high', sessionName: '',
    usage: {
      context: { tokens: 420000, window: 1000000, percent: 42 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 63, resetsAt: '2026-10-01T17:00:00.000Z' }, { kind: 'spend_limit', percentUsed: 10 }],
      cost: { usd: 1.5 },
    },
  })
  expect(input).toEqual({
    session_id: 'abc-1',
    cwd: '/w/app',
    workspace: { current_dir: '/w/app', project_dir: '/w' },
    model: { id: 'claude-opus-5-5[1m]', display_name: 'Opus 5.5' },
    version: '2.1.287',
    rate_limits: { five_hour: { used_percentage: 63, resets_at: Math.floor(Date.parse('2026-10-01T17:00:00.000Z') / 1000) }, spend_limit: { used_percentage: 10 } },
    transcript_path: '/t.jsonl',
    effort: { level: 'high' },
    context_window: { context_window_size: 1000000, used_percentage: 42, total_input_tokens: 420000 },
    cost: { total_cost_usd: 1.5 },
  })
})

test('classicResult translates a settings hook answer and keeps earlier decisions', () => {
  expect(classicResult('')).toEqual({})
  expect(classicResult('{"decision":"block","reason":"2 todos open"}')).toEqual({ block: '2 todos open' })
  expect(classicResult('{"decision":"block","reason":"mine"}', { block: 'theirs' })).toEqual({ block: 'theirs' })
  expect(classicResult('{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"resume here"}}', { additionalContext: ['a'] }))
    .toEqual({ additionalContext: ['a', 'resume here'] })
  expect(classicResult('garbage', { block: 'x' })).toEqual({ block: 'x' })
})

test('the native line and the summary use Claude Code figures', () => {
  const usage = {
    context: { tokens: 1000, window: 1000000, percent: 42 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 63, resetsAt: IN_2H }],
    cost: { usd: 0.5 },
  }
  const text = nativeSegments('claude-opus-5-5', usage, DEFAULT_THRESHOLDS, NOW)
    .map((s) => s.spans.map((x) => x.text).join(''))
  expect(text[0]).toBe('Opus 5.5 1M')
  expect(text[1]).toBe('ctx ━━━━────── 42%')
  expect(text[2]).toMatch(/^session ━━━━━━╸─── 63% ↺ /)
  expect(text[3]).toBe('$0.50')
  expect(summaryLine('claude-opus-5-5', usage, NOW)).toMatch(/^Opus 5\.5 · ctx 42% · session 63% \(resets .+\) · \$0\.50$/)
  expect(summaryLine('', null, NOW)).toContain('no plan usage yet')
  expect(summaryLine('', null, NOW)).toContain('Pro, Max or Ultra plan, or behind a Claude apps gateway with a spend limit')
})

test('small helpers', () => {
  expect(resumeCommand('abc-123')).toBe('claude --resume abc-123')
  expect(resumeCommand('a b; rm -rf /')).toBe('claude --continue')
  expect(splitArgs('  mode   minimal ')).toEqual(['mode', 'minimal'])
  expect(splitArgs('')).toEqual([])
})

test('parseRigOutput keeps the lines statusline.js laid out, and their width', () => {
  const out = parseRigOutput(JSON.stringify({ v: '1.9.1', segments: ['a'], widths: [1], lines: ['\x1b[38;5;245mctx\x1b[0m 42%', 'b'], width: 99 }))!
  expect(out.width).toBe(99)
  expect(out.lines!.map((l) => l.map((x) => x.text).join(''))).toEqual(['ctx 42%', 'b'])
  // an older statusline.js sends no lines; junk lines are ignored rather than drawn
  expect(parseRigOutput(JSON.stringify({ segments: ['a'], widths: [1] }))!.lines).toBe(null)
  expect(parseRigOutput(JSON.stringify({ segments: ['a'], widths: [1], lines: [1, 2], width: 99 }))!.lines).toBe(null)
  expect(parseRigOutput(JSON.stringify({ segments: ['a'], widths: [1], lines: ['x'] }))!.lines).toBe(null)
})


test('the Fable window from the render state joins the usage windows', () => {
  const state = { thresholds: { green: 50, yellow: 80, warn: 90, critical: 95 }, autopilot: 'notify', keepWorking: false, sessionBoard: false, fable: { pct: 92, resetsAt: IN_3D } }
  const parsed = parseRigOutput(JSON.stringify({ v: '1.10.0', segments: [], widths: [], state }))!.state!
  expect(parsed.fable).toEqual({ pct: 92, resetsAt: IN_3D })
  // junk is dropped, an out-of-range number clamped
  expect(parseRigOutput(JSON.stringify({ segments: [], state: { ...state, fable: { pct: 'x' } } }))!.state!.fable).toBe(null)
  expect(parseRigOutput(JSON.stringify({ segments: [], state: { ...state, fable: { pct: 140 } } }))!.state!.fable).toEqual({ pct: 100 })

  const usage = { rateLimits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: IN_2H }] }
  const u = withFable(usage, parsed)!
  expect(u.rateLimits!.map((r) => r.kind)).toEqual(['five_hour', 'fable'])
  expect(withFable(usage, { ...parsed, fable: null })).toBe(usage)
  expect(withFable(null, parsed)!.rateLimits).toEqual([{ kind: 'fable', percentUsed: 92, resetsAt: IN_3D }])
  // past the warn line it is the alert, and the summary names it
  expect(alertFor(u, DEFAULT_THRESHOLDS, NOW)!.kind).toBe('fable')
  expect(summaryLine('claude-fable-5-2', u, NOW)).toContain('fable 92%')
  expect(crossings({ fable: 80 }, u, DEFAULT_THRESHOLDS, NOW).map((a) => a.kind)).toEqual(['fable'])
})

test('/ccrig update checks for a newer CCRig', () => {
  expect(cliArgs('update', [])).toEqual({ argv: ['check-update'] })
  expect('error' in cliArgs('update', ['now'])).toBe(true)
})
