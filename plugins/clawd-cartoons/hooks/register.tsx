import type { EngineInterface, Register } from 'claude-code'

import { SYSTEM, THINKING, buildPrompt, describeTool, type Activity, type Panel } from './prompt'
import { SceneRunner, parseReply, tryScene, type Scene } from './scene'

const FRAME_MS = 50 // 20 frames a second
const DEBOUNCE_MS = 1200 // a burst of steps asks once
const BACKOFF_MIN_MS = 30_000
const BACKOFF_MAX_MS = 10 * 60_000
const STORY = 4 // panels of the story so far sent with each request

type Timer = { cancel: () => void }

const cfg = {
  model: 'claude-sonnet-5-5',
  minGapMs: 10_000,
  rows: 8,
  maxTokens: 16000,
  effort: 'low' as 'low' | 'medium' | 'high',
}

// Shown the moment a turn starts, before the first panel arrives: Clawd
// strolling, saying what the agent is doing. A fresh copy each turn, as a
// kept line rewrites the scene's bubble.
const house = (): Scene => ({
  caption: '',
  ground: { color: '#3a3a52', glyph: '▁' },
  particles: [{ glyph: '·', color: '#3a3a58', count: 20, vx: -2, vy: 0 }],
  actors: [{ clawd: true, x: 2, vx: 6, wrap: false }],
  say: { text: '{doing}', x: 18, y: 0 },
})

// The module's own state; a reload starts it over
let enabled = true
let turnActive = false
let activity: Activity = THINKING
let recent: string[] = []
let userPrompt = ''
let said: string | undefined
let result: { text: string; failed: boolean } | undefined
let story: Panel[] = []
let scene: Scene | undefined
let isHouse = false
let runner: SceneRunner | undefined
let sceneTime = 0
let columnsSeen = 78
let lastError: string | undefined
let inFlight = false
let dirty = false // something happened since the last request was sent
let lastRequestAt = -Infinity
let backoffMs = 0
let pending: Timer | undefined
let tick: Timer | undefined
const mounted = new Set<string>()
const stats = { requests: 0, failures: 0, kept: 0, inputTokens: 0, outputTokens: 0 }

function show($: EngineInterface, next: Scene | undefined) {
  const wasShown = !!scene
  scene = next
  runner = undefined
  sceneTime = 0
  // The spinner draws a Raster only while there is a scene, so showing the
  // first one (or dropping the last) is a redraw; swapping scenes is a blit
  if (wasShown !== !!scene) $.ui.invalidate('ui.render')
}

const backoff = () => (backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs ? backoffMs * 2 : BACKOFF_MIN_MS))

async function request($: EngineInterface) {
  pending = undefined
  if (!enabled || !turnActive || inFlight || !dirty) return
  let columns = columnsSeen
  let doing = activity.text
  try {
    let r
    try {
      const now = await $.clock.now()
      const wait = lastRequestAt + Math.max(cfg.minGapMs, backoffMs) - now
      if (wait > 0) {
        pending = $.clock.after(wait, () => void request($))
        return
      }
      inFlight = true
      dirty = false
      lastRequestAt = now
      stats.requests++
      columns = columnsSeen
      doing = activity.text
      r = await $.model.complete({
        model: cfg.model,
        system: SYSTEM,
        prompt: buildPrompt({
          columns,
          rows: cfg.rows,
          doing,
          said,
          result,
          recent,
          story,
          onScreen: scene && !isHouse ? scene.caption || 'a scene' : undefined,
          userPrompt,
          lastError,
        }),
        maxTokens: cfg.maxTokens,
        effort: cfg.effort,
        timeoutMs: 120_000,
      })
    } catch {
      stats.failures++
      backoff()
      return
    }
    if (!r.isAnswered) {
      stats.failures++
      if (r.reason === 'api-error') backoff()
      return
    }
    backoffMs = 0
    const u = r.usage
    stats.inputTokens += u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    stats.outputTokens += u.output_tokens
    if (!enabled || !turnActive) return
    try {
      const parsed = parseReply(r.text)
      if (parsed.keep && scene) {
        // Same drawing, new line; the bubble types it out again
        stats.kept++
        scene.say = parsed.keep
        story = [...story, { caption: scene.caption, line: parsed.keep.text }].slice(-STORY)
        return
      }
      const error = parsed.error ?? (parsed.scene ? tryScene(parsed.scene, columns, cfg.rows, doing) : 'a keep reply with nothing on screen')
      if (error) {
        // Sent back with the next request so the model can fix it
        stats.failures++
        lastError = error
        return
      }
      lastError = undefined
      const next = parsed.scene!
      story = [...story, { caption: next.caption, line: next.say?.text.replaceAll('{doing}', doing) ?? '' }].slice(-STORY)
      isHouse = false
      show($, next)
    } catch (e) {
      stats.failures++
      lastError = e instanceof Error ? e.message : String(e)
    }
  } finally {
    inFlight = false
    // Steps that came in while this one was drawn get the next panel
    if (dirty) schedule($)
  }
}

