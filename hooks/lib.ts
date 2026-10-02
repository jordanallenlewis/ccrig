// Pure helpers for the CCRig mod. Nothing here calls the mods API, so tests import these directly
// and the hooks module (ccrig.ts) stays a thin layer of event handlers.

export type Span = { text: string; color?: string; bold?: boolean }
export type Seg = { spans: Span[]; width: number }
export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }
export type Usage = {
  context?: { tokens?: number; window?: number; percent?: number }
  rateLimits?: readonly RateLimit[]
  cost?: { usd: number }
}
export type Thresholds = { green: number; yellow: number; warn: number; critical: number }
export type Alert = { kind: string; label: string; pct: number; level: 'warn' | 'critical'; resetsAt?: string }
// What statusline.js decided, printed beside the segments under CCRIG_HOST=mod (see modState there).
// The mod reads it instead of recomputing; an older statusline.js prints none and configFrom fills in.
export type ModState = {
  thresholds: Thresholds
  mode?: string
  autopilot: string
  keepWorking: boolean
  sessionBoard: boolean
  forecast?: { window: string; etaSec: number; safe: boolean; text: string } | null
  resume?: { armed: boolean; window: string; resetsAt: number | null }
  update?: { latest: string | null; hint: string }
}

const BOM = String.fromCharCode(0xfeff)

// CCRig's default 256-color palette, so the fallback line matches the full one
export const COLOR = { dim: 245, model: 111, green: 78, yellow: 214, red: 203 }
export const DEFAULT_THRESHOLDS: Thresholds = { green: 50, yellow: 80, warn: 90, critical: 95 }
const CONTEXT_THRESHOLDS = { green: 50, yellow: 70 }

// ---- color -------------------------------------------------------------------------------------

const BASE16 = ['000000', '800000', '008000', '808000', '000080', '800080', '008080', 'c0c0c0',
  '808080', 'ff0000', '00ff00', 'ffff00', '0000ff', 'ff00ff', '00ffff', 'ffffff']

// an xterm 256-color index as #rrggbb, which the terminal and the Desktop app both draw
export function xterm256(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 255) return '#c0c0c0'
  if (n < 16) return '#' + BASE16[n]
  const hex = (v: number) => v.toString(16).padStart(2, '0')
  if (n < 232) {
    const level = [0, 95, 135, 175, 215, 255]
    const i = n - 16
    return '#' + hex(level[Math.floor(i / 36)]) + hex(level[Math.floor(i / 6) % 6]) + hex(level[i % 6])
  }
  const v = 8 + (n - 232) * 10
  return '#' + hex(v) + hex(v) + hex(v)
}

// ---- ANSI -> spans -----------------------------------------------------------------------------

// CCRig draws with SGR escapes (38;5;N colors, 1 for bold, 0 to reset). A mod draws Text elements
// instead, so turn one escaped string into styled runs. Any other escape or control byte is dropped.
export function ansiToSpans(s: string): Span[] {
  const out: Span[] = []
  let color: string | undefined
  let bold = false
  const push = (raw: string) => {
    const text = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    if (!text) return
    const prev = out[out.length - 1]
    if (prev && prev.color === color && !!prev.bold === bold) { prev.text += text; return }
    const span: Span = { text }
    if (color) span.color = color
    if (bold) span.bold = true
    out.push(span)
  }
  const re = /\x1b\[([0-9;]*)m/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    push(s.slice(last, m.index))
    last = re.lastIndex
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const k = codes[i]
      if (k === 0) { color = undefined; bold = false }
      else if (k === 1) bold = true
      else if (k === 22) bold = false
      else if (k === 39) color = undefined
      else if (k === 38 && codes[i + 1] === 5) { color = xterm256(codes[i + 2]); i += 2 }
      else if (k === 38 && codes[i + 1] === 2) {
        const hex = (v: number) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')
        color = '#' + hex(codes[i + 2]) + hex(codes[i + 3]) + hex(codes[i + 4]); i += 4
      } else if (k >= 30 && k <= 37) color = xterm256(k - 30)
      else if (k >= 90 && k <= 97) color = xterm256(k - 82)
    }
  }
  push(s.slice(last))
  return out
}

