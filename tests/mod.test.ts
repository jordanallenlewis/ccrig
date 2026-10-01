// Event-level tests for the CCRig mod: raise what Claude Code would raise, stub what it would answer,
// and check what the mod drew, said or ran. Run with `claude plugin test`.
import { expect, mock, test } from 'claude-code/testing'

const HOUR = 3600 * 1000

const WIRED = {
  statusLine: { type: 'command', command: 'node C:/npm/node_modules/ccrig/statusline.js' },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node C:/npm/node_modules/ccrig/statusline.js --hook stop' }] }] },
}
const lampHook = (slug: string) => ({ hooks: [{ type: 'command', command: 'node C:/npm/node_modules/ccrig/statusline.js --hook ' + slug }] })
const LAMPS_ONLY = {
  statusLine: WIRED.statusLine,
  hooks: { Stop: [lampHook('board-stop')], UserPromptSubmit: [lampHook('user-prompt')], Notification: [lampHook('notification')], SessionEnd: [lampHook('session-end')] },
}

const RIG = JSON.stringify({
  v: '1.8.0',
  segments: ['📂 \x1b[38;5;75mmy-app\x1b[0m', '\x1b[38;5;245msession\x1b[0m \x1b[38;5;214m█████\x1b[0m 63%'],
  widths: [9, 16],
})

type Opts = {
  settings?: unknown
  config?: string
  rig?: string | null
  hookOut?: string | ((argv: string[]) => string)
  cli?: string
  noBareNode?: boolean
  noNode?: boolean
  sessionId?: () => string
}
type Run = { argv: string[]; init: { stdin?: string; env?: Record<string, string>; timeoutMs?: number; cwd?: string } }

