// The scene language: a small JavaScript subset that model-written scenes are
// written in, run by this tree-walking interpreter. Mods can't eval, and a
// separate process would run code the model wrote after reading your repo, so
// a program here touches nothing but its own values and the functions the
// host hands it. Every step is counted against a budget, and arrays, strings
// and recursion are bounded, so a bad program stops itself instead of
// freezing the terminal.

export class SceneError extends Error {}
export class BudgetError extends SceneError {}

export const LIMITS = {
  frameSteps: 300_000, // steps one draw() call may take
  setupSteps: 1_000_000, // steps the top-level code may take
  frameAlloc: 200_000, // array items and string characters made in one frame
  lifetimeAlloc: 20_000_000, // made since setup; past it the program restarts
  arrayLength: 10_000,
  stringLength: 10_000,
  callDepth: 64,
}

// ---------- tokens ----------

type Tok = { t: 'num' | 'str' | 'tpl' | 'id' | 'kw' | 'op' | 'eof'; v: any; line: number }

const KEYWORDS = new Set([
  'let', 'const', 'var', 'function', 'return', 'if', 'else', 'for', 'of', 'in', 'while', 'do', 'break',
  'continue', 'switch', 'case', 'default', 'true', 'false', 'null', 'undefined', 'typeof', 'new', 'class',
  'this', 'import', 'export', 'async', 'await', 'yield', 'delete', 'try', 'catch', 'throw',
])
const UNSUPPORTED: Record<string, string> = {
  new: '"new" is not supported: use Array.from({length: n}, fn) or a plain object',
  class: 'classes are not supported: use plain objects and functions',
  this: '"this" is not supported: pass the object as an argument',
  import: 'imports are not supported', export: 'exports are not supported',
  async: 'async code is not supported', await: 'async code is not supported', yield: 'generators are not supported',
  delete: '"delete" is not supported', try: 'try/catch is not supported', catch: 'try/catch is not supported',
  throw: '"throw" is not supported',
}
const PUNCT = [
  '>>>=', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '...', '=>', '==', '!=', '<=', '>=',
  '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
]
const SINGLE = '{}()[];,.?:+-*/%<>=!~&|^'
const NUM = /0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y
const IDENT = /[A-Za-z_$][\w$]*/y
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }

function fail(msg: string, line: number): never {
  throw new SceneError(`line ${line}: ${msg}`)
}

function tokenize(src: string, line = 1): Tok[] {
  const out: Tok[] = []
  let i = 0
  const n = src.length
  const escape = (): string => {
    const c = src[i + 1]!
    i += 2
    if (c in ESCAPES) return ESCAPES[c]!
    if (c === 'x') return String.fromCharCode(parseInt(src.slice(i, (i += 2)), 16) || 0)
    if (c === 'u') {
      if (src[i] === '{') {
        const e = src.indexOf('}', i)
        const s = src.slice(i + 1, e)
        i = e + 1
        return String.fromCodePoint(Math.min(0x10ffff, parseInt(s, 16) || 0))
      }
      return String.fromCharCode(parseInt(src.slice(i, (i += 4)), 16) || 0)
    }
    if (c === '\n') {
      line++
      return ''
    }
    return c
  }
  while (i < n) {
    const c = src[i]!
    if (c === '\n') {
      line++
      i++
    } else if (c === ' ' || c === '\t' || c === '\r') {
      i++
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++
    } else if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2)
      if (e < 0) fail('unclosed comment', line)
      for (; i < e + 2; i++) if (src[i] === '\n') line++
    } else if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1]! >= '0' && src[i + 1]! <= '9')) {
      NUM.lastIndex = i
      const m = NUM.exec(src)![0]
      out.push({ t: 'num', v: Number(m), line })
      i += m.length
    } else if (/[A-Za-z_$]/.test(c)) {
      IDENT.lastIndex = i
      const m = IDENT.exec(src)![0]
      out.push({ t: KEYWORDS.has(m) ? 'kw' : 'id', v: m, line })
      i += m.length
    } else if (c === '"' || c === "'") {
      let s = ''
      i++
      while (src[i] !== c) {
        if (i >= n || src[i] === '\n') fail('unclosed string', line)
        if (src[i] === '\\') s += escape()
        else s += src[i++]
      }
      i++
      out.push({ t: 'str', v: s, line })
    } else if (c === '`') {
      const startLine = line
      const parts: string[] = []
      const exprs: { src: string; line: number }[] = []
      let s = ''
      i++
      for (;;) {
        if (i >= n) fail('unclosed template literal', startLine)
        const d = src[i]!
        if (d === '`') break
        if (d === '\\') {
          s += escape()
        } else if (d === '$' && src[i + 1] === '{') {
          const exprLine = line
          let depth = 1
          let j = i + 2
          while (j < n && depth > 0) {
            const e = src[j]!
            if (e === '{') depth++
            else if (e === '}') depth--
            else if (e === '\n') line++
            else if (e === '"' || e === "'") {
              j++
              while (j < n && src[j] !== e) j += src[j] === '\\' ? 2 : 1
            }
            j++
          }
          if (depth > 0) fail('unclosed ${ in template literal', exprLine)
          parts.push(s)
          s = ''
          exprs.push({ src: src.slice(i + 2, j - 1), line: exprLine })
          i = j
        } else {
          if (d === '\n') line++
          s += d
          i++
        }
      }
      i++
      parts.push(s)
      out.push({ t: 'tpl', v: { parts, exprs }, line: startLine })
    } else {
      const p = PUNCT.find((q) => src.startsWith(q, i))
      if (p) {
        out.push({ t: 'op', v: p, line })
        i += p.length
      } else if (SINGLE.includes(c)) {
        out.push({ t: 'op', v: c, line })
        i++
      } else {
        fail(`unexpected character ${JSON.stringify(c)}`, line)
      }
    }
  }
  out.push({ t: 'eof', v: null, line })
  return out
}

// ---------- syntax tree ----------

export type Node = { k: string; line: number; [field: string]: any }

