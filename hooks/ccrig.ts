// CCRig as a Claude Code mod. Install it with /plugin and you get:
//   - the CCRig bar drawn natively in the band above the prompt (statusline.js renders the segments,
//     this module lays them out), or only a limit alert there when `ccrig init` already wired a status line
//   - the live plan usage beside the spinner while Claude works
//   - a toast the moment a usage window crosses your warn or critical line, pushed by Claude Code
//   - /ccrig: a command that answers at once, even mid-turn, with no Claude turn spent on it
//   - the guardian's hooks (checkpoints, keep-working, board lamps) without editing settings.json
//   - with autopilot "resume", the session continues in place at the reset while its terminal is open
// statusline.js makes every CCRig decision; this module draws, routes events and runs commands. The
// npm install and the mod share one renderer, one guardian and one config file
// (~/.ccrig/statusline.config.json). Interactive sessions draw; a claude -p or SDK run only hooks.

import type { Span, Seg, Usage, RateLimit, ModState } from './lib.ts'
import {
  CHANGES_BAR, COLOR, HELP, alertFor, alertKey, ansiToSpans, classicResult, cliArgs, configFrom,
  crossings, detectWiring, fmtReset, liveLimits, nativeSegments, nodeFromSettings, packLines,
  parseRigOutput, plainText, resumeCommand, splitArgs, statusInput, summaryLine, usageSeg,
  windowLabel, xterm256,
} from './lib.ts'

const USAGE_PANE = 'ccrig-usage'
const BOARD_PANE = 'ccrig-board'
const BAND_MODES = ['auto', 'always', 'alerts', 'off']

// set from the plugin's userConfig (the ccrig rows in /config)
let band = 'auto'
let spinner = true
let toasts = true

// where this session runs: only an interactive terminal or Desktop session draws or acts on its own
let surface: string | null = null
let draws = false

// what this session knows
let sessionId = ''
let transcriptPath = ''
let cwd = ''
let projectDir = ''
let model = ''
let version = ''
let effort = ''
const sessionName = ''
let usage: Usage | null = null
let wiring: { statusLine: boolean; hooks: string[] } = { statusLine: false, hooks: [] }
let settingsNode: string | null = null

// CCRig's decisions: from the last render's `state`, else from the config file
let rigState: ModState | null = null
let fileState: ModState = configFrom(null)

// the full CCRig line as statusline.js last rendered it; null means draw the native line
let rig: Seg[] | null = null
let rendering = false
let renderAgain = false
let columns = 120

// alerts, the board pane and the in-session resume
let lastPct: Record<string, number> = {}
let hidden = ''
let boardLines: Span[][] = []
let boardOpen = false
let resumeTimer: { cancel: () => void } | null = null
let resumeAt = 0
let resumeKind = ''
let resumeTries = 0

function cur(): ModState {
  return rigState ?? fileState
}

// the mod owns the render (and so the guardian's render-side work) when no CCRig status line is wired
function ownsRender(): boolean {
  return draws && !wiring.statusLine
}

// the bar renders when no wired status line already does, or when the band is asked to always show it
function wantRig(): boolean {
  return draws && (!wiring.statusLine || band === 'always')
}

function showRigInBand(): boolean {
  return band === 'always' || (band === 'auto' && !wiring.statusLine)
}

function wired(slug: string): boolean {
  return wiring.hooks.includes(slug)
}

function modEnv(): Record<string, string> {
  const env: Record<string, string> = { CCRIG_HOST: 'mod', COLUMNS: String(columns) }
  // a wired status line owns checkpoints, tickets and samples; the band only draws
  if (wiring.statusLine) env.CCRIG_PURE = '1'
  // only an interactive session's render may act; a claude -p run never checkpoints or arms anything
  if (draws) env.CCRIG_INTERACTIVE = '1'
  // the mod resumes in place, so the render must not arm the detached watcher (mod-exit does at close)
  if (ownsRender()) env.CCRIG_MOD_OWNS_RESUME = '1'
  return env
}