// Stub every mods API call the mod makes, and record what it did
function setup(on, o: Opts = {}) {
  const seen = {
    runs: [] as Run[],
    toasts: [] as string[],
    copies: [] as unknown[],
    opened: [] as string[],
    submits: [] as string[],
    order: [] as string[],
    registered: [] as { name: string; immediate?: boolean }[],
    rendered: null as null | { props: Record<string, unknown> },
  }
  const clock = mock.clock(on, { now: Date.now() })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }))
  on('session.id', () => ({ value: o.sessionId ? o.sessionId() : 'sess-1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('session.version', () => ({ value: { version: '2.1.287', base: '2.1.287', builtAt: '' } }))
  on('session.usage', () => ({ value: { context: { window: 1000000, percent: 12, tokens: 120000 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: o.settings ?? {} }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.exists', ($, e) => ({ value: o.config != null && String(e.path).split('\\').join('/').endsWith('/.ccrig/statusline.config.json') }))
  on('fs.read', () => ({ value: o.config ?? '' }))
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    seen.runs.push({ argv, init: e.init ?? {} })
    seen.order.push('run:' + argv.slice(2).join(' '))
    if (o.noNode || (o.noBareNode && argv[0] === 'node')) return { deny: 'spawn ' + argv[0] + ' ENOENT' }
    if (argv.includes('--hook')) {
      const out = typeof o.hookOut === 'function' ? o.hookOut(argv) : o.hookOut ?? ''
      return { value: { exitCode: 0, stdout: out, stderr: '' } }
    }
    if (argv.length === 2) {
      if (o.rig === null) return { deny: 'node is not on PATH' }
      return { value: { exitCode: 0, stdout: o.rig ?? RIG, stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: o.cli ?? 'ok\n', stderr: '' } }
  })
  on('command.register', ($, e) => {
    seen.registered.push(e)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.copy', ($, e) => {
    seen.copies.push(e.text ?? e)
    return { value: { isCopied: true } }
  })
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    seen.submits.push(e.text)
    return { text: e.text }
  })
  on('ui.render', ($, e) => {
    seen.rendered = e
    return { type: 'Text', props: {}, children: ['drawn by Claude Code'] }
  })
  return { seen, clock }
}

const settle = () => new Promise((r) => setTimeout(r, 25))
const renders = (seen) => seen.runs.filter((r) => r.argv.length === 2).length
const hookRuns = (seen) => seen.runs.filter((r) => r.argv.includes('--hook')).map((r) => r.argv[r.argv.length - 1])

async function start($, surface: string | null = 'terminal', isInteractive = true) {
  await $.session.start({ surface, isInteractive, cwd: '/work' })
  await settle()
}

function measure($, pct: number, kind = 'five_hour', resetsAt = new Date(Date.now() + 2 * HOUR).toISOString()) {
  return $.session.measure({
    context: { window: 1000000, percent: 42, tokens: 420000 },
    rateLimits: [{ kind, percentUsed: pct, resetsAt }],
    cost: { usd: 1.25 },
    changed: ['rateLimits'],
  })
}

const stopEvent = (sid = 's') => ({ hook_event_name: 'Stop', session_id: sid, transcript_path: '/t', cwd: '/w', stop_hook_active: false })

const BAND = {
  plugin: 'ccrig',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 100, rows: 30 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

// ---- commands -----------------------------------------------------------------------------------

test('registers /ccrig at session start, runnable mid-turn', async ($, on) => {
  const { seen } = setup(on)
  await start($)
  expect(seen.registered.length).toBe(1)
  expect(seen.registered[0]).toMatchObject({ name: 'ccrig', immediate: true })
  const help = await $.command.run({ command: 'ccrig', args: 'help' })
  expect(help.text).toContain('/ccrig usage')
})

test('/ccrig mode passes through to the CLI and shares the npm config path', async ($, on) => {
  const { seen } = setup(on, { cli: '\x1b[1mmode: minimal\x1b[0m (applies on the next render)\n' })
  await start($)
  const answer = await $.command.run({ command: 'ccrig', args: 'mode minimal' })
  expect(answer.text).toBe('mode: minimal (applies on the next render)')
  const cli = seen.runs.find((r) => r.argv.includes('mode'))
  expect(cli!.argv.slice(-2)).toEqual(['mode', 'minimal'])
  expect(cli!.init.env).toMatchObject({ CCRIG_HOST: 'mod' })
})

test('/ccrig never passes a flag through to the CLI', async ($, on) => {
  const { seen } = setup(on)
  await start($)
  const before = seen.runs.length
  for (const args of ['mode --watch abc', 'status --purge', 'name --hook stop', 'autopilot on', 'mode']) {
    const answer = await $.command.run({ command: 'ccrig', args })
    expect(answer.text).toMatch(/^usage: \/ccrig /)
  }
  const answer = await $.command.run({ command: 'ccrig', args: 'uninstall' })
  expect(answer.text).toMatch(/^No \/ccrig uninstall\./)
  expect(seen.runs.length).toBe(before)
})

test('/ccrig name runs at the project root', async ($, on) => {
  const { seen } = setup(on)
  await start($)
  await $.command.run({ command: 'ccrig', args: 'name auth work' })
  const run = seen.runs.find((r) => r.argv.includes('name'))
  expect(run!.argv.slice(-3)).toEqual(['name', 'auth', 'work'])
  expect(run!.init.cwd).toBe('/work')
})

test('/ccrig alone sums up the session', async ($, on) => {
  setup(on, { settings: WIRED })
  await start($)
  await measure($, 63)
  const answer = await $.command.run({ command: 'ccrig', args: '' })
  expect(answer.text).toMatch(/^Opus 5\.5 · ctx 42% · session 63% \(resets .+\) · \$1\.25$/)
})

test('/ccrig usage opens a pane with the bars, the pace line and a copy button', async ($, on) => {
  const state = { thresholds: { green: 50, yellow: 80, warn: 90, critical: 95 }, autopilot: 'notify', keepWorking: false, sessionBoard: false, forecast: { window: 'session', etaSec: 2700, safe: false, text: '⏳ ~45m to session limit' } }
  const { seen } = setup(on, { rig: JSON.stringify({ v: '1.8.0', segments: [], widths: [], state }) })
  await start($)
  await measure($, 63)
  const answer = await $.command.run({ command: 'ccrig', args: 'usage' })
  expect(answer).toEqual({})
  expect(seen.opened).toContain('ccrig-usage')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'ccrig', component: 'Pane', requestId: 'ccrig-usage', surface,
      viewport: { columns: 100, rows: 30 },
      props: { title: 'CCRig usage', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /^session$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'pace: ⏳ ~45m to session limit' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$1.25 this session' })).toBeDefined()
    await ui.press({ key: 'usage-copy' })
    await ui.unmount()
  }
  expect(seen.copies.length).toBe(2)
})

// ---- where the mod runs --------------------------------------------------------------------------

test('a headless session forwards the hooks and runs nothing else', async ($, on) => {
  const { seen, clock } = setup(on)
  on('classic.Stop', () => ({}))
  await start($, null, false)
  await clock.advance(5 * 60 * 1000)
  await settle()
  expect(renders(seen)).toBe(0)
  await measure($, 96)
  await settle()
  expect(seen.toasts).toEqual([])
  expect(renders(seen)).toBe(0)
  // the classic hooks still run the guardian, and /ccrig still answers
  await $.classic.Stop(stopEvent())
  expect(hookRuns(seen)).toEqual(['stop'])
  expect(seen.registered.length).toBe(1)
})

test('a VS Code session draws nothing and starts no timer', async ($, on) => {
  const { seen, clock } = setup(on)
  await start($, 'vscode', true)
  await clock.advance(3 * 60 * 1000)
  await settle()
  expect(renders(seen)).toBe(0)
})

test('the Desktop app without process.run: one attempt, then a Desktop reply', async ($, on) => {
  const { seen } = setup(on, { noNode: true })
  await start($, 'desktop', true)
  const status = await $.command.run({ command: 'ccrig', args: 'status' })
  const board = await $.command.run({ command: 'ccrig', args: 'board' })
  expect(seen.runs.length).toBe(2)
  expect(seen.runs.map((r) => r.argv[0])).toEqual(['node', 'node.exe'])
  expect(status.text).toContain('Desktop app')
  expect(board.text).toContain('Desktop app')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
  await ui.unmount()
})

test('on Windows the mod finds node.exe when a bare node does not start, and sticks with it', async ($, on) => {
  const { seen } = setup(on, { noBareNode: true })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'my-app' })).toBeDefined()
  await ui.unmount()
  await $.command.run({ command: 'ccrig', args: 'status' })
  const bins = seen.runs.map((r) => r.argv[0])
  expect(bins.slice(0, 2)).toEqual(['node', 'node.exe'])
  expect(bins.slice(2).every((b) => b === 'node.exe')).toBe(true)
  expect(bins.length).toBeGreaterThan(2)
})

// ---- the band, the spinner, the toasts -------------------------------------------------------------

test('standalone: the band draws the bar statusline.js rendered, and the render may act', async ($, on) => {
  const { seen } = setup(on)
  await start($)
  const render = seen.runs.find((r) => r.argv.length === 2)
  expect(render).toBeDefined()
  expect(render!.argv[0]).toBe('node')
  expect(render!.argv[1]).toMatch(/statusline\.js$/)
  expect(render!.init.env).toMatchObject({ CCRIG_HOST: 'mod', CCRIG_INTERACTIVE: '1', CCRIG_MOD_OWNS_RESUME: '1' })
  expect(render!.init.env!.CCRIG_PURE).toBeUndefined()
  expect(render!.init.env!.NO_UPDATE_NOTIFIER).toBeUndefined()
  expect(JSON.parse(render!.init.stdin!)).toMatchObject({ session_id: 'sess-1', model: { display_name: 'Opus 5.5' } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'my-app' })).toBeDefined()
  await ui.unmount()
})

