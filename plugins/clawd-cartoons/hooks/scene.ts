// A scene is what the model sends back: a few declarative layers (sky,
// ground, particles, sliding actors and props, Clawd's speech bubble) and,
// when the idea is more than sliding, a program in the scene language that
// paints between the background and the actors.

import { Canvas, CLAWD_H, CLAWD_W, color, hsl, mix, noise, noise2, rgb, seeded, smoothstep } from './canvas'
import { Machine, SceneError } from './lang'

export type Particle = { glyph: string; color: string | number; count: number; vx: number; vy: number }
export type Actor = {
  art?: string
  pix?: string[]
  palette?: Record<string, string | number>
  label?: string
  clawd?: boolean
  x: number
  y?: number
  vx: number
  color?: string | number
  wrap: boolean
}
export type Scene = {
  caption: string
  sky?: [string | number, string | number]
  ground?: { color: string | number; glyph: string }
  particles: Particle[]
  actors: Actor[]
  say?: { text: string; x: number; y: number }
  code?: string
}

export const MAX_CODE = 12_000
const SAY_CPS = 35 // speech bubble typing speed, characters per second

const num = (v: unknown, d: number, lo = -1e4, hi = 1e4) => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d
}
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined)
const col = (v: unknown): string | number | undefined => {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined
  try {
    color(v)
    return v
  } catch {
    return undefined
  }
}