const PREC: Record<string, number> = {
  '??': 1, '||': 2, '&&': 3, '|': 4, '^': 5, '&': 6, '==': 7, '!=': 7, '===': 7, '!==': 7,
  '<': 8, '>': 8, '<=': 8, '>=': 8, '<<': 9, '>>': 9, '>>>': 9, '+': 10, '-': 10, '*': 11, '/': 11, '%': 11, '**': 12,
}
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??='])

class Parser {
  private pos = 0
  private readonly toks: Tok[]
  constructor(toks: Tok[]) {
    this.toks = toks
  }

  private peek(o = 0): Tok {
    return this.toks[Math.min(this.pos + o, this.toks.length - 1)]!
  }
  private is(v: string, o = 0): boolean {
    const t = this.peek(o)
    return (t.t === 'op' || t.t === 'kw') && t.v === v
  }
  private eat(v: string): boolean {
    if (!this.is(v)) return false
    this.pos++
    return true
  }
  private expect(v: string): Tok {
    if (!this.is(v)) this.unexpected(`expected "${v}"`)
    return this.toks[this.pos++]!
  }
  private unexpected(why = 'unexpected token'): never {
    const t = this.peek()
    if (t.t === 'kw' && t.v in UNSUPPORTED) fail(UNSUPPORTED[t.v]!, t.line)
    if (t.t === 'op' && t.v === '...') fail('spread ("...") is not supported', t.line)
    if (t.t === 'op' && t.v === '?.') fail('optional chaining ("?.") is not supported', t.line)
    fail(`${why}, found ${t.t === 'eof' ? 'the end of the program' : JSON.stringify(String(t.v))}`, t.line)
  }
  private name(): string {
    const t = this.peek()
    if (t.t !== 'id') this.unexpected('expected a name')
    this.pos++
    return t.v
  }

  program(): Node[] {
    const body: Node[] = []
    while (this.peek().t !== 'eof') body.push(this.statement())
    return body
  }

  private block(): Node {
    const line = this.expect('{').line
    const body: Node[] = []
    while (!this.is('}')) {
      if (this.peek().t === 'eof') this.unexpected('expected "}"')
      body.push(this.statement())
    }
    this.pos++
    return { k: 'block', line, body, scoped: body.some((s) => s.k === 'var' || s.k === 'fun') }
  }

  private statement(): Node {
    const t = this.peek()
    const line = t.line
    if (t.t === 'op' && t.v === '{') return this.block()
    if (t.t === 'op' && t.v === ';') {
      this.pos++
      return { k: 'empty', line }
    }
    if (t.t === 'kw') {
      switch (t.v) {
        case 'let': case 'const': case 'var': {
          this.pos++
          const s = this.declarations(t.v, line)
          this.eat(';')
          return s
        }
        case 'function':
          if (this.peek(1).t === 'id') {
            this.pos++
            const name = this.name()
            return { k: 'fun', line, name, fn: this.functionRest(name, line) }
          }
          break
        case 'if': {
          this.pos++
          this.expect('(')
          const test = this.expression()
          this.expect(')')
          const then = this.statement()
          const otherwise = this.eat('else') ? this.statement() : null
          return { k: 'if', line, test, then, otherwise }
        }
        case 'for': return this.forStatement()
        case 'while': {
          this.pos++
          this.expect('(')
          const test = this.expression()
          this.expect(')')
          return { k: 'while', line, test, body: this.statement() }
        }
        case 'do': {
          this.pos++
          const body = this.statement()
          this.expect('while')
          this.expect('(')
          const test = this.expression()
          this.expect(')')
          this.eat(';')
          return { k: 'do', line, body, test }
        }
        case 'break': case 'continue':
          this.pos++
          this.eat(';')
          return { k: t.v, line }
        case 'return': {
          this.pos++
          const end = this.is(';') || this.is('}') || this.peek().t === 'eof' || this.peek().line !== line
          const arg = end ? null : this.expression()
          this.eat(';')
          return { k: 'return', line, arg }
        }
        case 'switch': return this.switchStatement()
      }
    }
    const e = this.expression()
    this.eat(';')
    return { k: 'expr', line, e }
  }

  // A name, or a flat [a, b] / {x, y} pattern
  private target(): Node {
    const line = this.peek().line
    if (this.eat('[') || this.is('{')) {
      const isArray = this.toks[this.pos - 1]!.v === '['
      if (!isArray) this.pos++
      const names: (string | null)[] = []
      while (!this.is(isArray ? ']' : '}')) {
        if (isArray && this.is(',')) names.push(null)
        else names.push(this.name())
        if (!this.eat(',')) break
      }
      this.expect(isArray ? ']' : '}')
      return { k: 'pattern', line, isArray, names }
    }
    return { k: 'id', line, name: this.name() }
  }

  private declarations(kind: string, line: number, first?: Node): Node {
    const decls: { target: Node; init: Node | null }[] = []
    do {
      const target = first ?? this.target()
      first = undefined
      const init = this.eat('=') ? this.assignment() : null
      decls.push({ target, init })
    } while (this.eat(','))
    return { k: 'var', line, kind, decls }
  }

  private forStatement(): Node {
    const line = this.expect('for').line
    this.expect('(')
    let init: Node | null = null
    const kw = this.peek()
    if (kw.t === 'kw' && (kw.v === 'let' || kw.v === 'const' || kw.v === 'var')) {
      this.pos++
      const target = this.target()
      if (this.is('of') || this.is('in')) {
        const of = this.toks[this.pos++]!.v === 'of'
        const iter = this.expression()
        this.expect(')')
        return { k: of ? 'forOf' : 'forIn', line, kind: kw.v, target, iter, body: this.statement() }
      }
      init = this.declarations(kw.v, line, target)
    } else if (!this.is(';')) {
      if (this.peek().t === 'id' && (this.is('of', 1) || this.is('in', 1))) {
        const target: Node = { k: 'id', line, name: this.name() }
        const of = this.toks[this.pos++]!.v === 'of'
        const iter = this.expression()
        this.expect(')')
        return { k: of ? 'forOf' : 'forIn', line, kind: 'assign', target, iter, body: this.statement() }
      }
      init = { k: 'expr', line, e: this.expression() }
    }
    this.expect(';')
    const test = this.is(';') ? null : this.expression()
    this.expect(';')
    const update = this.is(')') ? null : this.expression()
    this.expect(')')
    return { k: 'for', line, init, test, update, body: this.statement() }
  }