test('standalone without Node: the band falls back to the native line', async ($, on) => {
  setup(on, { rig: null })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
  await ui.unmount()
})

test('with a CCRig status line wired, the band stays out of the way until a window passes warn', async ($, on) => {
  const { seen } = setup(on, { settings: WIRED })
  await start($)
  expect(renders(seen)).toBe(0)

  await measure($, 40)
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  await ui.unmount()

  await measure($, 92)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /⚠ session 92%/ })).toBeDefined()
  await ui.press({ key: 'alert-copy' })
  expect(seen.copies.map(String)).toContain('claude --resume sess-1')
  await ui.press({ key: 'alert-hide' })
  expect(await ui.find({ type: 'Text', text: /⚠ session 92%/ })).toBeUndefined()
  await ui.unmount()

  // a worse alert comes back after a hide
  await measure($, 96)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /⚠ session 96%/ })).toBeDefined()
  await ui.unmount()
})

test('a toast when a window crosses warn, and again at critical, never twice for one line', async ($, on) => {
  const { seen } = setup(on, { settings: WIRED })
  await start($)
  await measure($, 85)
  expect(seen.toasts).toEqual([])
  await measure($, 91)
  await measure($, 92)
  expect(seen.toasts.length).toBe(1)
  expect(seen.toasts[0]).toMatch(/^⚠ session 91% used, resets .+\. Pick up later with: claude --resume sess-1$/)
  await measure($, 95)
  expect(seen.toasts.length).toBe(2)
})

