// Unit tests for the mod's pure helpers. Run with `claude plugin test` (no session, no network).
import { expect, test } from 'claude-code/testing'
import {
  alertFor, alertKey, ansiToSpans, classicResult, cliArgs, configFrom, crossings, detectWiring,
  displayModel, fmtReset, nativeSegments, nodeFromSettings, packLines, parseRigOutput, plainText,
  resumeCommand, splitArgs, statusInput, summaryLine, thresholdsFrom, xterm256, DEFAULT_THRESHOLDS,
} from '../hooks/lib.ts'

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
  expect(old).toEqual({ segs: [{ spans: [{ text: 'ccrig', color: '#5fafff' }], width: 5 }], state: null })
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
  expect(fmtReset(IN_3D, NOW)).toMatch(/^\d{1,2}\/\d{1,2} \d{1,2}:\d\d[ap]$/)
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
    ['name', ['a-label-much-longer-than-eighteen']], ['install', []], ['update', []], ['purge', []],
  ] as const) {
    expect('error' in cliArgs(sub, rest)).toBe(true)
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
    rate_limits: { five_hour: { used_percentage: 63, resets_at: Math.floor(Date.parse('2026-10-01T17:00:00.000Z') / 1000) } },
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
  expect(text[0]).toBe('★ Opus 5.5 [1m]')
  expect(text[1]).toBe('ctx ████░░░░░░ 42%')
  expect(text[2]).toMatch(/^session █████░░░ 63% ↺/)
  expect(text[3]).toBe('$0.50')
  expect(summaryLine('claude-opus-5-5', usage, NOW)).toMatch(/^Opus 5\.5 · ctx 42% · session 63% \(resets .+\) · \$0\.50$/)
  expect(summaryLine('', null, NOW)).toContain('no plan usage yet')
})

test('small helpers', () => {
  expect(resumeCommand('abc-123')).toBe('claude --resume abc-123')
  expect(resumeCommand('a b; rm -rf /')).toBe('claude --continue')
  expect(splitArgs('  mode   minimal ')).toEqual(['mode', 'minimal'])
  expect(splitArgs('')).toEqual([])
})
