import { describe, it, expect } from 'vitest'
import { renderTemplate, renderValue } from '../../../src/multi/skills/template.js'

describe('renderTemplate', () => {
  const scope = {
    vars: {
      name: 'Бетси',
      n: 42,
      nested: { x: 'deep' },
    },
  }

  it('renders simple expression', () => {
    expect(renderTemplate('Hello {{vars.name}}!', scope)).toBe('Hello Бетси!')
  })

  it('renders numbers and nested', () => {
    expect(renderTemplate('{{vars.n}} / {{vars.nested.x}}', scope)).toBe('42 / deep')
  })

  it('undefined → empty string', () => {
    expect(renderTemplate('[{{vars.missing}}]', scope)).toBe('[]')
  })

  it('handles cyrillic and emoji', () => {
    const r = renderTemplate('Привет, {{vars.name}}! 🎉', scope)
    expect(r).toBe('Привет, Бетси! 🎉')
  })

  it('multiple substitutions', () => {
    expect(renderTemplate('{{vars.name}}-{{vars.n}}-{{vars.name}}', scope)).toBe(
      'Бетси-42-Бетси',
    )
  })

  it('empty placeholder', () => {
    expect(renderTemplate('a{{}}b', scope)).toBe('ab')
  })

  it('failed expression renders empty', () => {
    expect(renderTemplate('x{{__proto__}}y', scope)).toBe('xy')
  })
})

describe('renderValue', () => {
  it('walks objects and arrays', () => {
    const scope = { vars: { who: 'world' } }
    const out = renderValue(
      { greet: 'hi {{vars.who}}', list: ['a', 'b {{vars.who}}'] },
      scope,
    )
    expect(out).toEqual({ greet: 'hi world', list: ['a', 'b world'] })
  })

  it('drops dangerous keys', () => {
    const scope = {}
    const input: any = { good: 'x' }
    Object.defineProperty(input, '__proto__', { value: 'evil', enumerable: true })
    const out = renderValue(input, scope)
    expect(out.good).toBe('x')
    expect((out as any).__proto__).not.toBe('evil')
  })

  it('passes through primitives', () => {
    expect(renderValue(42, {})).toBe(42)
    expect(renderValue(true, {})).toBe(true)
    expect(renderValue(null, {})).toBe(null)
  })
})
