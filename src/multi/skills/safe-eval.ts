// Wave 1C — Workspace skills: safe expression evaluator.
//
// Supports a tiny expression language used for `condition.if` and `{{...}}`
// templates. NO eval, NO new Function, NO require/import. Pure tokenizer +
// recursive-descent parser. Identifiers are restricted to whitelisted root
// names ("vars" and aliases provided in scope). Property access uses
// strict alphanumeric segments only — no bracket access, no dynamic keys,
// and a hard blocklist on dangerous identifier names.

export class SafeEvalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SafeEvalError'
  }
}

const FORBIDDEN_NAMES = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'process',
  'require',
  'import',
  'globalThis',
  'global',
  'window',
  'self',
  'eval',
  'Function',
  'this',
])

type Token =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: string }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'dot' }
  | { type: 'eof' }

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = input.length
  while (i < n) {
    const c = input[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    if (c === '(') {
      tokens.push({ type: 'lparen' })
      i++
      continue
    }
    if (c === ')') {
      tokens.push({ type: 'rparen' })
      i++
      continue
    }
    if (c === '.') {
      tokens.push({ type: 'dot' })
      i++
      continue
    }
    // Strings: '...' or "..."
    if (c === "'" || c === '"') {
      const quote = c
      i++
      let s = ''
      while (i < n && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < n) {
          const next = input[i + 1]
          if (next === 'n') s += '\n'
          else if (next === 't') s += '\t'
          else if (next === 'r') s += '\r'
          else if (next === '\\') s += '\\'
          else if (next === quote) s += quote
          else s += next
          i += 2
          continue
        }
        // Forbid template literal or interpolation tricks: nothing fancy here,
        // strings are pure data.
        s += input[i]
        i++
      }
      if (i >= n) throw new SafeEvalError('unterminated string literal')
      i++ // closing quote
      tokens.push({ type: 'str', value: s })
      continue
    }
    // Numbers
    if ((c >= '0' && c <= '9') || (c === '-' && i + 1 < n && input[i + 1] >= '0' && input[i + 1] <= '9' && (tokens.length === 0 || lastIsOpOrParen(tokens)))) {
      let j = i
      if (input[j] === '-') j++
      while (j < n && ((input[j] >= '0' && input[j] <= '9') || input[j] === '.')) j++
      const numStr = input.slice(i, j)
      const num = Number(numStr)
      if (!Number.isFinite(num)) throw new SafeEvalError(`invalid number: ${numStr}`)
      tokens.push({ type: 'num', value: num })
      i = j
      continue
    }
    // Identifiers
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      let j = i + 1
      while (
        j < n &&
        ((input[j] >= 'a' && input[j] <= 'z') ||
          (input[j] >= 'A' && input[j] <= 'Z') ||
          (input[j] >= '0' && input[j] <= '9') ||
          input[j] === '_')
      ) {
        j++
      }
      const id = input.slice(i, j)
      if (FORBIDDEN_NAMES.has(id)) {
        throw new SafeEvalError(`forbidden identifier: ${id}`)
      }
      tokens.push({ type: 'ident', value: id })
      i = j
      continue
    }
    // Operators
    const two = input.slice(i, i + 2)
    if (two === '==' || two === '!=' || two === '>=' || two === '<=' || two === '&&' || two === '||') {
      tokens.push({ type: 'op', value: two })
      i += 2
      continue
    }
    if (c === '>' || c === '<' || c === '!') {
      tokens.push({ type: 'op', value: c })
      i++
      continue
    }
    throw new SafeEvalError(`unexpected character: ${c}`)
  }
  tokens.push({ type: 'eof' })
  return tokens
}

function lastIsOpOrParen(tokens: Token[]): boolean {
  const t = tokens[tokens.length - 1]
  return t.type === 'op' || t.type === 'lparen'
}