  private switchStatement(): Node {
    const line = this.expect('switch').line
    this.expect('(')
    const disc = this.expression()
    this.expect(')')
    this.expect('{')
    const cases: { test: Node | null; body: Node[] }[] = []
    while (!this.eat('}')) {
      let test: Node | null = null
      if (this.eat('case')) test = this.expression()
      else this.expect('default')
      this.expect(':')
      const body: Node[] = []
      while (!this.is('case') && !this.is('default') && !this.is('}')) {
        if (this.peek().t === 'eof') this.unexpected('expected "}"')
        body.push(this.statement())
      }
      cases.push({ test, body })
    }
    return { k: 'switch', line, disc, cases }
  }

  private params(): { name: string; def: Node | null }[] {
    this.expect('(')
    const out: { name: string; def: Node | null }[] = []
    while (!this.is(')')) {
      const name = this.name()
      out.push({ name, def: this.eat('=') ? this.assignment() : null })
      if (!this.eat(',')) break
    }
    this.expect(')')
    return out
  }

  private functionRest(name: string, line: number): Node {
    const params = this.params()
    return { k: 'function', line, name, params, body: this.block().body, isExpr: false }
  }

  expression(): Node {
    const e = this.assignment()
    if (!this.is(',')) return e
    const list = [e]
    while (this.eat(',')) list.push(this.assignment())
    return { k: 'seq', line: e.line, list }
  }

  // Is the "(" here the start of an arrow function's parameters?
  private arrowAhead(): boolean {
    let depth = 0
    for (let j = this.pos; j < this.toks.length; j++) {
      const t = this.toks[j]!
      if (t.t === 'op' && (t.v === '(' || t.v === '[' || t.v === '{')) depth++
      else if (t.t === 'op' && (t.v === ')' || t.v === ']' || t.v === '}')) {
        if (--depth === 0) {
          const after = this.toks[j + 1]
          return !!after && after.t === 'op' && after.v === '=>'
        }
      } else if (t.t === 'eof') return false
    }
    return false
  }

  private arrow(params: { name: string; def: Node | null }[], line: number): Node {
    this.expect('=>')
    if (this.is('{')) return { k: 'function', line, name: '', params, body: this.block().body, isExpr: false }
    return { k: 'function', line, name: '', params, body: this.assignment(), isExpr: true }
  }

  private assignment(): Node {
    const t = this.peek()
    if (t.t === 'id' && this.is('=>', 1)) {
      this.pos++
      return this.arrow([{ name: t.v, def: null }], t.line)
    }
    if (t.t === 'op' && t.v === '(' && this.arrowAhead()) return this.arrow(this.params(), t.line)
    const left = this.conditional()
    const op = this.peek()
    if (op.t === 'op' && ASSIGN.has(op.v)) {
      if (left.k !== 'id' && left.k !== 'member') fail('can only assign to a variable or a property', op.line)
      this.pos++
      return { k: 'assign', line: op.line, op: op.v, target: left, value: this.assignment() }
    }
    return left
  }

  private conditional(): Node {
    const test = this.binary(0)
    if (!this.is('?')) return test
    const line = this.expect('?').line
    const then = this.assignment()
    this.expect(':')
    return { k: 'cond', line, test, then, otherwise: this.assignment() }
  }

  private binary(min: number): Node {
    let left = this.unary()
    for (;;) {
      const t = this.peek()
      const p = t.t === 'op' ? PREC[t.v] : undefined
      if (!p || p <= min) return left
      this.pos++
      const right = t.v === '**' ? this.binary(p - 1) : this.binary(p)
      const logical = t.v === '&&' || t.v === '||' || t.v === '??'
      left = { k: logical ? 'logical' : 'binary', line: t.line, op: t.v, a: left, b: right }
    }
  }

  private unary(): Node {
    const t = this.peek()
    if (t.t === 'op' && (t.v === '!' || t.v === '-' || t.v === '+' || t.v === '~')) {
      this.pos++
      return { k: 'unary', line: t.line, op: t.v, a: this.unary() }
    }
    if (t.t === 'kw' && t.v === 'typeof') {
      this.pos++
      return { k: 'unary', line: t.line, op: 'typeof', a: this.unary() }
    }
    if (t.t === 'op' && (t.v === '++' || t.v === '--')) {
      this.pos++
      const target = this.unary()
      if (target.k !== 'id' && target.k !== 'member') fail(`"${t.v}" needs a variable or a property`, t.line)
      return { k: 'update', line: t.line, op: t.v, prefix: true, target }
    }
    const e = this.callOrMember()
    const p = this.peek()
    if (p.t === 'op' && (p.v === '++' || p.v === '--') && p.line === e.line) {
      if (e.k !== 'id' && e.k !== 'member') fail(`"${p.v}" needs a variable or a property`, p.line)
      this.pos++
      return { k: 'update', line: p.line, op: p.v, prefix: false, target: e }
    }
    return e
  }

  private callOrMember(): Node {
    let e = this.primary()
    for (;;) {
      const t = this.peek()
      if (t.t !== 'op') return e
      if (t.v === '.') {
        this.pos++
        const p = this.peek()
        if (p.t !== 'id' && p.t !== 'kw') this.unexpected('expected a property name')
        this.pos++
        e = { k: 'member', line: t.line, obj: e, prop: { k: 'str', line: p.line, v: p.v } }
      } else if (t.v === '[') {
        this.pos++
        e = { k: 'member', line: t.line, obj: e, prop: this.expression() }
        this.expect(']')
      } else if (t.v === '(') {
        this.pos++
        const args: Node[] = []
        while (!this.is(')')) {
          args.push(this.assignment())
          if (!this.eat(',')) break
        }
        this.expect(')')
        e = { k: 'call', line: t.line, callee: e, args }
      } else {
        return e
      }
    }
  }

