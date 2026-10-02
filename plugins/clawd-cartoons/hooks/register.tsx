import type { EngineInterface, Register } from 'claude-code'

import { SYSTEM, THINKING, buildPrompt, describeTool, type Activity } from './prompt'
import { SceneRunner, parseReply, tryScene, type Scene } from './scene'

const STORE_KEY = 'scenes'
const MAX_CACHED = 40 // scenes kept across all kinds of work
const FRAME_MS = 50 // 20 frames a second
const DEBOUNCE_MS = 1500 // a burst of tool calls asks once
const BACKOFF_MIN_MS = 30_000
const BACKOFF_MAX_MS = 10 * 60_000

type Cache = Record<string, Scene[]>
type Timer = { cancel: () => void }

const cfg = {
  model: 'claude-sonnet-5-5',
  minGapMs: 20_000,
  rows: 8,
  variety: 3,
  maxTokens: 16000,
  effort: 'low' as 'low' | 'medium' | 'high',
}

// The module's own state; a reload starts it over, and the saved scenes come
// back from $.store at session.start
let enabled = true
let turnActive = false
let activity: Activity = THINKING
let recent: string[] = []
let userPrompt = ''
let cache: Cache = {}
let scene: Scene | undefined
let runner: SceneRunner | undefined
let sceneTime = 0
let columnsSeen = 78
let lastError: string | undefined
let inFlight = false
let lastRequestAt = -Infinity
let backoffMs = 0
let pending: Timer | undefined
let tick: Timer | undefined
const mounted = new Set<string>()
const stats = { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, reused: 0 }

function save($: EngineInterface) {
  void $.store.set(STORE_KEY, cache).catch(() => {})
}

function show($: EngineInterface, next: Scene | undefined) {
  const wasShown = !!scene
  scene = next
  runner = undefined
  sceneTime = 0
  // The spinner draws a Raster only while there is a scene, so showing the
  // first one (or dropping the last) is a redraw; swapping scenes is a blit
  if (wasShown !== !!scene) $.ui.invalidate('ui.render')
}

// A saved scene for this kind of work, preferring one not on screen now
function pickCached(kind: string): Scene | undefined {
  const list = cache[kind] ?? []
  const others = list.filter((s) => s !== scene)
  const pool = others.length ? others : list
  return pool[Math.floor(Math.random() * pool.length)]
}

function remember($: EngineInterface, kind: string, s: Scene) {
  const list = (cache[kind] ??= [])
  list.push(s)
  list.splice(0, Math.max(0, list.length - cfg.variety))
  // Over the cap, drop the oldest scene of the largest kind
  for (let total = Object.values(cache).flat().length; total > MAX_CACHED; total--) {
    Object.values(cache).sort((a, b) => b.length - a.length)[0]!.shift()
  }
  save($)
}

function forget($: EngineInterface, s: Scene) {
  for (const k of Object.keys(cache)) cache[k] = cache[k]!.filter((x) => x !== s)
  save($)
}

async function request($: EngineInterface) {
  pending = undefined
  const kind = activity.kind
  if (!enabled || !turnActive || inFlight || (cache[kind]?.length ?? 0) >= cfg.variety) return
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
      lastRequestAt = now
      stats.requests++
      columns = columnsSeen
      doing = activity.text
      r = await $.model.complete({
        model: cfg.model,
        system: SYSTEM,
        prompt: buildPrompt({ columns, rows: cfg.rows, doing, recent, userPrompt, lastError, previousCaption: scene?.caption }),
        maxTokens: cfg.maxTokens,
        effort: cfg.effort,
        timeoutMs: 120_000,
      })
    } catch {
      stats.failures++
      backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs ? backoffMs * 2 : BACKOFF_MIN_MS)
      return
    }
    if (!r.isAnswered) {
      stats.failures++
      if (r.reason === 'api-error') backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs ? backoffMs * 2 : BACKOFF_MIN_MS)
      return
    }
    backoffMs = 0
    const u = r.usage
    stats.inputTokens += u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    stats.outputTokens += u.output_tokens
    try {
      const parsed = parseReply(r.text)
      const error = parsed.error ?? tryScene(parsed.scene!, columns, cfg.rows, doing)
      if (error) {
        // Sent back with the next request so the model can fix it
        stats.failures++
        lastError = error
        return
      }
      lastError = undefined
      remember($, kind, parsed.scene!)
      if (enabled && activity.kind === kind) show($, parsed.scene)
    } catch (e) {
      stats.failures++
      lastError = e instanceof Error ? e.message : String(e)
    }
  } finally {
    inFlight = false
  }
}

