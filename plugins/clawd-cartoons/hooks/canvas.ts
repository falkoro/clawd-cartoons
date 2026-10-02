// A grid of terminal cells and the drawing primitives scenes use.
// Every cell is three numbers, as a Raster packs them: code point, fg, bg.

export const DEFAULT = 0x01000000 // the terminal's own color
const KEEP = -1 // leave the cell's current color alone

const SPACE = 0x20
const UPPER = 0x2580 // ▀
const LOWER = 0x2584 // ▄
const FULL = 0x2588 // █

// Characters a Raster draws one cell wide on every terminal. Anything else
// (emoji, CJK, combining marks) becomes '?' so the tree is never refused.
const GLYPH_RANGES: [number, number][] = [
  [0x20, 0x7e], [0xa1, 0x24f], [0x370, 0x3ff], [0x2010, 0x205e], [0x2190, 0x21ff],
  [0x2200, 0x22ff], [0x2500, 0x25ff], [0x2600, 0x2605], [0x2660, 0x266f], [0x2713, 0x2718], [0x2800, 0x28ff],
]

export function glyph(ch: unknown): number {
  if (typeof ch === 'number') ch = String.fromCodePoint(Math.max(0, Math.min(0x10ffff, ch | 0)))
  const cp = String(ch ?? ' ').codePointAt(0) ?? SPACE
  for (const [lo, hi] of GLYPH_RANGES) if (cp >= lo && cp <= hi) return cp
  return 0x3f
}

const hexCache = new Map<string, number>()

// A color from a number (0xRRGGBB), a '#rgb' / '#rrggbb' string, or nothing.
export function color(v: unknown, fallback = KEEP): number {
  if (v === undefined || v === null) return fallback
  if (typeof v === 'number') return Number.isFinite(v) ? (v === DEFAULT ? DEFAULT : v & 0xffffff) : fallback
  const s = String(v).trim().toLowerCase()
  if (s === 'default' || s === 'none') return DEFAULT
  let c = hexCache.get(s)
  if (c === undefined) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)
    if (!m) throw new Error(`bad color ${JSON.stringify(String(v).slice(0, 20))}: use "#rrggbb", rgb() or hsl()`)
    const h = m[1]!
    c = parseInt(h.length === 3 ? h[0]! + h[0] + h[1] + h[1] + h[2] + h[2] : h, 16)
    if (hexCache.size < 512) hexCache.set(s, c)
  }
  return c
}

const clamp255 = (x: number) => Math.max(0, Math.min(255, Math.round(x)))

export function rgb(r: number, g: number, b: number): number {
  return (clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(b)
}

// h in degrees; s and l from 0 to 1 (values above 1 are read as percents)
export function hsl(h: number, s: number, l: number): number {
  if (s > 1) s /= 100
  if (l > 1) l /= 100
  h = (((h % 360) + 360) % 360) / 360
  s = Math.max(0, Math.min(1, s))
  l = Math.max(0, Math.min(1, l))
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const ch = (t: number) => {
    t = t < 0 ? t + 1 : t > 1 ? t - 1 : t
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p
  }
  return rgb(ch(h + 1 / 3) * 255, ch(h) * 255, ch(h - 1 / 3) * 255)
}

export function mix(a: unknown, b: unknown, k: number): number {
  const x = color(a, 0), y = color(b, 0)
  k = Math.max(0, Math.min(1, Number(k) || 0))
  const lerp = (sh: number) => ((x >> sh) & 255) * (1 - k) + ((y >> sh) & 255) * k
  return rgb(lerp(16), lerp(8), lerp(0))
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0 || 1)))
  return t * t * (3 - 2 * t)
}

