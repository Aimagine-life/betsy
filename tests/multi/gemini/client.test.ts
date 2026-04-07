import { describe, it, expect, beforeEach } from 'vitest'
import { buildGemini, getGemini, resetGemini } from '../../../src/multi/gemini/client.js'

describe('gemini client singleton', () => {
  beforeEach(() => resetGemini())

  it('getGemini throws before buildGemini', () => {
    expect(() => getGemini()).toThrow(/not initialized/i)
  })

  it('buildGemini returns instance and caches it', () => {
    const a = buildGemini('fake-key')
    const b = getGemini()
    expect(a).toBe(b)
  })

  it('resetGemini clears instance', () => {
    buildGemini('fake-key')
    resetGemini()
    expect(() => getGemini()).toThrow(/not initialized/i)
  })
})