function schedule($: EngineInterface) {
  if (pending || !enabled || !turnActive) return
  pending = $.clock.after(DEBOUNCE_MS, () => void request($))
}

function observe($: EngineInterface, next: Activity) {
  if (next.kind !== activity.kind) {
    recent = [activity.text, ...recent].slice(0, 8)
    const cached = enabled ? pickCached(next.kind) : undefined
    if (cached) {
      stats.reused++
      show($, cached)
    }
  }
  activity = next
  schedule($)
}

function cancelPending() {
  pending?.cancel()
  pending = undefined
}

async function frame($: EngineInterface) {
  if (!runner || !mounted.size) return
  sceneTime += FRAME_MS / 1000
  const cells = runner.draw(sceneTime, activity.text).base64()
  if (runner.error && runner.error !== lastError) {
    // The program broke after it was shown: stop reusing it, and say why next time
    lastError = runner.error
    forget($, runner.scene)
  }
  for (const id of mounted) {
    const r = await $.ui.blit({ requestId: id, key: 'cartoon', cells })
    if (r && 'deny' in r && r.deny) mounted.delete(id)
  }
}

export const register: Register = (on, options) => {
  cfg.model = String(options.model || 'claude-sonnet-5-5')
  cfg.minGapMs = Number(options.min_seconds_between_requests ?? 20) * 1000
  cfg.rows = Math.max(4, Math.min(16, Number(options.scene_rows ?? 8)))
  cfg.variety = Math.max(1, Number(options.scenes_per_activity ?? 3))
  cfg.maxTokens = Math.max(1024, Math.min(64000, Number(options.max_reply_tokens ?? 16000)))
  cfg.effort = options.effort === 'medium' || options.effort === 'high' ? options.effort : 'low'
  enabled = options.enabled !== false

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'cartoons',
        description: 'Clawd cartoons in the spinner: status, on, off, or clear',
        argumentHint: '[on|off|clear]',
        immediate: true,
      })
    } catch {
      // Another plugin holds the name; the cartoons still draw
    }
    const stored = await $.store.get(STORE_KEY).catch(() => undefined)
    if (stored && typeof stored === 'object') {
      cache = {}
      for (const [k, list] of Object.entries(stored as Cache)) {
        // Saved by an older version, or edited by hand: parse it again like a reply
        if (Array.isArray(list)) cache[k] = list.map((s) => parseReply(JSON.stringify(s)).scene).filter((s): s is Scene => !!s)
      }
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
    tick ??= $.clock.every(FRAME_MS, () => void frame($))
    observe($, THINKING)
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

  on('tool.call', ($, e, next) => {
    observe($, describeTool(e.tool, e as unknown as Record<string, unknown>))
    return next(e)
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
      show($, pickCached(activity.kind))
      schedule($)
      return { text: 'Cartoons on.' }
    }
    if (arg === 'clear') {
      cache = {}
      await $.store.delete(STORE_KEY).catch(() => {})
      show($, undefined)
      return { text: 'Forgot every saved cartoon; new ones will be drawn as you work.' }
    }
    const saved = Object.values(cache).flat().length
    return {
      text: [
        `Cartoons are ${enabled ? 'on' : 'off'}, drawn by ${cfg.model}.`,
        `This session: ${stats.requests} requests (${stats.failures} failed), ${stats.inputTokens} input and ${stats.outputTokens} output tokens, ${stats.reused} saved scenes reused.`,
        `${saved} scenes saved across ${Object.keys(cache).length} kinds of work.`,
        lastError ? `Last error: ${lastError}` : '',
      ].filter(Boolean).join('\n'),
    }
  })
}