  private primary(): Node {
    const t = this.peek()
    const line = t.line
    switch (t.t) {
      case 'num': case 'str':
        this.pos++
        return { k: 'str', line, v: t.v }
      case 'tpl': {
        this.pos++
        const exprs = t.v.exprs.map((x: { src: string; line: number }) => {
          const p = new Parser(tokenize(x.src, x.line))
          const e = p.expression()
          if (p.peek().t !== 'eof') p.unexpected()
          return e
        })
        return { k: 'template', line, parts: t.v.parts, exprs }
      }
      case 'id':
        this.pos++
        return { k: 'id', line, name: t.v }
      case 'kw':
        if (t.v === 'true' || t.v === 'false' || t.v === 'null' || t.v === 'undefined') {
          this.pos++
          return { k: 'str', line, v: t.v === 'true' ? true : t.v === 'false' ? false : t.v === 'null' ? null : undefined }
        }
        if (t.v === 'function') {
          this.pos++
          const name = this.peek().t === 'id' ? this.name() : ''
          return this.functionRest(name, line)
        }
        break
      case 'op':
        if (t.v === '(') {
          this.pos++
          const e = this.expression()
          this.expect(')')
          return e
        }
        if (t.v === '[') {
          this.pos++
          const items: Node[] = []
          while (!this.is(']')) {
            items.push(this.assignment())
            if (!this.eat(',')) break
          }
          this.expect(']')
          return { k: 'array', line, items }
        }
        if (t.v === '{') return this.objectLiteral()
        break
    }
    this.unexpected()
  }

  private objectLiteral(): Node {
    const line = this.expect('{').line
    const props: { key: Node; value: Node }[] = []
    while (!this.is('}')) {
      const t = this.peek()
      let key: Node
      if (t.t === 'op' && t.v === '[') {
        this.pos++
        key = this.assignment()
        this.expect(']')
      } else if (t.t === 'id' || t.t === 'kw' || t.t === 'str' || t.t === 'num') {
        this.pos++
        key = { k: 'str', line: t.line, v: String(t.v) }
      } else {
        this.unexpected('expected a property name')
      }
      if (this.eat(':')) props.push({ key, value: this.assignment() })
      else if (this.is('(')) props.push({ key, value: this.functionRest(String(key.v), t.line) })
      else if (t.t === 'id') props.push({ key, value: { k: 'id', line: t.line, name: t.v } })
      else this.unexpected('expected ":"')
      if (!this.eat(',')) break
    }
    this.expect('}')
    return { k: 'object', line, props }
  }
}

export function parse(src: string): Node[] {
  return new Parser(tokenize(src)).program()
}

// ---------- running ----------

class Scope {
  readonly vars = new Map<string, unknown>()
  readonly parent: Scope | null
  constructor(parent: Scope | null) {
    this.parent = parent
  }
}

class Closure {
  readonly fn: Node
  readonly scope: Scope
  constructor(fn: Node, scope: Scope) {
    this.fn = fn
    this.scope = scope
  }
}

export type Native = (...args: any[]) => unknown

const NORMAL = 0, BREAK = 1, CONTINUE = 2, RETURN = 3

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Closure)

// A plain object with no prototype, so nothing a program reads can reach the host
function record(): Record<string, unknown> {
  return Object.create(null)
}

export class Machine {
  private steps = 0
  private budget = LIMITS.setupSteps
  private alloc = 0
  private lifetime = 0
  private depth = 0
  private line = 0
  private closures = 0
  private retVal: unknown = undefined
  private readonly natives = new WeakSet<Function>()
  private readonly builtins = new Scope(null)
  private program!: Scope
  private readonly ast: Node[]

  constructor(source: string, globals: Record<string, unknown>) {
    this.ast = parse(source)
    for (const [k, v] of Object.entries(globals)) this.builtins.vars.set(k, this.adopt(v))
    this.builtins.vars.set('Math', this.adopt(mathObject()))
    this.builtins.vars.set('Array', this.adopt({ from: this.arrayFrom, isArray: (v: unknown) => Array.isArray(v) }))
    this.builtins.vars.set('Object', this.adopt({
      keys: (o: unknown) => this.made(isObject(o) || Array.isArray(o) ? Object.keys(o) : []),
      values: (o: unknown) => this.made(isObject(o) || Array.isArray(o) ? Object.values(o) : []),
      entries: (o: unknown) => this.made(isObject(o) || Array.isArray(o) ? Object.entries(o) : []),
    }))
    for (const [k, v] of Object.entries(SIMPLE_GLOBALS)) this.builtins.vars.set(k, this.adopt(v))
  }

  // Marks host functions (and those inside a host object) as callable natives
  private adopt(v: unknown): unknown {
    if (typeof v === 'function') {
      this.natives.add(v)
      return v
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = record()
      for (const [k, x] of Object.entries(v)) o[k] = this.adopt(x)
      return o
    }
    return v
  }

  setGlobal(name: string, value: unknown) {
    this.builtins.vars.set(name, value)
  }

  // Charge drawing work done by a native against this frame's budget
  charge(n: number) {
    this.steps += n
    if (this.steps > this.budget) this.overBudget()
  }

  private overBudget(): never {
    throw new BudgetError(`line ${this.line}: ran out of steps (${this.budget.toLocaleString('en-US')} per ${this.budget === LIMITS.setupSteps ? 'setup' : 'frame'}): a loop that never ends, or too much work per frame`)
  }

  private grow(n: number) {
    this.alloc += n
    this.lifetime += n
    if (this.alloc > LIMITS.frameAlloc) throw new SceneError(`line ${this.line}: made more than ${LIMITS.frameAlloc.toLocaleString('en-US')} array items and characters in one frame`)
  }

