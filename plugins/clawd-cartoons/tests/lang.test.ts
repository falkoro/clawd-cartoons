import { expect, test } from 'claude-code/testing'

import { BudgetError, LIMITS, Machine, SceneError } from '../hooks/lang'

// Runs a program's setup (and one frame when asked) and returns what it logged
function run(src: string, frames = 0): unknown[] {
  const out: unknown[] = []
  const m = new Machine(src, { log: (...a: unknown[]) => out.push(a.length === 1 ? a[0] : a) })
  m.setup()
  for (let i = 0; i < frames; i++) m.frame(i / 20)
  return out
}

function errorOf(src: string, frames = 0): Error | undefined {
  try {
    run(src, frames)
  } catch (e) {
    return e as Error
  }
  return undefined
}

test('runs the JavaScript subset scenes are written in', () => {
  expect(run(`
    const fib = n => n < 2 ? n : fib(n - 1) + fib(n - 2)
    log(fib(15))
    let o = { a: 1, list: [3, 1, 2], twice(x) { return x * 2 } }
    log(o.twice(o.a + 1), o.list.slice().sort((a, b) => a - b).join(','), \`n=\${o.list.length}\`)
    const [p, q] = [5, 6]
    const { a } = o
    log(p + q + a, typeof missing, 7 % 4, 2 ** 3, 5 >> 1, null ?? 'd', 0 || 'e', 1 && 'f')
    let s = 0
    for (let i = 0; i < 10; i++) { if (i === 3) continue; if (i > 6) break; s += i }
    log(s)
    let w = 0
    while (w < 5) w++
    do { w-- } while (w > 2)
    log(w)
    for (const k in o) log(k)
    for (const c of 'hi') log(c)
    switch (p) { case 5: log('five') case 6: log('six'); break; default: log('none') }
    log(Array.from({ length: 3 }, (_, i) => i * i), Object.keys({ x: 1, y: 2 }), Math.max(1, 9, 4))
    log([1, 2, 3, 4].filter(x => x % 2).map(x => x * 10).reduce((a, b) => a + b, 0))
    log('Hello'.toUpperCase().padStart(7, '*'), 'a,b'.split(','), (3.14159).toFixed(2))
  `)).toEqual([
    610,
    [4, '1,2,3', 'n=3'],
    [12, 'undefined', 3, 8, 2, 'd', 'e', 'f'],
    18,
    2,
    'a', 'list', 'twice',
    'h', 'i',
    'five', 'six',
    [[0, 1, 4], ['x', 'y'], 9],
    40,
    ['**HELLO', ['a', 'b'], '3.14'],
  ])
})

test('closures made in a for loop keep their own iteration', () => {
  expect(run('const fs = []; for (let i = 0; i < 3; i++) fs.push(() => i); log(fs.map(f => f()))')).toEqual([[0, 1, 2]])
})

test('setup runs once, then draw(t) every frame, keeping state', () => {
  expect(run('let n = 0; log("setup"); function draw(t) { n++; log(n) }', 3)).toEqual(['setup', 1, 2, 3])
})

test('a program without draw runs whole every frame, fresh each time', () => {
  expect(run('let n = 0; n++; log(n)', 2)).toEqual([1, 1, 1])
})

test('an endless loop runs out of steps instead of hanging', () => {
  const e = errorOf('while (true) {}')
  expect(e instanceof BudgetError).toBe(true)
  expect(e!.message).toMatch(/line 1: ran out of steps/)
  const inDraw = errorOf('function draw() { for (;;) {} }', 1)
  expect(inDraw instanceof BudgetError).toBe(true)
  expect(inDraw!.message).toMatch(/per frame/)
})

test('each frame gets a fresh budget', () => {
  // ~200k steps a frame fits one frame's budget, many frames in a row
  expect(errorOf('function draw() { let s = 0; for (let i = 0; i < 40000; i++) s += i }', 5)).toBeUndefined()
})

test('drawing work counts against the budget', () => {
  const m = new Machine('function draw() { for (;;) paint() }', { paint: () => m.charge(10_000) })
  m.setup()
  let err: unknown
  try {
    m.frame(0)
  } catch (e) {
    err = e
  }
  expect(err instanceof BudgetError).toBe(true)
})

test('recursion is cut off before the host stack', () => {
  const e = errorOf('function f(n) { return f(n + 1) } f(0)')
  expect(e!.message).toMatch(/too much recursion \(more than 64 calls deep\)/)
  expect(errorOf('const f = n => n ? f(n - 1) : 0; f(50)')).toBeUndefined()
})

