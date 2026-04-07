import { describe, it, expect } from 'vitest'
import { StateStore } from '../../src/auth-relay/state-store.js'

function sample() {
  return {
    provider: 'google' as const,
    workspaceId: '11111111-1111-1111-1111-111111111111',
    integration: 'gcal',
    scopes: ['openid'],
    returnTo: 'https://app.betsyai.io/integrations',
  }
}

describe('StateStore', () => {
  it('put then take returns the stored state', () => {
    const s = new StateStore()
    const nonce = s.put(sample())
    const got = s.take(nonce)
    expect(got).not.toBeNull()
    expect(got?.provider).toBe('google')
    expect(got?.integration).toBe('gcal')
    expect(got?.nonce).toBe(nonce)
  })

  it('take twice returns null on the second call', () => {
    const s = new StateStore()
    const nonce = s.put(sample())
    expect(s.take(nonce)).not.toBeNull()
    expect(s.take(nonce)).toBeNull()
  })

  it('expired entries return null from take()', () => {
    let t = 1000
    const s = new StateStore({ ttlMs: 500, now: () => t })
    const nonce = s.put(sample())
    t = 1000 + 501
    expect(s.take(nonce)).toBeNull()
  })

  it('take() with unknown nonce returns null', () => {
    const s = new StateStore()
    expect(s.take('deadbeef')).toBeNull()
  })

  it('evictExpired drops stale entries', () => {
    let t = 0
    const s = new StateStore({ ttlMs: 100, now: () => t })
    s.put(sample())
    s.put(sample())
    expect(s.size()).toBe(2)
    t = 500
    s.put(sample()) // triggers evict
    // old two evicted, new one remains
    expect(s.size()).toBe(1)
  })
})
