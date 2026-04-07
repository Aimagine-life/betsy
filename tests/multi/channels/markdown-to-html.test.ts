import { describe, it, expect } from 'vitest'
import { markdownToTelegramHTML as md } from '../../../src/multi/channels/markdown-to-html.js'

describe('markdownToTelegramHTML', () => {
  it('empty input returns empty', () => {
    expect(md('')).toBe('')
  })

  it('escapes plain text HTML specials', () => {
    expect(md('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })

  it('bold ** **', () => {
    expect(md('**bold**')).toBe('<b>bold</b>')
  })

  it('bold __ __', () => {
    expect(md('__bold__')).toBe('<b>bold</b>')
  })

  it('italic _ _', () => {
    expect(md('_italic_')).toBe('<i>italic</i>')
  })

  it('inline code', () => {
    expect(md('hello `world`')).toBe('hello <code>world</code>')
  })

  it('code block', () => {
    expect(md('```\nhi\n```')).toBe('<pre>\nhi\n</pre>')
  })

  it('list -', () => {
    expect(md('- foo\n- bar')).toBe('\u2022 foo\n\u2022 bar')
  })

  it('mixed bold and italic', () => {
    expect(md('**hello** _world_')).toBe('<b>hello</b> <i>world</i>')
  })

  it('unclosed bold left as plain', () => {
    expect(md('**hello')).toBe('**hello')
  })

  it('unclosed code left as plain (no infinite recursion)', () => {
    expect(md('`hello')).toBe('`hello')
  })

  it('link [text](url)', () => {
    expect(md('[Google](https://google.com)')).toBe(
      '<a href="https://google.com">Google</a>',
    )
  })

  it('escapes HTML injection', () => {
    expect(md('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    )
  })

  it('does not double-escape inside code blocks', () => {
    expect(md('`a < b`')).toBe('<code>a &lt; b</code>')
  })

  it('streaming-like prefix with unclosed ** is safe', () => {
    // Should NOT throw and should not produce a broken <b> tag
    const out = md('Hello **world is')
    expect(out).not.toContain('<b>')
    expect(out).toContain('**world is')
  })
})