// Pulls a scene out of the model's reply: a ```json block (or the outermost
// braces) and an optional ```js block for the code. {"keep": true, "say": ...}
// keeps the scene on screen and only changes what Clawd says.
export function parseReply(text: string): { scene?: Scene; keep?: Scene['say']; error?: string } {
  const fence = (lang: string) => new RegExp('```' + lang + '\\s*\\n([\\s\\S]*?)```', 'i').exec(text)?.[1]
  let raw: any = {}
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  const jsonText = fence('json') ?? (start < 0 ? '' : text.slice(start, end > start ? end + 1 : undefined))
  const codeFence = fence('(?:js|javascript)')
  if (jsonText) {
    try {
      raw = JSON.parse(jsonText)
    } catch (e) {
      if (!codeFence) return { error: `the scene JSON did not parse: ${(e as Error).message}` }
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) raw = {}
  const scene = normalize(raw)
  if (raw.keep === true && !codeFence) return scene.say ? { keep: scene.say } : { error: 'a keep reply needs "say"' }
  const code = codeFence ?? str(raw.code, MAX_CODE + 1)
  if (code?.trim()) {
    if (code.length > MAX_CODE) return { error: `the code is ${code.length} characters; keep it under ${MAX_CODE}` }
    scene.code = code
  }
  if (!scene.sky && !scene.ground && !scene.particles.length && !scene.actors.length && !scene.say && !scene.code) {
    return { error: 'the reply had nothing to draw: send the scene JSON (and code) as described' }
  }
  return { scene }
}

function normalize(raw: any): Scene {
  const scene: Scene = { caption: str(raw.caption, 80) ?? '', particles: [], actors: [] }
  if (Array.isArray(raw.sky)) {
    const top = col(raw.sky[0]), bottom = col(raw.sky[1] ?? raw.sky[0])
    if (top !== undefined && bottom !== undefined) scene.sky = [top, bottom]
  } else if (col(raw.sky) !== undefined) {
    scene.sky = [raw.sky, raw.sky]
  }
  if (raw.ground && typeof raw.ground === 'object') {
    scene.ground = { color: col(raw.ground.color) ?? '#6b5a4a', glyph: str(raw.ground.glyph, 4) || '▔' }
  }
  for (const p of Array.isArray(raw.particles) ? raw.particles.slice(0, 6) : []) {
    if (!p || typeof p !== 'object') continue
    scene.particles.push({
      glyph: str(p.glyph, 8) || '·',
      color: col(p.color) ?? '#ffffff',
      count: Math.floor(num(p.count, 12, 0, 200)),
      vx: num(p.vx, 0, -60, 60),
      vy: num(p.vy, 0, -30, 30),
    })
  }
  for (const a of Array.isArray(raw.actors) ? raw.actors.slice(0, 8) : []) {
    if (!a || typeof a !== 'object') continue
    const art = str(a.art, 400)
    const pix = Array.isArray(a.pix) ? a.pix.slice(0, 32).map((r: unknown) => String(r).slice(0, 80)) : undefined
    if (!a.clawd && !art && !pix?.length) continue
    const palette: Record<string, string | number> = {}
    if (a.palette && typeof a.palette === 'object') {
      for (const [k, v] of Object.entries(a.palette).slice(0, 16)) {
        const c = col(v)
        if (k.length === 1 && c !== undefined) palette[k] = c
      }
    }
    scene.actors.push({
      art: a.clawd || pix?.length ? undefined : art,
      pix: a.clawd ? undefined : pix,
      palette: pix ? palette : undefined,
      label: str(a.label, 40),
      clawd: !!a.clawd,
      x: num(a.x, 0),
      y: a.y === undefined ? undefined : num(a.y, 0),
      vx: num(a.vx, 0, -80, 80),
      color: col(a.color),
      wrap: a.wrap !== false,
    })
  }
  if (raw.say && typeof raw.say === 'object' && str(raw.say.text, 200)) {
    scene.say = { text: raw.say.text.slice(0, 200), x: num(raw.say.x, 2), y: num(raw.say.y, 0) }
  } else if (typeof raw.say === 'string' && raw.say) {
    scene.say = { text: raw.say.slice(0, 200), x: 2, y: 0 }
  }
  return scene
}

// Draws one scene frame after frame; a program that fails is switched off
// and its error kept to send back with the next request
export class SceneRunner {
  readonly canvas: Canvas
  readonly scene: Scene
  error?: string
  private machine?: Machine
  private frames = 0
  private said?: string
  private saidAt = 0
  private readonly stars: { x: number; y: number }[][]

  constructor(scene: Scene, w: number, h: number) {
    this.scene = scene
    this.canvas = new Canvas(w, h)
    this.stars = scene.particles.map((p, i) => {
      const r = seeded(i * 7919 + p.count)
      return Array.from({ length: p.count }, () => ({ x: r() * w, y: r() * h }))
    })
    if (scene.code) {
      try {
        this.machine = new Machine(scene.code, this.globals())
        this.machine.setup()
      } catch (e) {
        this.fail(e)
      }
    }
  }

  private fail(e: unknown) {
    this.machine = undefined
    this.error = e instanceof SceneError ? e.message : `the program failed: ${e instanceof Error ? e.message : String(e)}`
  }

  private globals(): Record<string, unknown> {
    const c = this.canvas
    const charge = (n: number) => this.machine?.charge(n)
    const r = seeded(1)
    return {
      W: c.w,
      H: c.h,
      t: 0,
      frame: 0,
      doing: '',
      put: (x: number, y: number, ch: unknown, fg?: unknown, bg?: unknown) => c.put(x, y, ch, fg, bg),
      text: (x: number, y: number, s: unknown, fg?: unknown, bg?: unknown) => {
        charge(String(s).length)
        c.text(x, y, s, fg, bg)
      },
      sprite: (x: number, y: number, art: unknown, fg?: unknown, bg?: unknown) => {
        charge(String(art).length)
        c.sprite(x, y, art, fg, bg)
      },
      fill: (x: number, y: number, w: number, h: number, bg?: unknown, ch?: unknown, fg?: unknown) => charge(c.fill(x, y, w, h, bg, ch, fg)),
      line: (x0: number, y0: number, x1: number, y1: number, ch?: unknown, fg?: unknown) => charge(c.line(x0, y0, x1, y1, ch, fg)),
      circle: (x: number, y: number, rad: number, ch?: unknown, fg?: unknown) => charge(c.circle(x, y, rad, ch, fg)),
      disc: (x: number, y: number, rad: number, fg?: unknown) => charge(c.disc(x, y, rad, fg)),
      pixel: (x: number, py: number, fg?: unknown) => c.pixel(x, py, fg),
      clawd: (x: number, y: number, facing?: number, stride?: number, blink?: boolean) => {
        charge(60)
        c.clawd(x, y, facing, stride, blink)
      },
      art: (x: number, y: number, rows: unknown, palette?: unknown) => {
        charge(10)
        charge(c.art(x, y, rows, palette))
      },
      tag: (x: number, y: number, label: unknown, fg?: unknown, bg?: unknown) => {
        charge(20)
        c.tag(x, y, label, fg, bg)
      },
      box: (x: number, y: number, label: unknown, fg?: unknown) => {
        charge(60)
        c.box(x, y, label, fg)
      },
      say: (s: unknown, x = 2, y = 0) => {
        charge(150)
        c.say(s, x, y)
      },
      hsl, rgb, mix, noise, noise2, smoothstep,
      rand: () => r(),
      clamp: (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v)),
    }
  }

  // Paints the frame for scene time t (seconds since the scene appeared)
  draw(t: number, doing: string): Canvas {
    const c = this.canvas
    const { scene } = this
    const W = c.w, H = c.h
    c.clear()
    if (scene.sky) {
      for (let y = 0; y < H; y++) c.fill(0, y, W, 1, mix(scene.sky[0], scene.sky[1], H > 1 ? y / (H - 1) : 0))
    }
    const groundRow = scene.ground ? H - 1 : H
    if (scene.ground) c.fill(0, groundRow, W, 1, undefined, scene.ground.glyph[0], scene.ground.color)
    scene.particles.forEach((p, i) => {
      for (const s of this.stars[i]!) {
        const x = (((s.x + p.vx * t) % W) + W) % W
        const y = (((s.y + p.vy * t) % groundRow) + groundRow) % groundRow
        c.put(x, y, p.glyph, p.color)
      }
    })
    if (this.machine) {
      try {
        this.machine.setGlobal('t', t)
        this.machine.setGlobal('frame', this.frames)
        this.machine.setGlobal('doing', doing)
        this.machine.frame(t)
      } catch (e) {
        this.fail(e)
      }
    }
    for (const a of scene.actors) {
      const lines = a.pix ?? a.art?.split('\n') ?? []
      const aw = a.clawd ? CLAWD_W : Math.max(1, ...lines.map((l) => l.length))
      const ah = a.clawd ? CLAWD_H : a.pix ? Math.ceil(lines.length / 2) : lines.length
      let x = a.x + a.vx * t
      let facing = Math.sign(a.vx)
      if (a.wrap) {
        x = ((((x + aw) % (W + aw)) + W + aw) % (W + aw)) - aw
      } else {
        // Walks back and forth across the scene
        const span = Math.max(1, W - aw)
        const k = (((x % (2 * span)) + 2 * span) % (2 * span))
        if (k > span) facing = -facing
        x = k > span ? 2 * span - k : k
      }
      const y = a.y ?? groundRow - ah
      if (a.clawd) c.clawd(x, y, facing, a.vx ? Math.floor(t * 8) : 0, t % 4 > 3.85)
      else if (a.pix) c.art(x, y, a.pix, a.palette)
      else c.sprite(x, y, a.art, a.color ?? '#ffffff')
      if (a.label) c.tag(x, y - 1, a.label, a.color)
    }
    if (scene.say) {
      // A new line (a kept scene's, or a changed {doing}) types out again
      const text = scene.say.text.replaceAll('{doing}', doing)
      if (text !== this.said) {
        if (this.said !== undefined) this.saidAt = t
        this.said = text
      }
      c.say(text, scene.say.x, scene.say.y, (t - this.saidAt) * SAY_CPS)
    }
    this.frames++
    return c
  }
}

// Runs a new scene for a few frames before it is shown, so a program that
// fails straight away is caught (and its error sent back) without a flicker
export function tryScene(scene: Scene, w: number, h: number, doing: string): string | undefined {
  const runner = new SceneRunner(scene, w, h)
  for (const t of [0, 1.3, 7.7]) {
    if (runner.error) break
    runner.draw(t, doing)
  }
  return runner.error
}