function schedule($: EngineInterface) {
  if (pending || !enabled || !turnActive) return
  pending = $.clock.after(DEBOUNCE_MS, () => void request($))
}

// Something new happened: a tool call, or the agent said something
function changed($: EngineInterface) {
  dirty = true
  schedule($)
}

function observe($: EngineInterface, next: Activity) {
  if (next.text !== activity.text) recent = [activity.text, ...recent].slice(0, 6)
  activity = next
  changed($)
}

function cancelPending() {
  pending?.cancel()
  pending = undefined
}

// A tool's output as one line: its start and its end, where summaries are
const gist = (s: string) => {
  const v = s.replace(/\s+/g, ' ').trim()
  return v.length > 320 ? `${v.slice(0, 150)} … ${v.slice(-150)}` : v
}

async function frame($: EngineInterface) {
  if (!runner || !mounted.size) return
  sceneTime += FRAME_MS / 1000
  const cells = runner.draw(sceneTime, activity.text).base64()
  // The program broke after it was shown: say why with the next request
  if (runner.error && runner.error !== lastError) lastError = runner.error
  for (const id of mounted) {
    const r = await $.ui.blit({ requestId: id, key: 'cartoon', cells })
    if (r && 'deny' in r && r.deny) mounted.delete(id)
  }
}

export const register: Register = (on, options) => {
  cfg.model = String(options.model || 'claude-sonnet-5-5')
  cfg.minGapMs = Number(options.min_seconds_between_requests ?? 10) * 1000
  cfg.rows = Math.max(4, Math.min(16, Number(options.scene_rows ?? 8)))
  cfg.maxTokens = Math.max(1024, Math.min(64000, Number(options.max_reply_tokens ?? 16000)))
  cfg.effort = options.effort === 'medium' || options.effort === 'high' ? options.effort : 'low'
  enabled = options.enabled !== false

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'cartoons',
        description: 'Clawd cartoons in the spinner: status, on, or off',
        argumentHint: '[on|off]',
        immediate: true,
      })
    } catch {
      // Another plugin holds the name; the cartoons still draw
    }
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    userPrompt = e.text
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    turnActive = true
    if (e.text) userPrompt = e.text
    recent = []
    story = []
    said = undefined
    result = undefined
    activity = THINKING
    tick ??= $.clock.every(FRAME_MS, () => void frame($))
    if (enabled) {
      isHouse = true
      show($, house())
    }
    changed($)
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    turnActive = false
    cancelPending()
    tick?.cancel()
    tick = undefined
    mounted.clear()
    return next(e)
  })

  on('session.append', { door: 'response' }, ($, e, next) => {
    // The main agent's own words: what it found, what it will do next
    if (!e.agentId) {
      const text = e.message.content.flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join(' ').trim()
      if (text) {
        said = text
        changed($)
      }
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    observe($, describeTool(e.tool, e as unknown as Record<string, unknown>))
    const r = await next(e)
    if (typeof r.text === 'string') result = { text: gist(r.text), failed: !!r.isError }
    return r
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!enabled || !scene || e.surface !== 'terminal') return next(e)
    const columns = (columnsSeen = Math.max(20, Math.min(512, (e.viewport?.columns ?? 80) - 2)))
    if (!runner || runner.canvas.w !== columns || runner.scene !== scene) runner = new SceneRunner(scene, columns, cfg.rows)
    mounted.add(e.requestId)
    const { Box, Raster } = $.ui.resolve(e)
    const cells = runner.draw(sceneTime, activity.text).base64()
    const spinner = await next(e)
    return (
      <Box flexDirection="column">
        {spinner}
        <Raster key="cartoon" columns={columns} rows={cfg.rows} cells={cells} />
      </Box>
    )
  })

  on('command.run', { command: 'cartoons' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      enabled = false
      cancelPending()
      show($, undefined)
      return { text: 'Cartoons off for this session. `/cartoons on` brings them back; to turn them off for good, set "Draw cartoons" off in /plugin.' }
    }
    if (arg === 'on') {
      enabled = true
      if (turnActive) {
        isHouse = true
        show($, house())
        changed($)
      }
      return { text: 'Cartoons on.' }
    }
    return {
      text: [
        `Cartoons are ${enabled ? 'on' : 'off'}, drawn by ${cfg.model}.`,
        `This session: ${stats.requests} requests (${stats.failures} failed, ${stats.kept} kept the scene and changed the line), ${stats.inputTokens} input and ${stats.outputTokens} output tokens.`,
        lastError ? `Last error: ${lastError}` : '',
      ].filter(Boolean).join('\n'),
    }
  })
}
