import { describe, it, expect } from 'vitest'
import { pickEntry } from '../../src/mode.js'

describe('pickEntry', () => {
  it('returns single when BETSY_MODE unset', () => {
    expect(pickEntry({})).toBe('single')
  })
  it('returns multi when BETSY_MODE=multi', () => {
    expect(pickEntry({ BETSY_MODE: 'multi' })).toBe('multi')
  })
  it('returns single for other values', () => {
    expect(pickEntry({ BETSY_MODE: 'weird' })).toBe('single')
  })
  it('returns single for empty string', () => {
    expect(pickEntry({ BETSY_MODE: '' })).toBe('single')
  })
})