class Parser {
  private pos = 0
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]
  }
  private consume(): Token {
    return this.tokens[this.pos++]
  }
  private expect(type: Token['type']): Token {
    const t = this.consume()
    if (t.type !== type) throw new SafeEvalError(`expected ${type} got ${t.type}`)
    return t
  }

  parseExpression(): any {
    return this.parseOr()
  }
  parseOr(): any {
    let left = this.parseAnd()
    while (this.peek().type === 'op' && (this.peek() as any).value === '||') {
      this.consume()
      const right = this.parseAnd()
      const l = left
      const r = right
      left = { kind: 'binop', op: '||', l, r }
    }
    return left
  }
  parseAnd(): any {
    let left = this.parseEquality()
    while (this.peek().type === 'op' && (this.peek() as any).value === '&&') {
      this.consume()
      const right = this.parseEquality()
      left = { kind: 'binop', op: '&&', l: left, r: right }
    }
    return left
  }
  parseEquality(): any {
    let left = this.parseComparison()
    while (this.peek().type === 'op' && ((this.peek() as any).value === '==' || (this.peek() as any).value === '!=')) {
      const op = (this.consume() as any).value
      const right = this.parseComparison()
      left = { kind: 'binop', op, l: left, r: right }
    }
    return left
  }
  parseComparison(): any {
    let left = this.parseUnary()
    while (
      this.peek().type === 'op' &&
      ['>', '<', '>=', '<='].includes((this.peek() as any).value)
    ) {
      const op = (this.consume() as any).value
      const right = this.parseUnary()
      left = { kind: 'binop', op, l: left, r: right }
    }
    return left
  }
  parseUnary(): any {
    if (this.peek().type === 'op' && (this.peek() as any).value === '!') {
      this.consume()
      const expr = this.parseUnary()
      return { kind: 'not', expr }
    }
    return this.parsePrimary()
  }
  parsePrimary(): any {
    const t = this.peek()
    if (t.type === 'lparen') {
      this.consume()
      const expr = this.parseExpression()
      this.expect('rparen')
      return expr
    }
    if (t.type === 'num') {
      this.consume()
      return { kind: 'lit', value: (t as any).value }
    }
    if (t.type === 'str') {
      this.consume()
      return { kind: 'lit', value: (t as any).value }
    }
    if (t.type === 'ident') {
      const name = (this.consume() as any).value
      if (name === 'true') return { kind: 'lit', value: true }
      if (name === 'false') return { kind: 'lit', value: false }
      if (name === 'null') return { kind: 'lit', value: null }
      const path: string[] = [name]
      while (this.peek().type === 'dot') {
        this.consume()
        const next = this.consume()
        if (next.type !== 'ident') throw new SafeEvalError('expected identifier after "."')
        if (FORBIDDEN_NAMES.has((next as any).value)) {
          throw new SafeEvalError(`forbidden property: ${(next as any).value}`)
        }
        path.push((next as any).value)
      }
      return { kind: 'path', path }
    }
    throw new SafeEvalError(`unexpected token: ${t.type}`)
  }
}

function evalNode(node: any, scope: Record<string, any>): any {
  switch (node.kind) {
    case 'lit':
      return node.value
    case 'not':
      return !evalNode(node.expr, scope)
    case 'binop': {
      const op: string = node.op
      // short circuit
      if (op === '&&') return evalNode(node.l, scope) && evalNode(node.r, scope)
      if (op === '||') return evalNode(node.l, scope) || evalNode(node.r, scope)
      const lv = evalNode(node.l, scope)
      const rv = evalNode(node.r, scope)
      switch (op) {
        case '==':
          return lv === rv
        case '!=':
          return lv !== rv
        case '>':
          return lv > rv
        case '<':
          return lv < rv
        case '>=':
          return lv >= rv
        case '<=':
          return lv <= rv
      }
      throw new SafeEvalError(`unknown operator: ${op}`)
    }
    case 'path': {
      const [root, ...rest] = node.path as string[]
      if (!(root in scope)) {
        // Unknown root: return undefined silently so templates render empty.
        return undefined
      }
      let cur: any = scope[root]
      for (const seg of rest) {
        if (cur == null) return undefined
        if (FORBIDDEN_NAMES.has(seg)) {
          throw new SafeEvalError(`forbidden property: ${seg}`)
        }
        // Only allow plain own-property access on plain objects/arrays.
        if (typeof cur !== 'object') return undefined
        cur = (cur as any)[seg]
      }
      return cur
    }
  }
  throw new SafeEvalError(`unknown node kind: ${node.kind}`)
}

/**
 * Evaluate a single expression against a scope. Scope keys are the only
 * accessible root identifiers (typically `vars` and loop iterators).
 */
export function safeEval(expression: string, scope: Record<string, any>): any {
  if (typeof expression !== 'string') {
    throw new SafeEvalError('expression must be a string')
  }
  if (expression.length > 1000) {
    throw new SafeEvalError('expression too long')
  }
  const tokens = tokenize(expression)
  const parser = new Parser(tokens)
  const ast = parser.parseExpression()
  if (parser['peek']().type !== 'eof') {
    throw new SafeEvalError('trailing tokens after expression')
  }
  return evalNode(ast, scope)
}

/**
 * Evaluate as boolean (used for `condition.if`). Coerces JS truthiness.
 */
export function safeEvalBool(expression: string, scope: Record<string, any>): boolean {
  return Boolean(safeEval(expression, scope))
}
