import { describe, it, expect } from 'vitest'
import { createLogger, maskSecrets } from '../../../src/multi/observability/logger.js'

describe('maskSecrets', () => {
  it('masks token/secret/key/password fields', () => {
    const input = {
      user: 'bob',
      token: 'secret-token-123',
      nested: { api_key: 'abc', password: 'p@ss' },
    }
    const out = maskSecrets(input)
    expect(out.user).toBe('bob')
    expect(out.token).toBe('***masked***')
    expect((out.nested as any).api_key).toBe('***masked***')
    expect((out.nested as any).password).toBe('***masked***')
  })

  it('does not mask non-secret fields', () => {
    const out = maskSecrets({ name: 'alice', age: 30 })
    expect(out.name).toBe('alice')
    expect(out.age).toBe(30)
  })

  it('handles null and undefined', () => {
    expect(maskSecrets({ a: null, b: undefined })).toEqual({ a: null, b: undefined })
  })
})

describe('createLogger', () => {
  it('creates a logger with info/warn/error methods', () => {
    const log = createLogger('info')
    expect(typeof log.info).toBe('function')
    expect(typeof log.warn).toBe('function')
    expect(typeof log.error).toBe('function')
    expect(typeof log.debug).toBe('function')
  })

  it('child logger inherits context', () => {
    const log = createLogger('info')
    const child = log.child({ workspaceId: 'ws1' })
    expect(typeof child.info).toBe('function')
  })
})