// the usage window the spinner names: the one past the warn line, else the 5-hour window
function spinnerLimit(now: number): RateLimit | null {
  const live = liveLimits(usage, now)
  const alert = alertFor(usage, cur().thresholds, now)
  if (alert) return live.find((r) => r.kind === alert.kind) ?? null
  return live.find((r) => r.kind === 'five_hour') ?? live[0] ?? null
}

function alertText(kind: string, pct: number, resetsAt: string | undefined, now: number): string {
  const reset = fmtReset(resetsAt, now)
  return '⚠ ' + windowLabel(kind) + ' ' + Math.round(pct) + '% used' + (reset ? ', resets ' + reset : '') +
    '. Pick up later with: ' + resumeCommand(sessionId)
}

function noNodeText(what: string): string {
  if (surface === 'desktop') {
    return 'The Desktop app does not let a mod start the CCRig CLI. Run /ccrig ' + what + ' in a terminal session, or ccrig ' + what + ' in a shell.'
  }
  return 'CCRig needs Node 18 or newer on your PATH for /ccrig ' + what + '.'
}

// Run statusline.js with Node. A mod starts processes with no shell, so try the node a wired CCRig
// command already uses, then node, then node.exe (Windows), and remember the one that started. When
// none does, back off for five minutes in a terminal, and for the session in the Desktop app.
let nodeBin = ''
let noNodeUntil = 0
async function runCcrig($, args: string[], init: { stdin?: string; env?: Record<string, string>; timeoutMs?: number; cwd?: string }) {
  if (Date.now() < noNodeUntil) throw new Error('node is not available')
  const tries = nodeBin ? [nodeBin] : [...new Set([settingsNode, 'node', 'node.exe'].filter(Boolean) as string[])]
  let last: unknown
  for (const bin of tries) {
    try {
      const out = await $.process.run([bin, $.plugin.root + '/statusline.js', ...args], init)
      nodeBin = bin
      return out
    } catch (err) {
      last = err
    }
  }
  nodeBin = ''
  noNodeUntil = surface === 'desktop' ? Infinity : Date.now() + 5 * 60 * 1000
  throw last
}

async function loadConfig($) {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  let text = ''
  if (home) {
    const file = home.replace(/[\\/]+$/, '') + '/.ccrig/statusline.config.json'
    try {
      if (await $.fs.exists(file)) text = await $.fs.read(file)
    } catch {
      text = ''
    }
  }
  fileState = configFrom(text)
}

async function learnSession($) {
  try { sessionId = await $.session.id() } catch {}
  try { cwd = await $.session.cwd() } catch {}
  try { projectDir = await $.session.root() } catch {}
  try { model = await $.session.model() } catch {}
  try { version = (await $.session.version()).version } catch {}
  try {
    const settings = await $.settings.read()
    wiring = detectWiring(settings)
    settingsNode = nodeFromSettings(settings)
    effort = typeof settings?.effortLevel === 'string' ? settings.effortLevel : ''
  } catch {}
  try {
    const u = await $.session.usage()
    usage = { context: u.context, rateLimits: u.rateLimits, cost: u.cost }
  } catch {}
}

// Render the CCRig segments with statusline.js. One render at a time; a request that lands mid-render
// runs once more after it, with the newest figures.
async function refreshRig($) {
  if (!wantRig()) return
  if (rendering) {
    renderAgain = true
    return
  }
  rendering = true
  try {
    do {
      renderAgain = false
      try { model = await $.session.model() } catch {}
      const input = statusInput({ sessionId, transcriptPath, cwd, projectDir, model, version, effort, sessionName, usage })
      try {
        const out = await runCcrig($, [], { stdin: JSON.stringify(input), env: modEnv(), timeoutMs: 15000 })
        const parsed = out.exitCode === 0 ? parseRigOutput(out.stdout) : null
        rig = parsed ? parsed.segs : null
        if (parsed?.state) rigState = parsed.state
      } catch {
        // no Node on PATH, or an app where a mod cannot start processes: the native line takes over
        rig = null
      }
    } while (renderAgain)
  } finally {
    rendering = false
  }
  $.ui.invalidate('ui.render')
}

