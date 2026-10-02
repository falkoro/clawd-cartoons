import { expect, test } from 'claude-code/testing'

import { Canvas, DEFAULT, color, glyph, hsl, mix, noise2, rgb, smoothstep } from '../hooks/canvas'
import { SYSTEM } from '../hooks/prompt'
import { SceneRunner, parseReply, tryScene } from '../hooks/scene'

const cell = (c: Canvas, x: number, y: number) => {
  const i = (y * c.w + x) * 3
  return { ch: String.fromCodePoint(c.cells[i]!), fg: c.cells[i + 1]!, bg: c.cells[i + 2]! }
}
const row = (c: Canvas, y: number) => Array.from({ length: c.w }, (_, x) => cell(c, x, y).ch).join('')
const RED = 0xff0000
const BLUE = 0x0000ff

test('colors come from hex, rgb, hsl and mix', () => {
  expect(color('#f00')).toBe(RED)
  expect(color('#0000ff')).toBe(BLUE)
  expect(color(RED)).toBe(RED)
  expect(color('default')).toBe(DEFAULT)
  expect(rgb(255, 0, 300)).toBe(0xff00ff)
  expect(hsl(0, 1, 0.5)).toBe(RED)
  expect(hsl(240, 100, 50)).toBe(BLUE)
  expect(mix('#000000', '#ffffff', 0.5)).toBe(0x808080)
  expect(smoothstep(0, 1, 0.5)).toBe(0.5)
  const n = noise2(3.3, 1.7)
  expect(n >= 0 && n <= 1).toBe(true)
  let err = ''
  try {
    color('blue-ish')
  } catch (e) {
    err = (e as Error).message
  }
  expect(err).toMatch(/bad color "blue-ish"/)
})

test('glyphs wider than one cell become ?', () => {
  expect(glyph('A')).toBe(0x41)
  expect(glyph('█')).toBe(0x2588)
  expect(glyph('✓')).toBe(0x2713)
  expect(glyph('🦀')).toBe(0x3f)
  expect(glyph('漢')).toBe(0x3f)
  expect(glyph('\n')).toBe(0x3f)
})

test('put, text and sprite draw cells and leave the rest', () => {
  const c = new Canvas(10, 3)
  c.put(0, 0, '@', RED, BLUE)
  expect(cell(c, 0, 0)).toEqual({ ch: '@', fg: RED, bg: BLUE })
  c.text(2, 1, 'hello', RED)
  expect(row(c, 1)).toBe('  hello   ')
  c.sprite(0, 1, 'ab\n c', BLUE)
  expect(row(c, 1)).toBe('abhello   ')
  expect(row(c, 2)).toBe(' c        ')
  c.put(-1, 0, 'x')
  c.put(10, 5, 'x')
  c.text(8, 0, 'overflow')
  expect(row(c, 0)).toBe('@       ov')
})

test('fill, line and circle draw shapes and say how many cells they touched', () => {
  const c = new Canvas(10, 4)
  expect(c.fill(1, 1, 3, 2, RED)).toBe(6)
  expect(cell(c, 2, 2).bg).toBe(RED)
  expect(cell(c, 4, 2).bg).toBe(DEFAULT)
  expect(c.fill(8, 3, 100, 100, BLUE, '#', RED)).toBe(2)
  expect(cell(c, 9, 3)).toEqual({ ch: '#', fg: RED, bg: BLUE })
  c.clear()
  c.line(0, 0, 9, 0, '-')
  expect(row(c, 0)).toBe('----------')
  c.clear()
  expect(c.circle(5, 2, 2, 'o') > 0).toBe(true)
  expect(row(c, 2)).toMatch(/o.*o/)
})

test('pixel and disc paint half cells', () => {
  const c = new Canvas(4, 2)
  c.pixel(0, 0, RED)
  expect(cell(c, 0, 0)).toEqual({ ch: '▀', fg: RED, bg: DEFAULT })
  c.pixel(0, 1, BLUE)
  expect(cell(c, 0, 0)).toEqual({ ch: '▀', fg: RED, bg: BLUE })
  c.pixel(1, 1, BLUE)
  expect(cell(c, 1, 0)).toEqual({ ch: '▄', fg: BLUE, bg: DEFAULT })
  c.clear()
  expect(c.disc(2, 1, 1.5, RED) > 0).toBe(true)
  expect(cell(c, 2, 1).ch).toMatch(/[▀▄]/)
})