export function plainText(s: string): string {
  return ansiToSpans(s).map((x) => x.text).join('')
}

// ---- layout ------------------------------------------------------------------------------------

// Pack segments into lines no wider than `width`, joined by a dim separator, the way the status line
// wraps (a segment never splits, and a line never starts with a separator).
export function packLines(segs: readonly Seg[], width: number, sepWidth = 3): Span[][] {
  const sep: Span = { text: ' │ ', color: xterm256(COLOR.dim) }
  const lines: Span[][] = []
  let cur: Span[] = []
  let curW = 0
  for (const seg of segs) {
    if (!seg.spans.length) continue
    const add = cur.length ? sepWidth + seg.width : seg.width
    if (cur.length && curW + add > width) {
      lines.push(cur)
      cur = [...seg.spans]
      curW = seg.width
    } else {
      if (cur.length) cur.push(sep)
      cur.push(...seg.spans)
      curW += add
    }
  }
  if (cur.length) lines.push(cur)
  return lines
}

// What `node statusline.js` prints under CCRIG_HOST=mod: { v, segments, widths, state }. Null when the
// output is not that, so the caller falls back to the native line instead of drawing garbage. `state`
// is null from a statusline.js older than the contract.
export function parseRigOutput(stdout: string): { segs: Seg[]; state: ModState | null } | null {
  let o: unknown
  try { o = JSON.parse(stdout) } catch { return null }
  if (!o || typeof o !== 'object') return null
  const { segments, widths, state } = o as { segments?: unknown; widths?: unknown; state?: unknown }
  if (!Array.isArray(segments) || !segments.every((x) => typeof x === 'string')) return null
  const segs = segments.map((s: string, i: number) => {
    const w = Array.isArray(widths) && typeof widths[i] === 'number' ? widths[i] : plainText(s).length
    return { spans: ansiToSpans(s), width: w }
  })
  return { segs, state: validState(state) }
}

function validState(x: unknown): ModState | null {
  if (!x || typeof x !== 'object') return null
  const s = x as Record<string, unknown>
  const t = s.thresholds as Record<string, unknown> | undefined
  if (!t || !['green', 'yellow', 'warn', 'critical'].every((k) => typeof t[k] === 'number')) return null
  return {
    thresholds: { green: t.green as number, yellow: t.yellow as number, warn: t.warn as number, critical: t.critical as number },
    mode: typeof s.mode === 'string' ? s.mode : undefined,
    autopilot: typeof s.autopilot === 'string' ? s.autopilot : 'notify',
    keepWorking: s.keepWorking === true,
    sessionBoard: s.sessionBoard === true,
    forecast: s.forecast && typeof s.forecast === 'object' ? (s.forecast as ModState['forecast']) : null,
    resume: s.resume && typeof s.resume === 'object' ? (s.resume as ModState['resume']) : undefined,
    update: s.update && typeof s.update === 'object' ? (s.update as ModState['update']) : undefined,
  }
}

// ---- formatting --------------------------------------------------------------------------------

export function windowLabel(kind: string): string {
  if (kind === 'five_hour') return 'session'
  if (kind === 'seven_day') return 'weekly'
  if (kind === 'spend_limit') return 'spend'
  return kind.replace(/_/g, ' ')
}

// the reset as CCRig's default clock style: 8:53a today, 7/22 6:53a on another day
export function fmtReset(resetsAt: string | undefined, nowMs: number): string {
  if (!resetsAt) return ''
  const t = Date.parse(resetsAt)
  if (!Number.isFinite(t)) return ''
  if (t <= nowMs) return 'now'
  const d = new Date(t)
  const now = new Date(nowMs)
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  let h = d.getHours()
  const ap = h >= 12 ? 'p' : 'a'
  h = h % 12 || 12
  const clock = h + ':' + String(d.getMinutes()).padStart(2, '0') + ap
  return sameDay ? clock : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + clock
}