test('huge arrays and strings are refused', () => {
  expect(errorOf('const a = []; for (;;) a.push(1)')!.message).toMatch(/array longer than 10,000/)
  expect(errorOf('Array.from({ length: 1e9 })')!.message).toMatch(/array longer than 10,000/)
  expect(errorOf('const a = []; a[5e6] = 1')!.message).toMatch(/out of range/)
  expect(errorOf('"ab".repeat(1e8)')!.message).toMatch(/string longer than 10,000/)
  expect(errorOf('let s = "x"; for (;;) s = s + s')!.message).toMatch(/string longer than 10,000/)
  expect(errorOf('let s = "x"; for (;;) s = `${s}${s}`')!.message).toMatch(/string longer than 10,000/)
})

test('an unterminated unicode escape is an error, not a hang', () => {
  expect(errorOf('const s = "\\u{1F60"')!.message).toMatch(/unclosed \\u\{ escape/)
  expect(errorOf('const s = `a\\u{1F60`')!.message).toMatch(/unclosed \\u\{ escape/)
  expect(errorOf('const s = "\\')).toBeInstanceOf(SceneError)
  expect(errorOf('const s = "\\u{1F60}"')).toBeUndefined()
})

test('join refuses an oversized result before building it', () => {
  const e = errorOf('const s = "x".repeat(9000); const a = Array.from({ length: 9000 }, () => s); a.join("")')
  expect(e).toBeInstanceOf(SceneError)
  expect(errorOf('[1, 2, 3].join("-")')).toBeUndefined()
})

test('making too much in one frame is refused', () => {
  const e = errorOf(`function draw() { for (let i = 0; i < 100; i++) Array.from({ length: 5000 }) }`, 1)
  expect(e!.message).toMatch(/in one frame/)
})

test('a program that keeps making things restarts its setup', () => {
  const out: unknown[] = []
  const m = new Machine('log("setup"); function draw() { Array.from({ length: 9000 }) }', { log: (x: unknown) => out.push(x) })
  m.setup()
  const frames = Math.ceil(LIMITS.lifetimeAlloc / 9000) + 2
  for (let i = 0; i < frames; i++) m.frame(i)
  expect(out.length).toBe(2)
})

test('bad programs get errors with a line number and a hint', () => {
  const cases: [string, RegExp][] = [
    ['let x =', /line 1: unexpected token, found the end of the program/],
    ['\n\nfoo(', /line 3: /],
    ['new Thing()', /"new" is not supported: use Array.from/],
    ['class A {}', /classes are not supported/],
    ['this.x = 1', /"this" is not supported/],
    ['try { } catch (e) { }', /try\/catch is not supported/],
    ['import x from "y"', /imports are not supported/],
    ['f(...xs)', /spread/],
    ['a?.b', /optional chaining/],
    ['nope()', /nope is not defined/],
    ['let a = 1; a()', /a is not a function/],
    ['let a = null; a.b', /cannot read "b" of null/],
    ['"unclosed', /unclosed string/],
    ['let x = #', /unexpected character "#"/],
    ['1 = 2', /can only assign/],
  ]
  for (const [src, re] of cases) {
    const e = errorOf(src)
    expect(e instanceof SceneError, src).toBe(true)
    expect(e!.message, src).toMatch(re)
  }
})

test('a program cannot reach the host through prototypes or functions', () => {
  expect(run('log(({}).constructor, [].constructor, "s".constructor, ({}).__proto__)')).toEqual([[undefined, undefined, undefined, undefined]])
  expect(errorOf('const m = [].map; m(x => x)')!.message).toMatch(/methods can't be stored/)
  expect(run('log(log.constructor, Math.floor.call)')).toEqual([[undefined, undefined]])
  expect(errorOf('Math.constructor.constructor("return 1")()')!.message).toMatch(/cannot read|not a function/)
  expect(run('let o = {}; o.__proto__ = { x: 1 }; log(o.x)')).toEqual([undefined])
  expect(errorOf('globalThis')!.message).toMatch(/globalThis is not defined/)
  expect(errorOf('eval("1")')!.message).toMatch(/eval is not defined/)
})

test('assigning an undeclared name makes a program-wide variable, never a builtin', () => {
  expect(run('function f() { made = 3 } f(); log(made); Math = 1; log(typeof Math)')).toEqual([3, 'number'])
  expect(run('log(typeof Math.floor)')).toEqual(['function'])
})