function hash(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// Smooth value noise from 0 to 1
export function noise2(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y)
  const u = smoothstep(0, 1, x - xi), v = smoothstep(0, 1, y - yi)
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

export const noise = (x: number) => noise2(x, 0.5)

// A seeded random number source, so a scene looks the same each time it plays
export function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Clawd as on the Claude Code banner, two pixels to a cell: fourteen columns
// with the arms out, three rows with the legs; the eyes are drawn on top
const CLAWD_ROWS = ['..BBBBBBBBBB..', '..BBBBBBBBBB..', 'BBBBBBBBBBBBBB', '..BBBBBBBBBB..']
const CLAWD_LEGS = [['...B.B..B.B...', '...B.B..B.B...'], ['...B.B..B.B...', '..B...BB...B..']]
const CLAWD_BODY = 0xd77757
const CLAWD_EYE = 0x1e1414
export const CLAWD_W = 14
export const CLAWD_H = 3

const TAG_BG = 0x1c1c26

export class Canvas {
  readonly cells: Uint32Array
  readonly w: number
  readonly h: number
  private clawdAt?: { x: number; y: number } // where Clawd was last drawn, so the bubble can stay clear
  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    this.cells = new Uint32Array(w * h * 3)
    this.clear()
  }

  clear() {
    this.clawdAt = undefined
    for (let i = 0; i < this.cells.length; i += 3) {
      this.cells[i] = SPACE
      this.cells[i + 1] = DEFAULT
      this.cells[i + 2] = DEFAULT
    }
  }

  // Low-level write; fg/bg of KEEP leave the cell's color as it is
  set(x: number, y: number, cp: number, fg: number, bg: number) {
    x = Math.floor(x)
    y = Math.floor(y)
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 3
    this.cells[i] = cp
    if (fg !== KEEP) this.cells[i + 1] = fg
    if (bg !== KEEP) this.cells[i + 2] = bg
  }

  put(x: number, y: number, ch: unknown, fg?: unknown, bg?: unknown) {
    this.set(x, y, glyph(ch), color(fg, DEFAULT), color(bg))
  }

  text(x: number, y: number, s: unknown, fg?: unknown, bg?: unknown) {
    const f = color(fg, DEFAULT), b = color(bg)
    let cx = Math.floor(x)
    for (const ch of String(s).slice(0, this.w * 2)) this.set(cx++, y, glyph(ch), f, b)
  }

  // Multi-line art; spaces are see-through
  sprite(x: number, y: number, art: unknown, fg?: unknown, bg?: unknown) {
    const f = color(fg, DEFAULT), b = color(bg)
    String(art).split('\n').slice(0, this.h * 2).forEach((row, dy) => {
      let dx = 0
      for (const ch of row.slice(0, this.w * 2)) {
        if (ch !== ' ') this.set(x + dx, y + dy, glyph(ch), f, b)
        dx++
      }
    })
  }

  fill(x: number, y: number, w: number, h: number, bg?: unknown, ch?: unknown, fg?: unknown): number {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y))
    const x1 = Math.min(this.w, Math.floor(x + w)), y1 = Math.min(this.h, Math.floor(y + h))
    const cp = ch === undefined ? SPACE : glyph(ch)
    const f = ch === undefined ? KEEP : color(fg, DEFAULT), b = color(bg)
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.set(xx, yy, cp, f, b)
    return Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  }

  line(x0: number, y0: number, x1: number, y1: number, ch?: unknown, fg?: unknown): number {
    const cp = glyph(ch ?? '·'), f = color(fg, DEFAULT)
    const n = Math.min(1024, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))))
    for (let i = 0; i <= n; i++) {
      const k = n === 0 ? 0 : i / n
      this.set(Math.round(x0 + (x1 - x0) * k), Math.round(y0 + (y1 - y0) * k), cp, f, KEEP)
    }
    return n
  }

  // An outline; cells are about twice as tall as wide, so y is squashed
  circle(cx: number, cy: number, r: number, ch?: unknown, fg?: unknown): number {
    const cp = glyph(ch ?? 'o'), f = color(fg, DEFAULT)
    const n = Math.min(512, Math.max(8, Math.ceil(r * 8)))
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      this.set(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r * 0.5), cp, f, KEEP)
    }
    return n
  }

  // A half-cell pixel: py counts half rows, so pixels are about square
  pixel(x: number, py: number, c: unknown) {
    x = Math.floor(x)
    py = Math.floor(py)
    if (x < 0 || py < 0 || x >= this.w || py >= this.h * 2) return
    const i = ((py >> 1) * this.w + x) * 3
    const cp = this.cells[i]!, fg = this.cells[i + 1]!, bg = this.cells[i + 2]!
    let top = bg, bottom = bg
    if (cp === UPPER) top = fg
    else if (cp === LOWER) bottom = fg
    else if (cp === FULL) top = bottom = fg
    const v = color(c, DEFAULT)
    if (py & 1) bottom = v
    else top = v
    // ▀ paints its top half in fg; with no top color, ▄ keeps the default above
    const lowerOnly = top === DEFAULT
    this.cells[i] = lowerOnly && bottom === DEFAULT ? SPACE : lowerOnly ? LOWER : UPPER
    this.cells[i + 1] = lowerOnly ? bottom : top
    this.cells[i + 2] = lowerOnly ? DEFAULT : bottom
  }

  disc(cx: number, cy: number, r: number, c?: unknown): number {
    const pcx = cx, pcy = cy * 2 + 1
    r = Math.min(Math.abs(r), 256)
    let n = 0
    for (let py = Math.floor(pcy - r); py <= pcy + r; py++) {
      for (let x = Math.floor(pcx - r); x <= pcx + r; x++) {
        const dx = x + 0.5 - pcx, dy = py + 0.5 - pcy
        if (dx * dx + dy * dy <= r * r) {
          this.pixel(x, py, c)
          n++
        }
      }
    }
    return n
  }

  clawd(x: number, y: number, facing = 1, stride = 0, blink = false) {
    x = Math.floor(x)
    const py0 = Math.round(y * 2)
    this.clawdAt = { x, y: py0 >> 1 }
    const shift = facing < 0 ? -1 : facing > 0 ? 1 : 0
    const rows = [...CLAWD_ROWS, ...CLAWD_LEGS[Math.abs(Math.floor(stride)) % 2]!]
    rows.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++) if (row[dx] === 'B') this.pixel(x + dx, py0 + dy, CLAWD_BODY)
    })
    // The eyes look where Clawd walks, and close to one pixel on a blink
    for (const ex of [4, 9]) for (let dy = blink ? 2 : 1; dy <= 2; dy++) this.pixel(x + ex + shift, py0 + dy, CLAWD_EYE)
  }

  // Pixel art, two pixels to a cell: each character of a row is one pixel in
  // the palette's color for it; '.' and ' ' are see-through. y counts cells
  // and may end in .5 to start a pixel lower.
  art(x: number, y: number, rows: unknown, palette?: unknown): number {
    const list = (Array.isArray(rows) ? rows : String(rows ?? '').split('\n')).slice(0, this.h * 2 + 8)
    const pal = palette && typeof palette === 'object' ? (palette as Record<string, unknown>) : {}
    const colors = new Map<string, number>()
    const x0 = Math.floor(x), py0 = Math.round(y * 2)
    let n = 0
    list.forEach((row, dy) => {
      let dx = 0
      for (const ch of String(row).slice(0, this.w + 64)) {
        if (ch !== '.' && ch !== ' ') {
          let c = colors.get(ch)
          if (c === undefined) colors.set(ch, (c = color(pal[ch] ?? '#ffffff', DEFAULT)))
          this.pixel(x0 + dx, py0 + dy, c)
          n++
        }
        dx++
      }
    })
    return n
  }

  // A label for a real thing in the scene: [name] in its color on a dark chip
  tag(x: number, y: number, label: unknown, fg?: unknown, bg?: unknown) {
    const s = String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    if (s) this.text(x, y, `[${s}]`, fg ?? 0xc8c8d8, bg ?? TAG_BG)
  }

  // A speech bubble whose top-left corner is at x, y; `shown` limits how much
  // of the text has typed out so far
  say(text: unknown, x: number, y: number, shown = Infinity) {
    const words = String(text).replace(/\s+/g, ' ').trim()
    if (!words) return
    const maxW = Math.max(4, Math.min(34, this.w - 4))
    const lines: string[] = []
    let cur = ''
    for (const word of words.split(' ')) {
      if (cur && (cur + ' ' + word).length > maxW) {
        lines.push(cur)
        cur = ''
      }
      cur = (cur ? cur + ' ' : '') + word.slice(0, maxW)
    }
    if (cur) lines.push(cur)
    lines.splice(3)
    const inner = Math.max(...lines.map((l) => l.length))
    const bw = inner + 4, bh = lines.length + 2
    let bx = Math.max(0, Math.min(Math.floor(x), this.w - bw))
    const by = Math.max(0, Math.min(Math.floor(y), this.h - bh))
    // Never over Clawd: step aside to whichever side has room
    const k = this.clawdAt
    if (k && bx < k.x + CLAWD_W && k.x < bx + bw && by < k.y + CLAWD_H + 1 && k.y < by + bh) {
      if (k.x + CLAWD_W + 1 + bw <= this.w) bx = k.x + CLAWD_W + 1
      else if (k.x - bw - 1 >= 0) bx = k.x - bw - 1
    }
    const edge = 0xd8d0c8, ink = 0xffffff, paper = 0x3a2424
    this.fill(bx, by, bw, bh, paper)
    for (let i = 1; i < bw - 1; i++) {
      this.set(bx + i, by, 0x2500, edge, paper)
      this.set(bx + i, by + bh - 1, 0x2500, edge, paper)
    }
    for (let j = 1; j < bh - 1; j++) {
      this.set(bx, by + j, 0x2502, edge, paper)
      this.set(bx + bw - 1, by + j, 0x2502, edge, paper)
    }
    this.set(bx, by, 0x256d, edge, paper)
    this.set(bx + bw - 1, by, 0x256e, edge, paper)
    this.set(bx, by + bh - 1, 0x2570, edge, paper)
    this.set(bx + bw - 1, by + bh - 1, 0x256f, edge, paper)
    this.set(bx + 2, by + bh - 1, 0x252c, edge, paper)
    let left = Math.floor(shown)
    lines.forEach((l, j) => {
      const part = l.slice(0, Math.max(0, left))
      left -= l.length + 1
      this.text(bx + 2, by + 1 + j, part, ink, paper)
    })
  }

  base64(): string {
    const bytes = new Uint8Array(this.cells.buffer)
    const native = (bytes as unknown as { toBase64?: () => string }).toBase64
    if (native) return native.call(bytes)
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(bin)
  }
}