// "claude-opus-5-5[1m]" reads as "Opus 5.5"; anything else is shown as given, minus the window tag
export function displayModel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/i.exec(model || '')
  if (m) return m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] ? '.' + m[3] : '')
  return String(model || '').replace(/\s*\[1m\]/i, '').replace(/\s*\(1M context\)/i, '').trim()
}

function barSpans(pct: number, width: number, t: { green: number; yellow: number }, redAt: number): Span[] {
  const p = Math.max(0, Math.min(100, pct))
  // the last block is reserved for a true 100%, so a limit bar does not read full at 94%
  const filled = p >= 100 ? width : Math.min(width - 1, Math.floor((p / 100) * width))
  const col = p <= t.green ? COLOR.green : p < redAt ? COLOR.yellow : COLOR.red
  const out: Span[] = []
  if (filled) out.push({ text: '█'.repeat(filled), color: xterm256(col) })
  if (width - filled) out.push({ text: '░'.repeat(width - filled), color: xterm256(COLOR.dim) })
  return out
}

const dim = (text: string): Span => ({ text, color: xterm256(COLOR.dim) })

// the usage windows that still apply (a passed reset means the window has refreshed)
export function liveLimits(usage: Usage | null, nowMs: number): RateLimit[] {
  return (usage?.rateLimits ?? []).filter((r) => {
    if (typeof r.percentUsed !== 'number') return false
    const t = r.resetsAt ? Date.parse(r.resetsAt) : NaN
    return !Number.isFinite(t) || t > nowMs
  })
}

export function usageSeg(r: RateLimit, t: Thresholds, nowMs: number, barWidth = 8): Seg {
  const pct = Math.round(r.percentUsed)
  const near = r.percentUsed >= t.warn
  const label = windowLabel(r.kind)
  const red = xterm256(COLOR.red)
  const spans: Span[] = [
    near ? { text: '⚠ ' + label, color: red, bold: true } : dim(label),
    { text: ' ' },
    ...barSpans(r.percentUsed, barWidth, t, t.warn),
    near ? { text: ' ' + pct + '%', color: red, bold: true } : dim(' ' + pct + '%'),
  ]
  const reset = fmtReset(r.resetsAt, nowMs)
  if (reset) spans.push(dim(' ↺' + reset))
  return { spans, width: spans.reduce((n, s) => n + s.text.length, 0) }
}

// The line drawn when the full CCRig render is not available (no Node on PATH, or the Desktop app,
// where a mod cannot start processes): model, context, the usage windows and cost, from Claude Code's
// own figures.
export function nativeSegments(model: string, usage: Usage | null, t: Thresholds, nowMs: number): Seg[] {
  const segs: Seg[] = []
  const name = displayModel(model)
  if (name) {
    const oneM = (usage?.context?.window ?? 0) >= 1000000
    const spans: Span[] = [dim('★ '), { text: name, color: xterm256(COLOR.model) }]
    if (oneM) spans.push(dim(' [1m]'))
    segs.push({ spans, width: spans.reduce((n, s) => n + s.text.length, 0) })
  }
  const pct = usage?.context?.percent
  if (typeof pct === 'number') {
    const spans = [dim('ctx '), ...barSpans(pct, 10, CONTEXT_THRESHOLDS, CONTEXT_THRESHOLDS.yellow), dim(' ' + Math.round(pct) + '%')]
    segs.push({ spans, width: spans.reduce((n, s) => n + s.text.length, 0) })
  }
  for (const r of liveLimits(usage, nowMs)) segs.push(usageSeg(r, t, nowMs))
  if (usage?.cost && typeof usage.cost.usd === 'number') {
    segs.push({ spans: [dim('$' + usage.cost.usd.toFixed(2))], width: ('$' + usage.cost.usd.toFixed(2)).length })
  }
  return segs
}