test('clawd walks, blinks and faces both ways', () => {
  const a = new Canvas(16, 3), b = new Canvas(16, 3), shut = new Canvas(16, 3), left = new Canvas(16, 3)
  a.clawd(1, 0, 1, 0)
  b.clawd(1, 0, 1, 1)
  shut.clawd(1, 0, 1, 0, true)
  left.clawd(1, 0, -1, 0)
  expect(row(a, 0).trim().length > 0).toBe(true)
  expect(row(a, 1)).toBe(' ' + '▀'.repeat(14) + ' ') // arms out, as on the banner
  expect(cell(a, 1, 1).bg).toBe(DEFAULT) // each arm is one pixel tall
  expect(row(a, 2) === row(b, 2)).toBe(false) // the legs move
  expect(a.cells.join() === shut.cells.join()).toBe(false) // the eyes close
  expect(a.cells.join() === left.cells.join()).toBe(false) // the eyes look the other way
})

test('art paints pixels from a palette, and tag labels things', () => {
  const c = new Canvas(10, 3)
  expect(c.art(1, 0.5, ['r.b', 'rrr'], { r: '#f00', b: BLUE })).toBe(5)
  expect(cell(c, 1, 0)).toEqual({ ch: '▄', fg: RED, bg: DEFAULT }) // .5 starts a pixel lower
  expect(cell(c, 2, 1)).toEqual({ ch: '▀', fg: RED, bg: DEFAULT })
  expect(cell(c, 3, 0).fg).toBe(BLUE)
  expect(cell(c, 2, 0).ch).toBe(' ') // '.' is see-through
  c.tag(0, 2, 'cart.ts')
  expect(row(c, 2)).toBe('[cart.ts] ')
})

test('say draws a bubble that types out', () => {
  const c = new Canvas(30, 4)
  c.say('hi there', 0, 0)
  expect(row(c, 0)).toMatch(/^╭─+╮/)
  expect(row(c, 1)).toMatch(/^│ hi there │/)
  expect(row(c, 2)).toMatch(/^╰─┬─+╯/)
  c.clear()
  c.say('hi there', 0, 0, 2)
  expect(row(c, 1)).toMatch(/^│ hi {7}│/)
})

test('the bubble steps aside rather than cover Clawd', () => {
  const c = new Canvas(60, 6)
  c.clawd(4, 2, 1, 0)
  c.say('hello there', 4, 0)
  expect(row(c, 1)).toMatch(/^ {19}│ hello there │/)
  c.clear()
  c.clawd(44, 2, 1, 0)
  c.say('hello there', 44, 0)
  expect(row(c, 1)).toMatch(/^ {28}│ hello there │ {17}$/)
})

