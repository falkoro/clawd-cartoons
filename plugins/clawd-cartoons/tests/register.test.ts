import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'clawd-cartoons'
const REPLY = '```json\n{"caption":"tests by the fire","sky":["#101020","#201010"],"actors":[{"clawd":true,"x":2,"vx":3}],"say":{"text":"Warming up cart.ts by the fire."}}\n```\n```js\nfunction draw(t) { put(1, 1, "*", "#ffcc00") }\n```'
const KEEP = '{"keep": true, "say": {"text": "Still roasting cart.ts.", "x": 2, "y": 0}}'
const USAGE = { input_tokens: 2000, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// The engine beneath the plugin: a spinner line, a clock, tools that answer
// `output`, and a model that answers with the replies in turn (the last one
// over and over) and counts its calls
function engine(on: On, replies: string | string[] = REPLY, broken = { on: false }, output = { text: 'ok', isError: false }) {
  const calls: { prompt: string; model: string; maxTokens?: number }[] = []
  const clock = mock.clock(on)
  const list = Array.isArray(replies) ? replies : [replies]
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: { command: 'cartoons' } }))
  on('turn.start', () => ({ turnId: 't1' }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: output.text, text: output.text, isError: output.isError }) as any)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['Working…'] }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.blit', () => ({ value: {} }))
  on('model.complete', (_$, e) => {
    calls.push({ prompt: e.prompt, model: e.model, maxTokens: e.maxTokens })
    if (broken.on) throw new Error('boom')
    return { value: { isAnswered: true, text: list[Math.min(calls.length, list.length) - 1]!, usage: USAGE } }
  })
  return { clock, calls }
}

const SPINNER = {
  plugin: PLUGIN,
  surface: 'terminal',
  component: 'Spinner',
  requestId: 'main',
  props: { word: 'Working', message: null, suffix: '…', mode: 'tool-use' },
  viewport: { columns: 80, rows: 24 },
} as const

async function start($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ text: 'make the tests pass', turnId: 't1' })
}

test('Clawd shows the moment a turn starts, under the normal spinner', async ($, on) => {
  const { calls } = engine(on)
  await start($)
  const spinner = await $.ui.mount(SPINNER)
  expect(await spinner.find({ type: 'Raster' })).toBeDefined()
  expect(await spinner.find({ text: /Working/ })).toBeDefined()
  expect(calls).toHaveLength(0)
})

test('a step asks Sonnet for a panel, which then draws under the spinner', async ($, on) => {
  const { clock, calls } = engine(on)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as any)
  await clock.advance(2000)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.model).toBe('claude-sonnet-5-5')
  expect(calls[0]!.maxTokens).toBe(16000)
  expect(calls[0]!.prompt).toMatch(/running npm test/)
  expect(calls[0]!.prompt).toMatch(/make the tests pass/)
  expect(calls[0]!.prompt).toMatch(/Nothing is on screen yet/)
  const spinner = await $.ui.mount(SPINNER)
  const raster = await spinner.find({ type: 'Raster' })
  expect(raster).toBeDefined()
  expect(raster!.props).toMatchObject({ columns: 78, rows: 8 })
  expect(await spinner.find({ text: /Working/ })).toBeDefined()
})

test('a burst of tool calls is one request, and requests are spaced out', async ($, on) => {
  const { clock, calls } = engine(on)
  await start($)
  for (const file of ['a.ts', 'b.ts', 'c.ts']) await $.tool.call({ tool: 'Read', file_path: file } as any)
  await clock.advance(2000)
  expect(calls).toHaveLength(1)
  await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'x', new_string: 'y' } as any)
  await clock.advance(2000)
  expect(calls).toHaveLength(1) // inside the 10 s gap
  await clock.advance(20_000)
  expect(calls).toHaveLength(2)
})