  private made<T extends unknown[]>(a: T): T {
    this.grow(a.length)
    if (a.length > LIMITS.arrayLength) throw new SceneError(`line ${this.line}: array longer than ${LIMITS.arrayLength.toLocaleString('en-US')} items`)
    return a
  }

  private str(s: string): string {
    if (s.length > LIMITS.stringLength) throw new SceneError(`line ${this.line}: string longer than ${LIMITS.stringLength.toLocaleString('en-US')} characters`)
    this.grow(s.length)
    return s
  }

  private run<T>(budget: number, f: () => T): T {
    this.steps = 0
    this.alloc = 0
    this.depth = 0
    this.budget = budget
    try {
      return f()
    } catch (e) {
      if (e instanceof SceneError) throw e
      // A host error (a bad color, a stack overflow) carries no line of its own
      throw new SceneError(`line ${this.line}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Runs the top-level code once
  setup() {
    this.program = new Scope(this.builtins)
    this.lifetime = 0
    this.run(LIMITS.setupSteps, () => this.execList(this.ast, this.program))
  }

  // Draws one frame: calls draw(t), or reruns the whole program when there is none
  frame(t: number) {
    if (this.lifetime > LIMITS.lifetimeAlloc) this.setup()
    const draw = this.program.vars.get('draw')
    if (draw instanceof Closure) this.run(LIMITS.frameSteps, () => this.call(draw, [t]))
    else this.run(LIMITS.frameSteps, () => this.execList(this.ast, new Scope(this.builtins)))
  }

  steps_(): number {
    return this.steps
  }

  // ----- statements -----

  private execList(list: Node[], scope: Scope): number {
    for (const s of list) if (s.k === 'fun') scope.vars.set(s.name, this.closure(s.fn, scope))
    for (const s of list) {
      const r = this.exec(s, scope)
      if (r !== NORMAL) return r
    }
    return NORMAL
  }

  private exec(n: Node, scope: Scope): number {
    if (++this.steps > this.budget) this.overBudget()
    this.line = n.line
    switch (n.k) {
      case 'expr':
        this.value(n.e, scope)
        return NORMAL
      case 'var':
        for (const d of n.decls) this.bind(d.target, d.init ? this.value(d.init, scope) : undefined, scope, true)
        return NORMAL
      case 'fun': case 'empty':
        return NORMAL
      case 'block':
        return this.execList(n.body, n.scoped ? new Scope(scope) : scope)
      case 'if':
        if (this.value(n.test, scope)) return this.exec(n.then, scope)
        return n.otherwise ? this.exec(n.otherwise, scope) : NORMAL
      case 'for': {
        let loop = new Scope(scope)
        const perIteration = n.init?.k === 'var' && n.init.kind !== 'var'
        if (n.init) this.exec(n.init, loop)
        for (;;) {
          if (n.test && !this.value(n.test, loop)) break
          const made = this.closures
          const r = this.exec(n.body, loop)
          if (r === BREAK) break
          if (r === RETURN) return r
          // Each iteration gets its own copy of `let` variables, so closures
          // made inside the body keep the value they saw
          if (perIteration && this.closures !== made) {
            const next = new Scope(scope)
            for (const [k, v] of loop.vars) next.vars.set(k, v)
            loop = next
          }
          if (n.update) this.value(n.update, loop)
        }
        return NORMAL
      }
      case 'forOf': case 'forIn': {
        const iter = this.value(n.iter, scope)
        let items: unknown[]
        if (n.k === 'forIn') items = iter !== null && typeof iter === 'object' ? Object.keys(iter as object) : []
        else if (Array.isArray(iter)) items = iter
        else if (typeof iter === 'string') items = [...iter]
        else throw new SceneError(`line ${n.line}: can only loop "of" an array or a string`)
        for (const item of items) {
          const s = n.kind === 'assign' ? scope : new Scope(scope)
          if (n.kind === 'assign') this.assignTo(n.target, item, scope)
          else this.bind(n.target, item, s, true)
          const r = this.exec(n.body, s)
          if (r === BREAK) break
          if (r === RETURN) return r
        }
        return NORMAL
      }
      case 'while':
        while (this.value(n.test, scope)) {
          const r = this.exec(n.body, scope)
          if (r === BREAK) break
          if (r === RETURN) return r
        }
        return NORMAL
      case 'do':
        do {
          const r = this.exec(n.body, scope)
          if (r === BREAK) break
          if (r === RETURN) return r
        } while (this.value(n.test, scope))
        return NORMAL
      case 'break':
        return BREAK
      case 'continue':
        return CONTINUE
      case 'return':
        this.retVal = n.arg ? this.value(n.arg, scope) : undefined
        return RETURN
      case 'switch': {
        const v = this.value(n.disc, scope)
        const inner = new Scope(scope)
        let start = n.cases.findIndex((c: { test: Node | null }) => c.test && this.value(c.test, scope) === v)
        if (start < 0) start = n.cases.findIndex((c: { test: Node | null }) => !c.test)
        if (start < 0) return NORMAL
        for (let i = start; i < n.cases.length; i++) {
          const r = this.execList(n.cases[i].body, inner)
          if (r === BREAK) return NORMAL
          if (r !== NORMAL) return r
        }
        return NORMAL
      }
    }
    throw new SceneError(`line ${n.line}: cannot run a ${n.k} here`)
  }

  private bind(target: Node, value: unknown, scope: Scope, declare: boolean) {
    if (target.k === 'id') {
      if (declare) scope.vars.set(target.name, value)
      else this.assignName(target.name, value, scope)
      return
    }
    // A flat pattern: [a, b] reads by position, {x, y} by name
    for (let i = 0; i < target.names.length; i++) {
      const name = target.names[i]
      if (name === null) continue
      const v = target.isArray ? this.get(value, i) : this.get(value, name)
      if (declare) scope.vars.set(name, v)
      else this.assignName(name, v, scope)
    }
  }

  private assignName(name: string, value: unknown, scope: Scope) {
    for (let s: Scope | null = scope; s; s = s.parent) {
      if (s.vars.has(name)) {
        if (s === this.builtins) break
        s.vars.set(name, value)
        return
      }
    }
    // Assigning a name never declared makes a program-wide variable, as
    // JavaScript does outside strict mode; builtins are shadowed, not changed
    this.program.vars.set(name, value)
  }

  private assignTo(target: Node, value: unknown, scope: Scope) {
    if (target.k === 'id') return this.assignName(target.name, value, scope)
    if (target.k === 'pattern') return this.bind(target, value, scope, false)
    this.set(this.value(target.obj, scope), this.value(target.prop, scope), value)
  }

  // ----- expressions -----

  private lookup(name: string, scope: Scope): unknown {
    for (let s: Scope | null = scope; s; s = s.parent) {
      const v = s.vars.get(name)
      if (v !== undefined || s.vars.has(name)) return v
    }
    throw new SceneError(`line ${this.line}: ${name} is not defined`)
  }

  private closure(fn: Node, scope: Scope): Closure {
    this.closures++
    return new Closure(fn, scope)
  }

  private value(n: Node, scope: Scope): any {
    if (++this.steps > this.budget) this.overBudget()
    switch (n.k) {
      case 'str':
        return n.v
      case 'id':
        return this.lookup(n.name, scope)
      case 'binary':
        return this.binary(n.op, this.value(n.a, scope), this.value(n.b, scope))
      case 'logical': {
        const a = this.value(n.a, scope)
        if (n.op === '&&') return a ? this.value(n.b, scope) : a
        if (n.op === '||') return a ? a : this.value(n.b, scope)
        return a ?? this.value(n.b, scope)
      }
      case 'unary': {
        if (n.op === 'typeof') {
          if (n.a.k === 'id') {
            try {
              return typeName(this.lookup(n.a.name, scope))
            } catch {
              return 'undefined'
            }
          }
          return typeName(this.value(n.a, scope))
        }
        const a = this.value(n.a, scope)
        if (n.op === '!') return !a
        if (n.op === '-') return -num(a)
        if (n.op === '+') return num(a)
        return ~num(a)
      }
      case 'cond':
        return this.value(n.test, scope) ? this.value(n.then, scope) : this.value(n.otherwise, scope)
      case 'assign': {
        if (n.op === '=') {
          const v = this.value(n.value, scope)
          this.assignTo(n.target, v, scope)
          return v
        }
        const old = this.read(n.target, scope)
        let v: unknown
        if (n.op === '&&=') v = old ? this.value(n.value, scope) : old
        else if (n.op === '||=') v = old ? old : this.value(n.value, scope)
        else if (n.op === '??=') v = old ?? this.value(n.value, scope)
        else v = this.binary(n.op.slice(0, -1), old, this.value(n.value, scope))
        this.assignTo(n.target, v, scope)
        return v
      }
      case 'update': {
        const old = num(this.read(n.target, scope))
        const v = n.op === '++' ? old + 1 : old - 1
        this.assignTo(n.target, v, scope)
        return n.prefix ? v : old
      }
      case 'member':
        return this.get(this.value(n.obj, scope), this.value(n.prop, scope))
      case 'call':
        return this.callNode(n, scope)
      case 'array': {
        const out = n.items.map((x: Node) => this.value(x, scope))
        return this.made(out)
      }
      case 'object': {
        const o = record()
        for (const p of n.props) o[String(this.value(p.key, scope))] = this.value(p.value, scope)
        this.grow(n.props.length)
        return o
      }
      case 'function':
        return this.closure(n, scope)
      case 'template': {
        let s = n.parts[0]
        for (let i = 0; i < n.exprs.length; i++) s += this.toStr(this.value(n.exprs[i], scope)) + n.parts[i + 1]
        return this.str(s)
      }
      case 'seq': {
        let v: unknown
        for (const x of n.list) v = this.value(x, scope)
        return v
      }
    }
    throw new SceneError(`line ${n.line}: cannot evaluate a ${n.k}`)
  }

  private read(target: Node, scope: Scope): unknown {
    return target.k === 'id' ? this.lookup(target.name, scope) : this.get(this.value(target.obj, scope), this.value(target.prop, scope))
  }

  private toStr(v: unknown): string {
    if (v === null || typeof v !== 'object') return typeof v === 'function' ? 'function' : String(v)
    if (v instanceof Closure) return 'function'
    if (Array.isArray(v)) {
      let s = ''
      for (let i = 0; i < v.length; i++) {
        s += (i ? ',' : '') + (v[i] == null ? '' : this.toStr(v[i]))
        if (s.length > LIMITS.stringLength) this.str(s)
      }
      return s
    }
    return '[object Object]'
  }

  private binary(op: string, a: any, b: any): unknown {
    switch (op) {
      case '+':
        if (typeof a === 'number' && typeof b === 'number') return a + b
        if (typeof a === 'string' || typeof b === 'string' || (a && typeof a === 'object') || (b && typeof b === 'object')) {
          return this.str(this.toStr(a) + this.toStr(b))
        }
        return num(a) + num(b)
      case '-': return num(a) - num(b)
      case '*': return num(a) * num(b)
      case '/': return num(a) / num(b)
      case '%': return num(a) % num(b)
      case '**': return num(a) ** num(b)
      case '<': return a < b
      case '>': return a > b
      case '<=': return a <= b
      case '>=': return a >= b
      case '===': return a === b
      case '!==': return a !== b
      // Loose equality on primitives only; objects compare by identity
      case '==': return a === b || (a == null && b == null) || (typeof a !== 'object' && typeof b !== 'object' && a == b)
      case '!=': return !(a === b || (a == null && b == null) || (typeof a !== 'object' && typeof b !== 'object' && a == b))
      case '&': return num(a) & num(b)
      case '|': return num(a) | num(b)
      case '^': return num(a) ^ num(b)
      case '<<': return num(a) << num(b)
      case '>>': return num(a) >> num(b)
      case '>>>': return num(a) >>> num(b)
    }
    throw new SceneError(`line ${this.line}: unknown operator ${op}`)
  }

  // Property reads: own data on arrays, strings and the program's own objects
  private get(obj: unknown, key: unknown): unknown {
    if (obj === null || obj === undefined) throw new SceneError(`line ${this.line}: cannot read ${JSON.stringify(String(key))} of ${obj}`)
    if (Array.isArray(obj) || typeof obj === 'string') {
      if (key === 'length') return obj.length
      const i = typeof key === 'number' ? key : Number(key)
      if (Number.isInteger(i)) return obj[i]
      if (typeof key === 'string' && (Array.isArray(obj) ? ARRAY_METHODS : STRING_METHODS).has(key)) {
        throw new SceneError(`line ${this.line}: call .${key}(...) directly; methods can't be stored`)
      }
      return undefined
    }
    if (isObject(obj)) {
      const k = String(key)
      return Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined
    }
    return undefined
  }