// one plain line for /ccrig with no arguments
export function summaryLine(model: string, usage: Usage | null, nowMs: number): string {
  const parts: string[] = []
  const name = displayModel(model)
  if (name) parts.push(name)
  const pct = usage?.context?.percent
  if (typeof pct === 'number') parts.push('ctx ' + Math.round(pct) + '%')
  for (const r of liveLimits(usage, nowMs)) {
    const reset = fmtReset(r.resetsAt, nowMs)
    parts.push(windowLabel(r.kind) + ' ' + Math.round(r.percentUsed) + '%' + (reset ? ' (resets ' + reset + ')' : ''))
  }
  if (usage?.cost && typeof usage.cost.usd === 'number') parts.push('$' + usage.cost.usd.toFixed(2))
  if (!liveLimits(usage, nowMs).length) parts.push('no plan usage yet (it appears after the first reply on a Pro or Max plan)')
  return parts.join(' · ')
}

// ---- thresholds and alerts ---------------------------------------------------------------------

// The fallback when no render has printed `state` yet (no Node, the Desktop app, or an older
// statusline.js): CCRig's own config file, read the way statusline.js reads it, with its defaults.
export function configFrom(configText: string | null | undefined): ModState {
  const out: ModState = { thresholds: { ...DEFAULT_THRESHOLDS }, autopilot: 'notify', keepWorking: false, sessionBoard: false }
  if (!configText) return out
  let cfg: Record<string, unknown> | null = null
  try { cfg = JSON.parse(configText.split(BOM).join('')) } catch { return out }
  if (!cfg || typeof cfg !== 'object') return out
  const u = (cfg.thresholds as { usage?: Record<string, unknown> } | undefined)?.usage
  if (u && typeof u === 'object') {
    for (const k of ['green', 'yellow', 'warn', 'critical'] as const) {
      const v = Number(u[k])
      if (Number.isFinite(v) && v > 0 && v <= 100) out.thresholds[k] = v
    }
  }
  if (cfg.autopilot === 'off' || cfg.autopilot === 'notify' || cfg.autopilot === 'resume') out.autopilot = cfg.autopilot
  out.keepWorking = !!cfg.keepWorking
  out.sessionBoard = cfg.sessionBoard === true
  if (typeof cfg.mode === 'string') out.mode = cfg.mode
  return out
}

export function thresholdsFrom(configText: string | null | undefined): Thresholds {
  return configFrom(configText).thresholds
}

// the window most in need of attention, or null while every window is under the warn line
export function alertFor(usage: Usage | null, t: Thresholds, nowMs: number): Alert | null {
  let best: Alert | null = null
  for (const r of liveLimits(usage, nowMs)) {
    if (r.percentUsed < t.warn) continue
    if (best && r.percentUsed <= best.pct) continue
    best = {
      kind: r.kind,
      label: windowLabel(r.kind),
      pct: r.percentUsed,
      level: r.percentUsed >= Math.max(t.critical, t.warn) ? 'critical' : 'warn',
      resetsAt: r.resetsAt,
    }
  }
  return best
}

// a key that changes when an alert gets worse, so hiding one alert does not hide the next
export function alertKey(a: Alert): string {
  return a.kind + ':' + a.level + ':' + (a.resetsAt ?? '')
}

// the thresholds a window just crossed, comparing the last reading with this one
export function crossings(prev: Record<string, number>, usage: Usage | null, t: Thresholds, nowMs: number): Alert[] {
  const out: Alert[] = []
  for (const r of liveLimits(usage, nowMs)) {
    const before = prev[r.kind] ?? 0
    for (const [level, at] of [['critical', t.critical], ['warn', t.warn]] as const) {
      if (before < at && r.percentUsed >= at) {
        out.push({ kind: r.kind, label: windowLabel(r.kind), pct: r.percentUsed, level, resetsAt: r.resetsAt })
        break
      }
    }
  }
  return out
}

export function resumeCommand(sessionId: string): string {
  return /^[A-Za-z0-9-]+$/.test(sessionId) ? 'claude --resume ' + sessionId : 'claude --continue'
}

// ---- settings and hooks ------------------------------------------------------------------------

type HookEntry = { hooks?: { command?: unknown; args?: unknown }[] }
const OURS = /statusline\.js|\bccrig\b/i
type SettingsShape = { statusLine?: { command?: unknown }; hooks?: Record<string, HookEntry[] | undefined> }