async function refreshBoard($) {
  try {
    const out = await runCcrig($, ['--board'], { env: { CCRIG_HOST: 'mod', NO_COLOR: '1' }, timeoutMs: 15000 })
    boardLines = (out.stdout || out.stderr || '').replace(/\s+$/, '').split('\n').map(ansiToSpans)
  } catch {
    boardLines = [[{ text: noNodeText('board') }]]
  }
  $.ui.invalidate('ui.render')
}

// Run a validated CCRig CLI command and hand back its output as the command's reply.
async function cli($, argv: string[]) {
  let out
  try {
    out = await runCcrig($, argv, {
      env: { CCRIG_HOST: 'mod', NO_COLOR: '1' },
      timeoutMs: 60000,
      // a session label belongs to the project, wherever in it the session runs
      cwd: argv[0] === 'name' ? projectDir || cwd || undefined : undefined,
    })
  } catch {
    return { text: noNodeText(argv[0]) }
  }
  if (CHANGES_BAR.has(argv[0])) {
    await loadConfig($)
    if (rigState && argv[0] === 'autopilot') rigState = { ...rigState, autopilot: argv[1] }
    if (argv[0] === 'autopilot' && argv[1] !== 'resume') cancelResume()
    void refreshRig($)
  }
  const text = plainText([out.stdout, out.stderr].filter(Boolean).join('\n').trim())
  return { text: text || '/ccrig ' + argv[0] + ': done' }
}

// Run one of CCRig's settings hooks with the event's JSON and fold its answer into what the settings
// hooks decided. The callers check that settings.json does not already run the slug.
async function forward($, slug: string, e, base, timeoutMs = 20000) {
  const result = base && typeof base === 'object' ? base : {}
  try {
    const out = await runCcrig($, ['--hook', slug], { stdin: JSON.stringify(e), env: { CCRIG_HOST: 'mod' }, timeoutMs })
    return classicResult(out.stdout, result)
  } catch {
    return result
  }
}

// ---- in-session auto-resume ----------------------------------------------------------------------
// With autopilot "resume" and the mod owning the render, a window at the critical line schedules one
// timer for its reset. At the reset statusline.js decides (--hook mod-resume, the watcher's own rules)
// and the mod submits the resume prompt into this same session. Closing the terminal first hands the
// resume to the detached watcher (--hook mod-exit).

function cancelResume() {
  if (resumeTimer) resumeTimer.cancel()
  resumeTimer = null
  resumeAt = 0
  resumeKind = ''
  resumeTries = 0
}

function scheduleResume($, now: number) {
  if (!ownsRender() || cur().autopilot !== 'resume') {
    cancelResume()
    return
  }
  const crit = liveLimits(usage, now).find((r) => r.percentUsed >= cur().thresholds.critical && !!r.resetsAt)
  if (!crit) return
  const at = Date.parse(crit.resetsAt as string) + 15000
  if (!Number.isFinite(at) || (resumeTimer && resumeAt === at)) return
  cancelResume()
  resumeAt = at
  resumeKind = crit.kind
  resumeTimer = $.clock.after(Math.max(0, at - now), () => { void fireResume($) })
}

async function fireResume($) {
  resumeTimer = null
  if (!ownsRender() || cur().autopilot !== 'resume') return cancelResume()
  const now = await $.clock.now()
  let still = false
  try {
    const u = await $.session.usage()
    usage = { context: u.context, rateLimits: u.rateLimits, cost: u.cost }
    still = liveLimits(usage, now).some((r) => r.kind === resumeKind && r.percentUsed >= cur().thresholds.warn)
  } catch {}
  if (still) {
    // clock skew, or the account is still capped: look again in a minute, ten times at most
    resumeTries += 1
    if (resumeTries > 10) {
      $.ui.toast('CCRig: the limit has not lifted yet. Resume by hand with ' + resumeCommand(sessionId), { timeoutMs: 8000 })
      return cancelResume()
    }
    resumeTimer = $.clock.after(60000, () => { void fireResume($) })
    return
  }
  let prompt = ''
  try {
    const out = await runCcrig($, ['--hook', 'mod-resume'], {
      stdin: JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath, cwd }),
      env: modEnv(),
      timeoutMs: 20000,
    })
    const o = JSON.parse(out.stdout || '{}')
    if (typeof o?.prompt === 'string') prompt = o.prompt
  } catch {}
  cancelResume()
  if (!prompt) return
  $.ui.toast('CCRig: the usage window reset, continuing this session', { timeoutMs: 8000 })
  void $.prompt.submit({ text: prompt })
}