test('the warn line comes from ~/.ccrig/statusline.config.json until a render reports it', async ($, on) => {
  const { seen } = setup(on, { settings: WIRED, config: '{"thresholds":{"usage":{"warn":70,"critical":80}}}' })
  await start($)
  await measure($, 72)
  expect(seen.toasts.length).toBe(1)
})

test('the warn line statusline.js reports wins over the config file', async ($, on) => {
  const state = { thresholds: { green: 50, yellow: 80, warn: 85, critical: 93 }, autopilot: 'notify', keepWorking: false, sessionBoard: false }
  const { seen } = setup(on, { config: '{"thresholds":{"usage":{"warn":70}}}', rig: JSON.stringify({ v: '1.8.0', segments: [], widths: [], state }) })
  await start($)
  await measure($, 72)
  expect(seen.toasts).toEqual([])
  await measure($, 86)
  expect(seen.toasts.length).toBe(1)
})

test('the spinner names the window to watch', async ($, on) => {
  const { seen } = setup(on, { settings: WIRED })
  await start($)
  await measure($, 63)
  const ui = await $.ui.mount({
    plugin: 'ccrig', component: 'Spinner', requestId: 'main', surface: 'terminal',
    viewport: { columns: 100, rows: 30 },
    props: { word: 'Thinking', message: null, suffix: '…', mode: 'thinking' },
  })
  expect(seen.rendered?.props.suffix).toBe(' · session 63%…')
  await ui.unmount()
})

test('cadence: one render at start, one a minute, one per measure, none per turn', async ($, on) => {
  const { seen, clock } = setup(on)
  await start($)
  expect(renders(seen)).toBe(1)
  await clock.advance(59000)
  await settle()
  expect(renders(seen)).toBe(1)
  await clock.advance(1000)
  await settle()
  expect(renders(seen)).toBe(2)
  await measure($, 40)
  await settle()
  expect(renders(seen)).toBe(3)
  await $.turn.complete({ turnId: 't', answer: 'ok', durationMs: 10, isAborted: false, usage: null })
  await settle()
  expect(renders(seen)).toBe(3)
})