// A hook is shell form (one command string) or exec form (an executable plus `args`, which CCRig uses
// on Windows so its hooks never start Git Bash). Read both as one line: the executable first.
function hookLine(h: { command?: unknown; args?: unknown } | null | undefined): string {
  if (!h || typeof h.command !== 'string') return ''
  if (!Array.isArray(h.args)) return h.command
  const q = (t: unknown) => (/\s/.test(String(t)) ? '"' + String(t) + '"' : String(t))
  return [h.command, ...h.args].map(q).join(' ')
}

function ourHookCommands(s: SettingsShape): string[] {
  const out: string[] = []
  for (const entries of Object.values(s.hooks ?? {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      for (const h of Array.isArray(entry?.hooks) ? entry.hooks : []) {
        const line = hookLine(h)
        if (line && OURS.test(line)) out.push(line)
      }
    }
  }
  return out
}

// What `ccrig init` (npm or standalone) already wired: the status line, and each CCRig hook by its
// --hook slug (stop, board-stop, session-start, pre-compact, user-prompt, notification, session-end).
// The mod runs a slug only when settings.json does not, so no hook ever runs twice.
export function detectWiring(settings: unknown): { statusLine: boolean; hooks: string[] } {
  const s = (settings && typeof settings === 'object' ? settings : {}) as SettingsShape
  const statusLine = typeof s.statusLine?.command === 'string' && OURS.test(s.statusLine.command)
  const hooks = new Set<string>()
  for (const cmd of ourHookCommands(s)) {
    const m = /--hook\s+([a-z-]+)/.exec(cmd)
    if (m) hooks.add(m[1])
  }
  return { statusLine, hooks: [...hooks].sort() }
}

// The node a wired CCRig command already runs with: `ccrig init` pins an absolute node path because a
// Claude Code started from a GUI may not have the shell's PATH. Null when nothing CCRig is wired.
export function nodeFromSettings(settings: unknown): string | null {
  const s = (settings && typeof settings === 'object' ? settings : {}) as SettingsShape
  const cmds: string[] = []
  if (typeof s.statusLine?.command === 'string' && OURS.test(s.statusLine.command)) cmds.push(s.statusLine.command)
  cmds.push(...ourHookCommands(s))
  for (const cmd of cmds) {
    const t = cmd.trim()
    const first = t.startsWith('"') ? t.slice(1, t.indexOf('"', 1)) : t.split(/\s+/)[0]
    if (first && /(^|[\\/])node(\.exe)?$/i.test(first)) return first
  }
  return null
}

// The status-line JSON Claude Code would hand CCRig, built from what a mod can read. Feeding it to
// statusline.js keeps one renderer, and its guardian, for both installs.
export function statusInput(d: {
  sessionId: string
  transcriptPath: string
  cwd: string
  projectDir: string
  model: string
  version: string
  effort: string
  sessionName: string
  usage: Usage | null
}): Record<string, unknown> {
  const rate: Record<string, { used_percentage: number; resets_at?: number }> = {}
  for (const r of d.usage?.rateLimits ?? []) {
    if (r.kind !== 'five_hour' && r.kind !== 'seven_day') continue
    if (typeof r.percentUsed !== 'number') continue
    const t = r.resetsAt ? Date.parse(r.resetsAt) : NaN
    rate[r.kind] = Number.isFinite(t)
      ? { used_percentage: r.percentUsed, resets_at: Math.floor(t / 1000) }
      : { used_percentage: r.percentUsed }
  }
  const input: Record<string, unknown> = {
    session_id: d.sessionId,
    cwd: d.cwd,
    workspace: { current_dir: d.cwd, project_dir: d.projectDir || d.cwd },
    model: { id: d.model, display_name: displayModel(d.model) },
    version: d.version,
    rate_limits: rate,
  }
  if (d.transcriptPath) input.transcript_path = d.transcriptPath
  if (d.effort) input.effort = { level: d.effort }
  if (d.sessionName) input.session_name = d.sessionName
  const ctx = d.usage?.context
  if (ctx && typeof ctx.window === 'number') {
    const cw: Record<string, number> = { context_window_size: ctx.window }
    if (typeof ctx.percent === 'number') cw.used_percentage = ctx.percent
    if (typeof ctx.tokens === 'number') cw.total_input_tokens = ctx.tokens
    input.context_window = cw
  }
  if (d.usage?.cost && typeof d.usage.cost.usd === 'number') input.cost = { total_cost_usd: d.usage.cost.usd }
  return input
}

// A settings hook answers in JSON on stdout; a mod's classic.* hook answers with ClassicResult.
// Translate the two fields CCRig's hooks use, and keep what earlier hooks already decided.
export function classicResult(stdout: string, base: Record<string, unknown> = {}): Record<string, unknown> {
  let o: { decision?: unknown; reason?: unknown; hookSpecificOutput?: { additionalContext?: unknown } } | null = null
  try { o = stdout.trim() ? JSON.parse(stdout) : null } catch { o = null }
  if (!o || typeof o !== 'object') return base
  const out: Record<string, unknown> = { ...base }
  if (o.decision === 'block' && typeof o.reason === 'string' && !out.block) out.block = o.reason
  const ctx = o.hookSpecificOutput?.additionalContext
  if (typeof ctx === 'string' && ctx) {
    const prev = Array.isArray(base.additionalContext) ? base.additionalContext : []
    out.additionalContext = [...prev, ctx]
  }
  return out
}

// ---- /ccrig ------------------------------------------------------------------------------------

// The CLI commands /ccrig passes through to statusline.js, each with the exact arguments it takes.
// Install, update and the interactive editor are left out: /plugin installs and updates the mod, and a
// mod cannot drive a TTY menu. No token starting with "-" ever reaches the CLI, so text typed after
// /ccrig can never become a flag such as --watch or --hook.
const BARE = new Set(['status', 'doctor', 'sessions', 'version', 'whatsnew', 'options', 'check-update', 'disarm', 'collapse', 'expand', 'toggle'])
const CHOICES: Record<string, readonly string[]> = {
  mode: ['minimal', 'normal', 'expanded'],
  autopilot: ['off', 'notify', 'resume'],
  'keep-working': ['on', 'off'],
}
export const USAGE: Record<string, string> = {
  mode: 'usage: /ccrig mode <minimal|normal|expanded>',
  autopilot: 'usage: /ccrig autopilot <off|notify|resume>',
  'keep-working': 'usage: /ccrig keep-working <on|off>',
  name: 'usage: /ccrig name <label>  (up to 18 characters)',
}

export function cliArgs(sub: string, rest: readonly string[]): { argv: string[] } | { error: string } {
  if (BARE.has(sub)) return rest.length ? { error: 'usage: /ccrig ' + sub + '  (it takes no arguments)' } : { argv: [sub] }
  if (CHOICES[sub]) {
    return rest.length === 1 && CHOICES[sub].includes(rest[0]) ? { argv: [sub, rest[0]] } : { error: USAGE[sub] }
  }
  if (sub === 'name') {
    const label = rest.join(' ')
    if (!rest.length || rest.some((t) => t.startsWith('-')) || label.length > 18) return { error: USAGE.name }
    return { argv: ['name', ...rest] }
  }
  return { error: 'No /ccrig ' + sub + '.' }
}

// the commands that change what the bar shows, so the band redraws after them
export const CHANGES_BAR = new Set(['mode', 'autopilot', 'keep-working', 'name', 'collapse', 'expand', 'toggle'])

export function splitArgs(args: string): string[] {
  return String(args || '').trim().split(/\s+/).filter(Boolean)
}

export const HELP = [
  '/ccrig                 one line: model, context, plan usage, cost',
  '/ccrig usage           a pane with the usage bars, reset times and the pace forecast',
  '/ccrig board           a pane with every session as a traffic light (needs "sessionBoard": true)',
  '/ccrig mode <m>        minimal | normal | expanded',
  '/ccrig collapse        fold the bar to one line (expand, toggle to open it again)',
  '/ccrig autopilot <m>   off | notify | resume',
  '/ccrig keep-working <on|off>, name <label>, status, sessions, doctor, options, whatsnew, version, check-update, disarm',
  'The band above the prompt, the spinner readout and the toasts are set in /config (the ccrig rows).',
].join('\n')