// ---- drawing ---------------------------------------------------------------------------------------

// Text props for one styled run; a prop is left out rather than passed as undefined
function spanProps(s: Span, extra: Record<string, unknown> = {}) {
  const props: Record<string, unknown> = { ...extra, children: [s.text] }
  if (s.color) props.color = s.color
  if (s.bold) props.bold = true
  return props
}

function noteHookInput(e) {
  if (typeof e?.session_id === 'string' && e.session_id) sessionId = e.session_id
  if (typeof e?.transcript_path === 'string' && e.transcript_path) transcriptPath = e.transcript_path
  if (typeof e?.cwd === 'string' && e.cwd) cwd = e.cwd
}

function usagePane($, e) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const now = Date.now()
  const barWidth = Math.max(10, Math.min(30, (e.props.bodyColumns || 60) - 40))
  const line = (key: string, spans: Span[]) =>
    Box({ key, flexDirection: 'row', children: spans.map((s) => Text(spanProps(s))) })
  const dim = xterm256(COLOR.dim)
  const rows = []
  const pct = usage?.context?.percent
  if (typeof pct === 'number') {
    const ctx = usageSeg({ kind: 'context', percentUsed: pct }, { green: 50, yellow: 70, warn: 101, critical: 101 }, now, barWidth)
    const tokens = usage?.context?.tokens
    const window = usage?.context?.window
    const detail = typeof tokens === 'number' && typeof window === 'number'
      ? [{ text: '   ' + Math.round(tokens / 1000) + 'k of ' + Math.round(window / 1000) + 'k tokens', color: dim }]
      : []
    rows.push(line('ctx', [...ctx.spans, ...detail]))
  }
  const live = liveLimits(usage, now)
  for (const r of live) rows.push(line('w-' + r.kind, usageSeg(r, cur().thresholds, now, barWidth).spans))
  if (!live.length) rows.push(Text({ color: dim, children: ['No plan usage yet. It appears after the first reply on a Pro or Max plan.'] }))
  const f = cur().forecast
  if (f && f.text) rows.push(Text({ color: xterm256(f.safe ? COLOR.green : COLOR.yellow), children: ['pace: ' + f.text] }))
  if (usage?.cost && typeof usage.cost.usd === 'number') {
    rows.push(Text({ color: dim, children: ['$' + usage.cost.usd.toFixed(2) + ' this session'] }))
  }
  const hint = cur().update?.hint
  if (hint) rows.push(Text({ color: xterm256(COLOR.yellow), children: ['A newer CCRig is out: ' + hint] }))
  rows.push(Text({ children: [' '] }))
  rows.push(Box({
    flexDirection: 'row',
    columnGap: 2,
    children: [
      Button({
        key: 'usage-copy',
        label: 'Copy resume command',
        onPress: async () => {
          try { await $.ui.copy({ text: resumeCommand(sessionId) }) } catch {}
          $.ui.toast('Copied: ' + resumeCommand(sessionId))
        },
      }),
      Button({ key: 'usage-close', label: 'Close', onPress: () => $.ui.close({ id: USAGE_PANE }) }),
    ],
  }))
  return Box({ flexDirection: 'column', children: rows })
}

function boardPane($, e) {
  const { Box, Text } = $.ui.resolve(e)
  const lines = boardLines.length ? boardLines : [[{ text: 'Reading the board...' }]]
  return Box({
    flexDirection: 'column',
    children: lines.map((spans, i) =>
      Box({
        key: 'b-' + i,
        flexDirection: 'row',
        children: spans.map((s) => Text(spanProps(s, { wrap: 'truncate' }))),
      })),
  })
}

