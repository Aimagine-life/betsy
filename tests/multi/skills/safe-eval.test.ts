import { describe, it, expect } from 'vitest'
import { safeEval, safeEvalBool, SafeEvalError } from '../../../src/multi/skills/safe-eval.js'

const scope = {
  vars: {
    n: 5,
    s: 'hello',
    flag: true,
    nested: { a: 1, b: { c: 'deep' } },
    list: [1, 2, 3],
  },
}

describe('safeEval — operators and access', () => {
  it('literals', () => {
    expect(safeEval('1', {})).toBe(1)
    expect(safeEval("'foo'", {})).toBe('foo')
    expect(safeEval('true', {})).toBe(true)
    expect(safeEval('false', {})).toBe(false)
    expect(safeEval('null', {})).toBe(null)
  })

  it('path access', () => {
    expect(safeEval('vars.n', scope)).toBe(5)
    expect(safeEval('vars.nested.a', scope)).toBe(1)
    expect(safeEval('vars.nested.b.c', scope)).toBe('deep')
  })

  it('unknown root and missing path → undefined', () => {
    expect(safeEval('foo', {})).toBeUndefined()
    expect(safeEval('vars.nope', scope)).toBeUndefined()
    expect(safeEval('vars.nope.deeper', scope)).toBeUndefined()
  })

  it('comparison operators', () => {
    expect(safeEval('vars.n == 5', scope)).toBe(true)
    expect(safeEval('vars.n != 6', scope)).toBe(true)
    expect(safeEval('vars.n > 4', scope)).toBe(true)
    expect(safeEval('vars.n < 4', scope)).toBe(false)
    expect(safeEval('vars.n >= 5', scope)).toBe(true)
    expect(safeEval('vars.n <= 5', scope)).toBe(true)
  })

  it('logical operators and not', () => {
    expect(safeEval('vars.flag && vars.n == 5', scope)).toBe(true)
    expect(safeEval('vars.flag || false', scope)).toBe(true)
    expect(safeEval('!vars.flag', scope)).toBe(false)
    expect(safeEval('!(vars.n == 6)', scope)).toBe(true)
  })

  it('parens and precedence', () => {
    expect(safeEval('(vars.n > 4) && (vars.n < 10)', scope)).toBe(true)
  })

  it('safeEvalBool coerces truthy', () => {
    expect(safeEvalBool('vars.s', scope)).toBe(true)
    expect(safeEvalBool('vars.nope', scope)).toBe(false)
  })
})

describe('safeEval — security: injection attempts must throw or return undefined', () => {
  // Each attempt is intentionally evil. They must NOT execute anything.
  const attempts: Array<[string, RegExp | null]> = [
    ['__proto__', /forbidden|unexpected/],
    ['vars.__proto__', /forbidden/],
    ['constructor', /forbidden/],
    ['constructor.constructor', /forbidden/],
    ['process', /forbidden/],
    ['process.exit', /forbidden/],
    ["require('fs')", /forbidden|unexpected/],
    ['globalThis', /forbidden/],
    ['(()=>{})()', /unexpected/],
    ["eval('1')", /forbidden/],
    ['this', /forbidden/],
    ['vars.constructor', /forbidden/],
  ]
  for (const [src, pat] of attempts) {
    it(`blocks: ${src}`, () => {
      try {
        const r = safeEval(src, scope)
        // If it didn't throw, it MUST be undefined (no real value extracted)
        expect(r).toBeUndefined()
      } catch (e) {
        expect(e).toBeInstanceOf(SafeEvalError)
        if (pat) expect((e as Error).message).toMatch(pat)
      }
    })
  }

  it('rejects extremely long expressions', () => {
    expect(() => safeEval('a'.repeat(2000), scope)).toThrow(SafeEvalError)
  })

  it('rejects trailing tokens', () => {
    expect(() => safeEval('1 1', scope)).toThrow(SafeEvalError)
  })
})