  private set(obj: unknown, key: unknown, value: unknown) {
    if (Array.isArray(obj)) {
      const i = typeof key === 'number' ? key : Number(key)
      if (!Number.isInteger(i) || i < 0 || i >= LIMITS.arrayLength) {
        throw new SceneError(`line ${this.line}: array index ${String(key)} is out of range (0 to ${LIMITS.arrayLength - 1})`)
      }
      if (i >= obj.length) this.grow(i + 1 - obj.length)
      obj[i] = value
      return
    }
    if (isObject(obj) && !this.natives.has(obj as unknown as Function)) {
      if (!Object.prototype.hasOwnProperty.call(obj, String(key))) this.grow(1)
      obj[String(key)] = value
      return
    }
    throw new SceneError(`line ${this.line}: cannot set ${JSON.stringify(String(key))} on ${typeName(obj)}`)
  }

  private callNode(n: Node, scope: Scope): unknown {
    const args = () => n.args.map((a: Node) => this.value(a, scope))
    if (n.callee.k === 'member') {
      const obj = this.value(n.callee.obj, scope)
      const key = this.value(n.callee.prop, scope)
      if (Array.isArray(obj) && ARRAY_METHODS.has(key)) return this.arrayMethod(obj, key, args())
      if (typeof obj === 'string' && STRING_METHODS.has(key)) return this.stringMethod(obj, key, args())
      if (typeof obj === 'number' && (key === 'toFixed' || key === 'toString')) {
        const [d] = args()
        return key === 'toFixed' ? obj.toFixed(Math.max(0, Math.min(20, num(d) | 0))) : obj.toString(d === undefined ? 10 : Math.max(2, Math.min(36, num(d) | 0)))
      }
      const f = this.get(obj, key)
      if (f === undefined) throw new SceneError(`line ${n.line}: ${describe(n.callee)} is not a function`)
      return this.call(f, args(), describe(n.callee))
    }
    const f = this.value(n.callee, scope)
    return this.call(f, args(), describe(n.callee))
  }