export function register(on, options: { band?: string; spinner?: boolean; alerts?: boolean } = {}) {
  band = BAND_MODES.includes(String(options?.band)) ? String(options.band) : 'auto'
  spinner = options?.spinner !== false
  toasts = options?.alerts !== false

  on('session.start', async ($, e, next) => {
    surface = e.surface ?? null
    draws = e.isInteractive === true && (surface === 'terminal' || surface === 'desktop')
    await learnSession($)
    await loadConfig($)
    if (draws) {
      void refreshRig($)
      // between turns only the clock and git state move: redraw once a minute
      $.clock.every(60000, () => { void refreshRig($) })
      $.clock.every(5000, () => { if (boardOpen) void refreshBoard($) })
    }
    try {
      await $.command.register({
        name: 'ccrig',
        description: 'CCRig: plan usage, the usage and board panes, and status line settings',
        argumentHint: '[usage | board | mode <m> | autopilot <m> | collapse | expand | toggle | status | doctor | help]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('could not add /ccrig: ' + String(err?.message ?? err), { to: 'debug' })
    }
    return next(e)
  })

  // Claude Code pushes these after each turn and whenever a usage window moves a whole point
  on('session.measure', async ($, e, next) => {
    usage = { context: e.context, rateLimits: e.rateLimits, cost: e.cost }
    if (draws) {
      const now = await $.clock.now()
      if (toasts) {
        for (const a of crossings(lastPct, usage, cur().thresholds, now)) $.ui.toast(alertText(a.kind, a.pct, a.resetsAt, now), { timeoutMs: 8000 })
      }
      scheduleResume($, now)
      void refreshRig($)
      $.ui.invalidate('ui.render')
    }
    lastPct = Object.fromEntries((e.rateLimits ?? []).map((r) => [r.kind, r.percentUsed]))
    return next(e)
  })

  // The guardian's settings hooks, run from here for each slug settings.json does not already run, and
  // only when CCRig's own config asks for that behavior.
  on('classic.SessionStart', async ($, e, next) => {
    noteHookInput(e)
    const base = await next(e)
    if (e.source === 'clear' || e.source === 'resume' || e.source === 'fork') {
      // a new session id: the old one's resume timer and drawing no longer apply
      cancelResume()
      await learnSession($)
      noteHookInput(e)
      if (draws) void refreshRig($)
    }
    if ((e.source === 'resume' || e.source === 'compact') && !wired('session-start')) return forward($, 'session-start', e, base)
    return base
  })

  on('classic.Stop', async ($, e, next) => {
    noteHookInput(e)
    const base = await next(e)
    const s = cur()
    if (!wired('stop') && (s.autopilot !== 'off' || s.keepWorking)) return forward($, 'stop', e, base)
    if (s.sessionBoard && !wired('board-stop') && !wired('stop')) return forward($, 'board-stop', e, base)
    return base
  })

  on('classic.PreCompact', async ($, e, next) => {
    noteHookInput(e)
    const base = await next(e)
    if (!wired('pre-compact') && cur().autopilot !== 'off') return forward($, 'pre-compact', e, base)
    return base
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    noteHookInput(e)
    const base = await next(e)
    if (cur().sessionBoard && !wired('user-prompt')) return forward($, 'user-prompt', e, base)
    return base
  })

  on('classic.Notification', { notification_type: ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input', 'idle_prompt'] }, async ($, e, next) => {
    const base = await next(e)
    if (cur().sessionBoard && !wired('notification')) return forward($, 'notification', e, base)
    return base
  })

  // runs before Claude Code's own exit work, with a short timeout, so the board cleanup and the watcher
  // hand-off finish while the process is still up
  on('classic.SessionEnd', async ($, e, next) => {
    if (ownsRender() && cur().autopilot === 'resume') await forward($, 'mod-exit', e, {}, 2000)
    else if (cur().sessionBoard && !wired('session-end')) await forward($, 'session-end', e, {}, 2000)
    return next(e)
  })

  // the band above the prompt: the bar, a limit alert, or nothing
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!draws || e.props.hasSurvey || band === 'off') return next(e)
    columns = e.props.bodyColumns || columns
    const now = Date.now()
    const showRig = showRigInBand()
    const alert = alertFor(usage, cur().thresholds, now)
    const showAlert = !!alert && alertKey(alert) !== hidden
    if (!showRig && !showAlert) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const children = []
    if (showRig) {
      const segs = rig ?? nativeSegments(model, usage, cur().thresholds, now)
      packLines(segs, Math.max(20, columns - 1)).forEach((spans, i) => {
        children.push(Box({ key: 'rig-' + i, flexDirection: 'row', children: spans.map((s) => Text(spanProps(s))) }))
      })
    }
    if (showAlert && alert) {
      const reset = fmtReset(alert.resetsAt, now)
      const resume = resumeCommand(sessionId)
      children.push(Box({
        key: 'alert',
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: 1,
        children: [
          Text({ color: xterm256(COLOR.red), bold: true, children: ['⚠ ' + alert.label + ' ' + Math.round(alert.pct) + '%'] }),
          Text({ color: xterm256(COLOR.dim), children: [(reset ? 'resets ' + reset + ' · ' : '') + resume] }),
          Button({
            key: 'alert-copy',
            label: 'Copy',
            onPress: async () => {
              try { await $.ui.copy({ text: resume }) } catch {}
              $.ui.toast('Copied: ' + resume)
            },
          }),
          Button({
            key: 'alert-hide',
            label: 'Hide',
            onPress: () => {
              hidden = alertKey(alert)
              $.ui.invalidate('ui.render')
            },
          }),
        ],
      }))
    }
    // keep what other mods draw in the band, under ours
    const below = await next(e)
    if (below && typeof below === 'object') children.push(below)
    return Box({ flexDirection: 'column', children })
  })

  // the spinner names the usage window to watch: "Thinking · session 63%…"
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!draws || !spinner) return next(e)
    const r = spinnerLimit(Date.now())
    if (!r) return next(e)
    const suffix = ' · ' + windowLabel(r.kind) + ' ' + Math.round(r.percentUsed) + '%' + (e.props.suffix ?? '…')
    return next({ ...e, props: { ...e.props, suffix } })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId === USAGE_PANE) return usagePane($, e)
    if (e.requestId === BOARD_PANE) return boardPane($, e)
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === BOARD_PANE) boardOpen = false
    return next(e)
  })

  // the /ccrig:* markdown commands an npm `ccrig init` wrote cost a Claude turn each; this /ccrig does not
  on('command.describe', { command: /^ccrig:/ }, async ($, e, next) => {
    const r = await next(e)
    return { ...(r && typeof r === 'object' ? r : {}), isHidden: true }
  })

  // a change to a ccrig row in /config applies at once
  on('config.set', { key: /^ccrig\./ }, async ($, e, next) => {
    const r = await next(e)
    if (r && 'deny' in r && r.deny) return r
    const field = String(e.key).slice('ccrig.'.length)
    if (field === 'band' && BAND_MODES.includes(String(e.value))) band = String(e.value)
    if (field === 'spinner') spinner = e.value !== false
    if (field === 'alerts') toasts = e.value !== false
    if (draws && wantRig() && !rig) void refreshRig($)
    $.ui.invalidate('ui.render')
    return r
  })

  on('command.run', { command: 'ccrig' }, async ($, e) => {
    const [sub = '', ...rest] = splitArgs(e.args)
    if (!sub) return { text: summaryLine(model, usage, Date.now()) }
    if (sub === 'help' || sub === '--help' || sub === '-h') return { text: HELP }
    if (sub === 'usage') {
      await $.ui.open({ id: USAGE_PANE, title: 'CCRig usage', focus: true, closeOnEscape: true })
      return {}
    }
    if (sub === 'board') {
      if (Date.now() < noNodeUntil) return { text: noNodeText('board') }
      boardOpen = true
      await refreshBoard($)
      await $.ui.open({ id: BOARD_PANE, title: 'CCRig board', focus: true, closeOnEscape: true })
      return {}
    }
    const parsed = cliArgs(sub, rest)
    if ('error' in parsed) return { text: parsed.error + '\n\n' + HELP }
    return cli($, parsed.argv)
  })
}