test('a /config change to the band applies at once, and the node from settings is tried first', async ($, on) => {
  const quoted = { ...WIRED, statusLine: { type: 'command', command: '"C:/Program Files/nodejs/node.exe" "C:/npm/node_modules/ccrig/statusline.js"' } }
  const { seen } = setup(on, { settings: quoted })
  on('config.set', ($, e) => ({ value: e.value }))
  await start($)
  expect(renders(seen)).toBe(0)
  await $.config.set({ key: 'ccrig.band', value: 'always', previous: 'auto', provider: { plugin: 'ccrig', tier: 'user' }, origin: { kind: 'composer' } })
  await settle()
  expect(renders(seen)).toBe(1)
  expect(seen.runs[0].argv[0]).toBe('C:/Program Files/nodejs/node.exe')
  expect(seen.runs[0].init.env).toMatchObject({ CCRIG_PURE: '1' })
  await $.config.set({ key: 'ccrig.band', value: 'off', previous: 'always', provider: { plugin: 'ccrig', tier: 'user' }, origin: { kind: 'composer' } })
  await measure($, 97)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  await ui.unmount()
})

test('the /ccrig:* markdown commands are hidden from the menu, others are not', async ($, on) => {
  setup(on)
  on('command.describe', ($, e) => ({ description: e.description, isHidden: e.isHidden }))
  const legacy = await $.command.describe({ command: 'ccrig:doctor', description: 'x', isHidden: false, immediate: false })
  expect(legacy.isHidden).toBe(true)
  const other = await $.command.describe({ command: 'review', description: 'y', isHidden: false, immediate: false })
  expect(other.isHidden).toBe(false)
})

// ---- the guardian's hooks ------------------------------------------------------------------------

test('Stop goes to the guardian when ccrig init did not wire it, and keep-working can block', async ($, on) => {
  const { seen } = setup(on, { hookOut: '{"decision":"block","reason":"Do not stop yet: 2 todo(s) still open."}' })
  on('classic.Stop', () => ({}))
  await start($)
  const result = await $.classic.Stop(stopEvent('sess-2'))
  expect(result.block).toBe('Do not stop yet: 2 todo(s) still open.')
  const hook = seen.runs.find((r) => r.argv.includes('--hook'))
  expect(hook!.argv.slice(-2)).toEqual(['--hook', 'stop'])
  expect(JSON.parse(hook!.init.stdin!).session_id).toBe('sess-2')
})

test('hooks wired by ccrig init are left to it', async ($, on) => {
  const { seen } = setup(on, { settings: WIRED, hookOut: '{"decision":"block","reason":"x"}' })
  on('classic.Stop', () => ({}))
  await start($)
  const result = await $.classic.Stop(stopEvent())
  expect(result.block).toBeUndefined()
  expect(hookRuns(seen)).toEqual([])
})

test('a bar-only install with the lamps wired: Stop runs nothing from the mod', async ($, on) => {
  const { seen } = setup(on, { settings: LAMPS_ONLY, config: '{"sessionBoard":true,"autopilot":"off"}' })
  on('classic.Stop', () => ({}))
  await start($)
  await $.classic.Stop(stopEvent())
  expect(hookRuns(seen)).toEqual([])
})

test('nothing wired, guardian off, board on: Stop runs board-stop, never stop', async ($, on) => {
  const { seen } = setup(on, { config: '{"sessionBoard":true,"autopilot":"off"}' })
  on('classic.Stop', () => ({}))
  await start($)
  await $.classic.Stop(stopEvent())
  expect(hookRuns(seen)).toEqual(['board-stop'])
})

test('autopilot off: PreCompact checkpoints nothing, a resume still gets its context', async ($, on) => {
  const { seen } = setup(on, { config: '{"autopilot":"off"}', hookOut: '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"You hit the limit at step 3."}}' })
  on('classic.PreCompact', () => ({}))
  on('classic.SessionStart', () => ({}))
  await start($)
  await $.classic.PreCompact({ hook_event_name: 'PreCompact', session_id: 's', transcript_path: '/t', cwd: '/w', trigger: 'auto' })
  expect(hookRuns(seen)).toEqual([])
  const result = await $.classic.SessionStart({ hook_event_name: 'SessionStart', session_id: 's', transcript_path: '/t', cwd: '/w', source: 'resume' })
  expect(result.additionalContext).toEqual(['You hit the limit at step 3.'])
  expect(hookRuns(seen)).toEqual(['session-start'])
})

