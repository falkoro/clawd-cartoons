// What the model is told: how a scene is written, and what the agent is doing.

const EXAMPLE = `\`\`\`json
{
  "caption": "running the tests by the campfire",
  "sky": ["#0b1026", "#2a1830"],
  "ground": { "color": "#4a3a2a", "glyph": "▁" },
  "particles": [{ "glyph": "·", "color": "#8fa3ff", "count": 14, "vx": -1, "vy": 0 }],
  "actors": [{ "art": "[||||]", "x": -8, "vx": 5, "color": "#9be89b" }],
  "say": { "text": "{doing}", "x": 2, "y": 0 }
}
\`\`\`
\`\`\`js
// A fire shader with embers, and Clawd keeping warm beside it
const fx = Math.floor(W * 0.6)
let embers = Array.from({ length: 12 }, () => ({ x: fx + rand() * 6 - 3, y: H - 2, v: 2 + rand() * 3 }))

function draw(t) {
  for (let y = H - 5; y < H - 1; y++) {
    for (let x = fx - 4; x <= fx + 4; x++) {
      const d = Math.abs(x - fx) / 5 + (H - 1 - y) / 4
      const heat = noise2(x * 0.7, y * 0.9 - t * 4) - d + 0.6
      if (heat > 0.15) put(x, y, heat > 0.5 ? '▲' : '^', mix('#ff3b1f', '#ffe08a', smoothstep(0.15, 0.8, heat)))
    }
  }
  for (const e of embers) {
    e.y -= e.v * 0.05
    if (e.y < 0) { e.y = H - 2; e.x = fx + rand() * 6 - 3 }
    put(e.x, e.y, '.', hsl(30 + rand() * 20, 1, 0.6))
  }
  clawd(fx - 14, H - 4, 1, 0, t % 3 > 2.8)
}
\`\`\``

export const SYSTEM = `You draw tiny animated cartoons for a coding agent's progress spinner, in a terminal. The cartoon is a strip of character cells under the spinner line; it shows, as a playful visual metaphor, what the agent is doing right now. The star is Clawd, a small coral crab.

Reply with one \`\`\`json block (the scene) and, when the idea is more than things sliding across, one \`\`\`js block (a program). Write a program whenever you can: weather, fire, water, machines, shaders and anything that changes over time need one. No other text.

The scene JSON (every field optional, at least one needed):
- "caption": a few words naming the idea
- "sky": ["#top", "#bottom"], a vertical background gradient
- "ground": {"color": "#hex", "glyph": "▁"}, the bottom row
- "particles": up to 6 of {"glyph", "color", "count" (≤200), "vx", "vy"} drifting and wrapping, speeds in cells/second
- "actors": up to 8 of {"clawd": true} or {"art": "multi\\nline"}, with "x", optional "y" (default: standing on the ground), "vx" (cells/second), "color", "wrap" (false: walk back and forth). Clawd is 10 cells wide, 3 tall
- "say": {"text", "x", "y"}, a speech bubble that types out; "{doing}" in the text becomes what the agent is doing

Layers draw in this order: sky, ground, particles, then your program, then actors, then the bubble.

The program is written in a small subset of JavaScript run by a sandboxed interpreter: let/const/var, functions and arrows, if/else, for, for...of, for...in, while, do, switch, break/continue/return, objects, arrays, template strings, destructuring of flat [a, b] and {x, y}. Not available: classes, new, this, try/throw, async, regex, spread, ?., imports, prototypes. Arrays have the usual methods (push, map, filter, forEach, reduce, sort, slice, splice, join, includes, find, ...); strings too (slice, split, padStart, repeat, includes, ...). Math (random is seeded), Array.from, Array.isArray, Object.keys/values/entries, String, Number, parseInt, parseFloat.
Top-level code runs once; then draw(t) runs every frame (20 per second), t in seconds. Without draw, the whole program runs every frame.
Globals: W, H (size in cells; x grows right, y grows down), t, frame, doing (what the agent is doing, as text).
Drawing (colors are "#rrggbb" strings or numbers from the helpers; x and y are cells, fractions round down):
- put(x, y, ch, fg?, bg?): one cell
- text(x, y, str, fg?, bg?)
- sprite(x, y, "multi\\nline", fg?, bg?): spaces are see-through
- fill(x, y, w, h, bg?, ch?, fg?)
- line(x0, y0, x1, y1, ch?, fg?), circle(x, y, r, ch?, fg?): an outline
- disc(x, y, r, color) and pixel(x, py, color): solid half-cell pixels, about square; py counts half rows (0 to 2*H-1)
- clawd(x, y, facing, stride, blink): Clawd at x, y; facing 1 right, -1 left; stride a step counter (Math.floor(t*8) walks); blink true closes the eyes
- say(text, x, y): a speech bubble
Helpers: hsl(h 0-360, s 0-1, l 0-1), rgb(r, g, b), mix(colorA, colorB, k 0-1), noise(x) and noise2(x, y) (smooth, 0 to 1), smoothstep(a, b, x), rand(), clamp(v, lo, hi).
Every cell you draw with fg and bg can be any color, so you can paint whole shaders: a loop over every cell calling put(x, y, ' ', undefined, color) is fine.
Limits: each frame may take about 300,000 steps (setup 1,000,000); arrays up to 10,000 items, strings 10,000 characters, calls 64 deep. Going over stops the program, and you will be told the error.

Use only single-width characters: ASCII, Latin, Greek, box drawing (─│┌┐└┘╭╮╰╯), blocks (█▀▄▌▐░▒▓), shapes (▲▼◆●○■□), marks (✓✗), arrows, braille. No emoji: they become "?".
Keep it readable at a glance and gentle on the eyes: dark backgrounds, a few bright accents, motion that loops. Keep the bubble short (it holds about 30 characters a line, 3 lines).

An example reply:
${EXAMPLE}`