  private call(f: unknown, args: unknown[], name = 'value'): unknown {
    if (f instanceof Closure) {
      if (++this.depth > LIMITS.callDepth) throw new SceneError(`line ${this.line}: too much recursion (more than ${LIMITS.callDepth} calls deep)`)
      const line = this.line
      const fn = f.fn
      const scope = new Scope(f.scope)
      for (let i = 0; i < fn.params.length; i++) {
        const p = fn.params[i]
        let v = args[i]
        if (v === undefined && p.def) v = this.value(p.def, scope)
        scope.vars.set(p.name, v)
      }
      let result: unknown
      if (fn.isExpr) result = this.value(fn.body, scope)
      else result = this.execList(fn.body, scope) === RETURN ? this.retVal : undefined
      this.retVal = undefined
      this.depth--
      this.line = line
      return result
    }
    if (typeof f === 'function' && this.natives.has(f)) return (f as Native)(...args)
    throw new SceneError(`line ${this.line}: ${name} is not a function`)
  }

  private fn(f: unknown, method: string): (...a: unknown[]) => unknown {
    if (!(f instanceof Closure) && !(typeof f === 'function' && this.natives.has(f))) {
      throw new SceneError(`line ${this.line}: .${method}() needs a function`)
    }
    return (...a: unknown[]) => this.call(f, a)
  }

  private arrayFrom = (src: unknown, mapFn?: unknown): unknown[] => {
    let n: number
    let get: (i: number) => unknown
    if (Array.isArray(src) || typeof src === 'string') {
      const items = [...src]
      n = items.length
      get = (i) => items[i]
    } else if (isObject(src)) {
      n = Math.floor(num(src.length))
      get = () => undefined
    } else {
      throw new SceneError(`line ${this.line}: Array.from needs an array, a string or {length: n}`)
    }
    if (!(n >= 0) || n > LIMITS.arrayLength) throw new SceneError(`line ${this.line}: array longer than ${LIMITS.arrayLength.toLocaleString('en-US')} items`)
    this.grow(n)
    const f = mapFn === undefined ? null : this.fn(mapFn, 'from')
    const out: unknown[] = []
    for (let i = 0; i < n; i++) out.push(f ? f(get(i), i) : get(i))
    return out
  }