test('cells encode as the Raster expects', () => {
  const c = new Canvas(2, 1)
  c.put(0, 0, 'A', RED, BLUE)
  const bytes = Uint8Array.from(atob(c.base64()), (ch) => ch.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  expect(Array.from(words)).toEqual([0x41, RED, BLUE, 0x20, DEFAULT, DEFAULT])
})

test('a reply parses into a scene', () => {
  const { scene, error } = parseReply('Here you go:\n```json\n{"caption":"x","sky":["#000","#111"],"actors":[{"clawd":true,"x":3,"vx":4}],"say":{"text":"{doing}"}}\n```\n```js\nfunction draw(t) { put(0, 0, "*") }\n```')
  expect(error).toBeUndefined()
  expect(scene!.caption).toBe('x')
  expect(scene!.actors[0]).toMatchObject({ clawd: true, x: 3, vx: 4, wrap: true })
  expect(scene!.code).toMatch(/function draw/)
})

test('pixel actors keep their palette and label', () => {
  const { scene } = parseReply(JSON.stringify({
    actors: [{ pix: ['GG', 'GG'], palette: { G: '#00ff00', bad: '#fff', X: 'nope' }, label: 'cart.ts', x: 2, y: 2, vx: 0 }],
  }))
  expect(scene!.actors[0]).toMatchObject({ pix: ['GG', 'GG'], palette: { G: '#00ff00' }, label: 'cart.ts' })
  const c = new SceneRunner(scene!, 20, 4).draw(0, '')
  expect(cell(c, 2, 2)).toEqual({ ch: '▀', fg: 0x00ff00, bg: 0x00ff00 })
  expect(row(c, 1)).toMatch(/^ {2}\[cart\.ts\]/) // the label sits above
})

test('a keep reply changes only the line, which types out again', () => {
  expect(parseReply('{"keep": true, "say": {"text": "Still here.", "x": 1, "y": 0}}')).toEqual({ keep: { text: 'Still here.', x: 1, y: 0 } })
  expect(parseReply('{"keep": true}').error).toMatch(/needs "say"/)
  const { scene } = parseReply(JSON.stringify({ say: { text: 'First line.', x: 0, y: 0 } }))
  const r = new SceneRunner(scene!, 30, 4)
  expect(row(r.draw(5, ''), 1)).toMatch(/First line\./)
  scene!.say = { text: 'Second line.', x: 0, y: 0 }
  expect(row(r.draw(5, ''), 1)).not.toMatch(/Second/)
  expect(row(r.draw(6, ''), 1)).toMatch(/Second line\./)
})

test('a reply that is only code is a scene', () => {
  expect(parseReply('```js\nput(0, 0, "x")\n```').scene!.code).toBe('put(0, 0, "x")\n')
})

test('replies with nothing usable say why', () => {
  expect(parseReply('no idea').error).toMatch(/nothing to draw/)
  expect(parseReply('{ not json').error).toMatch(/did not parse/)
  expect(parseReply('{"sky": "not a color", "actors": [{"x": 1}]}').error).toMatch(/nothing to draw/)
  expect(parseReply('```js\n' + 'x'.repeat(13000) + '\n```').error).toMatch(/keep it under/)
})

test('scene numbers are clamped and junk is dropped', () => {
  const { scene } = parseReply(JSON.stringify({
    particles: [{ count: 1e9, vx: 1e9 }, 'junk'],
    actors: [{ art: 'A', vx: -1e9 }, { nothing: true }],
  }))
  expect(scene!.particles).toHaveLength(1)
  expect(scene!.particles[0]).toMatchObject({ count: 200, vx: 60 })
  expect(scene!.actors).toHaveLength(1)
  expect(scene!.actors[0]!.vx).toBe(-80)
})

test('the runner draws every layer in order', () => {
  const { scene } = parseReply(JSON.stringify({
    sky: ['#000000', '#000000'],
    ground: { color: '#00ff00', glyph: '=' },
    particles: [{ glyph: '*', color: '#ffffff', count: 5 }],
    actors: [{ art: 'AB', x: 0, y: 1, vx: 0, wrap: false }],
    say: { text: 'doing {doing}', x: 10, y: 0 },
    code: 'function draw(t) { put(0, 1, "C"); put(5, 5, "Z", "#ff0000") }',
  }))
  const r = new SceneRunner(scene!, 40, 8)
  const c = r.draw(10, 'tests')
  expect(r.error).toBeUndefined()
  expect(row(c, 7)).toBe('='.repeat(40))
  expect(cell(c, 0, 1).ch).toBe('A') // the actor is drawn over the program
  expect(cell(c, 5, 5)).toMatchObject({ ch: 'Z', fg: RED })
  expect(row(c, 1)).toMatch(/doing tests/)
  expect(cell(c, 20, 3).bg).toBe(0)
})

test('a program that fails is switched off and its error kept', () => {
  const { scene } = parseReply(JSON.stringify({ sky: '#000000', code: 'function draw(t) { if (t > 1) while (true) {} }' }))
  const r = new SceneRunner(scene!, 40, 8)
  r.draw(0, '')
  expect(r.error).toBeUndefined()
  r.draw(2, '')
  expect(r.error).toMatch(/ran out of steps/)
  r.draw(3, '') // the rest of the scene still draws
  expect(tryScene(scene!, 40, 8, '')).toMatch(/ran out of steps/)
  expect(tryScene(parseReply('```js\nput(0, 0, "x", "purple")\n```').scene!, 40, 8, '')).toMatch(/line 1: bad color "purple"/)
})

test('the example in the prompt runs cleanly', () => {
  const code = /```js\n([\s\S]*?)```/.exec(SYSTEM)![1]!
  const json = /```json\n([\s\S]*?)```/.exec(SYSTEM)![1]!
  const { scene } = parseReply('```json\n' + json + '```\n```js\n' + code + '```')
  expect(tryScene(scene!, 80, 8, 'running the tests')).toBeUndefined()
  const keep = /A kept scene[^\n]*\n(.*)/.exec(SYSTEM)![1]!
  expect(parseReply(keep).keep).toBeDefined()
})

test('a full-width shader stays well inside a 20 fps frame', () => {
  const shader = `function draw(t) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = noise2(x * 0.08 + t, y * 0.3 - t * 0.5)
      put(x, y, ' ', undefined, hsl(200 + v * 80, 0.6, 0.15 + v * 0.3))
    }
  }`
  const { scene } = parseReply('```js\n' + shader + '\n```')
  const r = new SceneRunner(scene!, 200, 8)
  r.draw(0, '')
  const frames = 20
  const start = Date.now()
  for (let i = 1; i <= frames; i++) r.draw(i / 20, '')
  const msPerFrame = (Date.now() - start) / frames
  expect(r.error).toBeUndefined()
  // 50 ms is the whole frame at 20 fps; the shader should take a fraction
  expect(msPerFrame < 25, `${msPerFrame} ms a frame`).toBe(true)
})