test('after /clear the band renders the new session', async ($, on) => {
  let sid = 'sess-1'
  const { seen } = setup(on, { sessionId: () => sid })
  on('classic.SessionStart', () => ({}))
  await start($)
  sid = 'sess-2'
  await $.classic.SessionStart({ hook_event_name: 'SessionStart', session_id: 'sess-2', transcript_path: '/t2', cwd: '/work2', source: 'clear' })
  await settle()
  const last = seen.runs.filter((r) => r.argv.length === 2).at(-1)
  expect(JSON.parse(last!.init.stdin!)).toMatchObject({ session_id: 'sess-2', transcript_path: '/t2' })
  expect(hookRuns(seen)).toEqual([])
})

test('SessionEnd runs the board cleanup first, with a short timeout', async ($, on) => {
  const { seen } = setup(on, { settings: WIRED, config: '{"sessionBoard":true}' })
  on('classic.SessionEnd', () => {
    seen.order.push('core')
    return {}
  })
  await start($)
  await $.classic.SessionEnd({ hook_event_name: 'SessionEnd', session_id: 's', transcript_path: '/t', cwd: '/w', reason: 'prompt_input_exit' })
  const ends = seen.order.filter((x) => x === 'core' || x.includes('--hook session-end'))
  expect(ends).toEqual(['run:--hook session-end', 'core'])
  const run = seen.runs.find((r) => r.argv.includes('session-end'))
  expect(run!.init.timeoutMs).toBe(2000)
})

// ---- in-session auto-resume ----------------------------------------------------------------------

test('the mod resumes the session in place after the reset', async ($, on) => {
  const { seen, clock } = setup(on, { config: '{"autopilot":"resume"}', hookOut: (argv) => argv.includes('mod-resume') ? '{"prompt":"Continue now."}' : '' })
  await start($)
  await measure($, 96)
  await clock.advance(2 * HOUR + 30000)
  await settle()
  expect(hookRuns(seen).filter((h) => h === 'mod-resume').length).toBe(1)
  expect(seen.submits).toEqual(['Continue now.'])
  expect(seen.toasts.some((t) => /continuing this session/.test(t))).toBe(true)
})

test('no resume prompt from statusline.js, no submit', async ($, on) => {
  const { seen, clock } = setup(on, { config: '{"autopilot":"resume"}', hookOut: '{}' })
  await start($)
  await measure($, 96)
  await clock.advance(2 * HOUR + 30000)
  await settle()
  expect(hookRuns(seen)).toContain('mod-resume')
  expect(seen.submits).toEqual([])
})

test('with a wired status line the npm guardian keeps the resume: no timer', async ($, on) => {
  const { seen, clock } = setup(on, { settings: WIRED, config: '{"autopilot":"resume"}', hookOut: '{"prompt":"x"}' })
  await start($)
  await measure($, 96)
  await clock.advance(2 * HOUR + 30000)
  await settle()
  expect(hookRuns(seen)).not.toContain('mod-resume')
})

test('/ccrig autopilot notify cancels a pending resume', async ($, on) => {
  const { seen, clock } = setup(on, { config: '{"autopilot":"resume"}', hookOut: '{"prompt":"x"}' })
  await start($)
  await measure($, 96)
  await $.command.run({ command: 'ccrig', args: 'autopilot notify' })
  await clock.advance(2 * HOUR + 30000)
  await settle()
  expect(hookRuns(seen)).not.toContain('mod-resume')
  expect(seen.submits).toEqual([])
})

test('closing the terminal with autopilot on resume hands the resume to the watcher (mod-exit)', async ($, on) => {
  const { seen } = setup(on, { config: '{"autopilot":"resume"}' })
  on('classic.SessionEnd', () => ({}))
  await start($)
  await $.classic.SessionEnd({ hook_event_name: 'SessionEnd', session_id: 'sess-1', transcript_path: '/t', cwd: '/w', reason: 'prompt_input_exit' })
  expect(hookRuns(seen)).toEqual(['mod-exit'])
})