  private arrayMethod(a: unknown[], key: string, args: unknown[]): unknown {
    const [x, y] = args
    this.charge(1)
    switch (key) {
      case 'push': case 'unshift':
        if (a.length + args.length > LIMITS.arrayLength) throw new SceneError(`line ${this.line}: array longer than ${LIMITS.arrayLength.toLocaleString('en-US')} items`)
        this.grow(args.length)
        return key === 'push' ? a.push(...args) : a.unshift(...args)
      case 'pop': return a.pop()
      case 'shift': this.charge(a.length >> 4); return a.shift()
      case 'slice': return this.made(a.slice(x as number, y as number))
      case 'concat': return this.made(a.concat(...args.map((v) => (Array.isArray(v) ? v : [v]))))
      case 'splice': return this.made(a.splice(num(x), y === undefined ? a.length : num(y), ...args.slice(2)))
      case 'indexOf': this.charge(a.length); return a.indexOf(x)
      case 'includes': this.charge(a.length); return a.includes(x)
      case 'join': return this.str(a.map((v) => (v == null ? '' : this.toStr(v))).join(x === undefined ? ',' : String(x)))
      case 'reverse': return a.reverse()
      case 'at': return a.at(num(x))
      case 'fill': this.charge(a.length); return a.fill(x, y as number, args[2] as number)
      case 'map': { const f = this.fn(x, key); return this.made(a.map((v, i) => f(v, i, a))) }
      case 'filter': { const f = this.fn(x, key); return this.made(a.filter((v, i) => f(v, i, a))) }
      case 'forEach': { const f = this.fn(x, key); a.forEach((v, i) => f(v, i, a)); return undefined }
      case 'some': { const f = this.fn(x, key); return a.some((v, i) => f(v, i, a)) }
      case 'every': { const f = this.fn(x, key); return a.every((v, i) => f(v, i, a)) }
      case 'find': { const f = this.fn(x, key); return a.find((v, i) => f(v, i, a)) }
      case 'findIndex': { const f = this.fn(x, key); return a.findIndex((v, i) => f(v, i, a)) }
      case 'reduce': {
        const f = this.fn(x, key)
        return args.length > 1 ? a.reduce((acc, v, i) => f(acc, v, i, a), y) : a.reduce((acc, v, i) => f(acc, v, i, a))
      }
      case 'sort': {
        this.charge(a.length * 4)
        if (x === undefined) return a.sort()
        const f = this.fn(x, key)
        return a.sort((p, q) => num(f(p, q)))
      }
    }
    throw new SceneError(`line ${this.line}: arrays have no method ${key}`)
  }

  private stringMethod(s: string, key: string, args: unknown[]): unknown {
    const [x, y] = args
    this.charge(1)
    const n = (v: unknown) => num(v)
    switch (key) {
      case 'charAt': return s.charAt(n(x))
      case 'charCodeAt': return s.charCodeAt(n(x))
      case 'codePointAt': return s.codePointAt(n(x))
      case 'at': return s.at(n(x))
      case 'slice': return s.slice(x as number, y as number)
      case 'substring': return s.substring(n(x), y === undefined ? undefined : n(y))
      case 'toUpperCase': return s.toUpperCase()
      case 'toLowerCase': return s.toLowerCase()
      case 'trim': return s.trim()
      case 'indexOf': return s.indexOf(String(x))
      case 'lastIndexOf': return s.lastIndexOf(String(x))
      case 'includes': return s.includes(String(x))
      case 'startsWith': return s.startsWith(String(x))
      case 'endsWith': return s.endsWith(String(x))
      case 'split': return this.made(x === undefined ? [s] : s.split(String(x)))
      case 'concat': return this.str(s + args.map((v) => this.toStr(v)).join(''))
      case 'replace': return this.str(s.replace(String(x), () => this.toStr(y)))
      case 'repeat': case 'padStart': case 'padEnd': {
        const count = n(x)
        const size = key === 'repeat' ? s.length * count : count
        if (!(size >= 0) || size > LIMITS.stringLength) throw new SceneError(`line ${this.line}: string longer than ${LIMITS.stringLength.toLocaleString('en-US')} characters`)
        if (key === 'repeat') return this.str(s.repeat(count))
        return this.str(key === 'padStart' ? s.padStart(count, y === undefined ? ' ' : String(y)) : s.padEnd(count, y === undefined ? ' ' : String(y)))
      }
    }
    throw new SceneError(`line ${this.line}: strings have no method ${key}`)
  }
}

const ARRAY_METHODS = new Set([
  'push', 'pop', 'shift', 'unshift', 'slice', 'concat', 'splice', 'indexOf', 'includes', 'join', 'reverse', 'at', 'fill',
  'map', 'filter', 'forEach', 'some', 'every', 'find', 'findIndex', 'reduce', 'sort',
])
const STRING_METHODS = new Set([
  'charAt', 'charCodeAt', 'codePointAt', 'at', 'slice', 'substring', 'toUpperCase', 'toLowerCase', 'trim', 'indexOf',
  'lastIndexOf', 'includes', 'startsWith', 'endsWith', 'split', 'concat', 'replace', 'repeat', 'padStart', 'padEnd',
])

const SIMPLE_GLOBALS: Record<string, unknown> = {
  String: (v: unknown) => (v === null || typeof v !== 'object' ? String(v) : Array.isArray(v) ? '[array]' : '[object Object]'),
  Number: (v: unknown) => (typeof v === 'object' && v !== null ? NaN : Number(v)),
  parseInt: (v: unknown, r?: number) => parseInt(String(v), r),
  parseFloat: (v: unknown) => parseFloat(String(v)),
  isNaN: (v: unknown) => Number.isNaN(typeof v === 'number' ? v : Number(v)),
  isFinite: (v: unknown) => Number.isFinite(v),
  NaN,
  Infinity,
}

function mathObject(): Record<string, unknown> {
  const m: Record<string, unknown> = {}
  for (const k of ['abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'cos', 'exp', 'floor', 'hypot', 'log', 'log2', 'log10',
    'max', 'min', 'pow', 'round', 'sign', 'sin', 'sqrt', 'tan', 'trunc', 'cbrt', 'sinh', 'cosh', 'tanh', 'fround'] as const) {
    const f = Math[k] as (...a: number[]) => number
    m[k] = (...a: unknown[]) => f(...a.map(num))
  }
  for (const k of ['PI', 'E', 'SQRT2', 'LN2', 'LN10'] as const) m[k] = Math[k]
  return m
}

function num(v: unknown): number {
  if (typeof v === 'number') return v
  if (v === null || typeof v !== 'object') return Number(v)
  return NaN
}

function typeName(v: unknown): string {
  if (v instanceof Closure || typeof v === 'function') return 'function'
  if (v === null) return 'object'
  return typeof v
}

function describe(n: Node): string {
  if (n.k === 'id') return n.name
  if (n.k === 'member' && n.prop.k === 'str') return `${describe(n.obj)}.${n.prop.v}`
  return 'value'
}