export type Activity = { kind: string; text: string }

const short = (s: unknown, n = 60): string => {
  const v = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
  return v.length > n ? v.slice(0, n - 1) + '…' : v
}
const base = (p: unknown) => short(typeof p === 'string' ? p.split('/').filter(Boolean).pop() : '', 40)

// Names what a tool call is doing; `kind` is coarse, so scenes are asked for
// (and cached) per kind of work rather than per call
export function describeTool(tool: string, input: Record<string, unknown>): Activity {
  switch (tool) {
    case 'Bash': {
      const cmd = short(input.command, 80)
      const word = cmd.replace(/^(sudo|env \S+|time|npx|bunx|pnpm|yarn|npm run|npm)\s+/, '').split(/[\s;&|]/)[0] || 'shell'
      const isTest = /\b(test|jest|vitest|pytest|mocha|cargo test|go test|rspec)\b/.test(cmd)
      const isBuild = /\b(build|make|tsc|cargo build|webpack|vite build|compile)\b/.test(cmd)
      const isGit = /^git\b/.test(cmd)
      const kind = isTest ? 'Bash:test' : isBuild ? 'Bash:build' : isGit ? 'Bash:git' : `Bash:${base(word)}`
      return { kind, text: `running ${cmd}` }
    }
    case 'Read': return { kind: 'Read', text: `reading ${base(input.file_path)}` }
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit':
      return { kind: 'Edit', text: `${tool === 'Write' ? 'writing' : 'editing'} ${base(input.file_path ?? input.notebook_path)}` }
    case 'Grep': return { kind: 'Search', text: `searching for ${short(input.pattern, 40)}` }
    case 'Glob': return { kind: 'Search', text: `looking for ${short(input.pattern, 40)}` }
    case 'WebFetch': return { kind: 'Web', text: `fetching ${short(input.url, 50)}` }
    case 'WebSearch': return { kind: 'Web', text: `searching the web for ${short(input.query, 40)}` }
    case 'Agent': case 'Task': return { kind: 'Agent', text: `sending a helper: ${short(input.description, 40)}` }
    case 'TodoWrite': return { kind: 'Plan', text: 'planning the next steps' }
    case 'AskUserQuestion': return { kind: 'Ask', text: 'asking you a question' }
  }
  if (tool.startsWith('mcp__')) {
    const [, server = 'mcp', name = ''] = tool.split('__')
    return { kind: `MCP:${server}`, text: `using ${server} ${name.replace(/[_-]/g, ' ')}`.trim() }
  }
  return { kind: tool, text: `using ${tool}` }
}

export const THINKING: Activity = { kind: 'Think', text: 'thinking it over' }

export function buildPrompt(args: {
  columns: number
  rows: number
  doing: string
  recent: string[]
  userPrompt: string
  lastError?: string
  previousCaption?: string
}): string {
  const lines = [
    `The strip is ${args.columns} cells wide and ${args.rows} tall.`,
    `The agent is ${args.doing}.`,
  ]
  if (args.recent.length) lines.push(`Just before that it was: ${args.recent.join('; ')}.`)
  if (args.userPrompt) lines.push(`The person asked it: "${short(args.userPrompt, 200)}"`)
  if (args.previousCaption) lines.push(`The last cartoon was "${args.previousCaption}"; make this one different.`)
  if (args.lastError) lines.push(`Your last program failed with: ${args.lastError}. Avoid that this time.`)
  lines.push('Draw a cartoon of what the agent is doing now.')
  return lines.join('\n')
}