test('every step gets a panel, and a reply can keep the scene and change the line', async ($, on) => {
  const { clock, calls } = engine(on, [REPLY, KEEP])
  await start($)
  await $.tool.call({ tool: 'Grep', pattern: 'round' } as any)
  await clock.advance(2000)
  const spinner = await $.ui.mount(SPINNER)
  expect(await spinner.find({ type: 'Raster' })).toBeDefined()
  await $.tool.call({ tool: 'Read', file_path: '/w/cart.ts' } as any)
  await clock.advance(15_000)
  expect(calls).toHaveLength(2)
  expect(calls[1]!.prompt).toMatch(/On screen now: "tests by the fire"/)
  expect(calls[1]!.prompt).toMatch(/- tests by the fire: "Warming up cart.ts by the fire."/)
  expect(calls[1]!.prompt).toMatch(/Its last steps: thinking it over; searching for round/)
  expect(await spinner.find({ type: 'Raster' })).toBeDefined()
  await clock.advance(60_000)
  expect(calls).toHaveLength(2) // nothing new happened, so nothing is asked
  const status = await $.command.run({ command: 'cartoons', args: '' } as any)
  expect(status.text).toMatch(/2 requests \(0 failed, 1 kept the scene/)
})

test('what the agent said and what its last step returned go with the request', async ($, on) => {
  const { clock, calls } = engine(on, REPLY, { on: false }, { text: 'FAIL discount.test.ts: expected 9.99, got 10', isError: true })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as any)
  // The kit stores no rows, so the append itself fails once the plugin has seen it
  await $.session.append({
    door: 'response',
    origin: { kind: 'model', model: 'claude' },
    uuid: 'u1',
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'The rounding is off by a cent in discount.ts.' }] },
  } as any).catch(() => {})
  await clock.advance(2000)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.prompt).toMatch(/The last step FAILED: FAIL discount.test.ts: expected 9.99, got 10/)
  expect(calls[0]!.prompt).toMatch(/The agent just said: "The rounding is off by a cent in discount.ts."/)
})

test('a program that fails is sent back with the next request', async ($, on) => {
  const { clock, calls } = engine(on, '```js\nfunction draw() { while (true) {} }\n```')
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'make' } as any)
  await clock.advance(2000)
  expect(await (await $.ui.mount(SPINNER)).find({ type: 'Raster' })).toBeDefined() // Clawd's own scene stays
  await $.tool.call({ tool: 'Bash', command: 'make again' } as any)
  await clock.advance(25_000)
  expect(calls).toHaveLength(2)
  expect(calls[1]!.prompt).toMatch(/Your last program failed with: line 1: ran out of steps/)
})

test('/cartoons off stops requests and brings back the normal spinner', async ($, on) => {
  const { clock, calls } = engine(on)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as any)
  await clock.advance(2000)
  const off = await $.command.run({ command: 'cartoons', args: 'off' } as any)
  expect(off.text).toMatch(/Cartoons off/)
  expect(await (await $.ui.mount(SPINNER)).find({ type: 'Raster' })).toBeUndefined()
  await $.tool.call({ tool: 'Read', file_path: 'x.ts' } as any)
  await clock.advance(60_000)
  expect(calls).toHaveLength(1)
  const status = await $.command.run({ command: 'cartoons', args: '' } as any)
  expect(status.text).toMatch(/Cartoons are off/)
  expect(status.text).toMatch(/1 requests \(0 failed, 0 kept the scene and changed the line\), 2000 input and 900 output tokens/)
})

test('the model and limits come from the plugin options', { options: { model: 'haiku', max_reply_tokens: 4000, enabled: true } }, async ($, on) => {
  const { clock, calls } = engine(on)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  await clock.advance(2000)
  expect(calls[0]).toMatchObject({ model: 'haiku', maxTokens: 4000 })
})

test('turned off in the options, it never calls the model', { options: { enabled: false } }, async ($, on) => {
  const { clock, calls } = engine(on)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  await clock.advance(60_000)
  expect(calls).toHaveLength(0)
})

test('a model call that throws is a failure with backoff, not an unhandled rejection', async ($, on) => {
  const broken = { on: true }
  const { clock, calls } = engine(on, REPLY, broken)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as any)
  await clock.advance(2000)
  expect(calls).toHaveLength(1)
  broken.on = false
  await clock.advance(60_000)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as any)
  await clock.advance(60_000)
  expect(calls.length).toBeGreaterThan(1)
  const raster = await (await $.ui.mount(SPINNER)).find({ type: 'Raster' })
  expect(raster).toBeDefined()
})
