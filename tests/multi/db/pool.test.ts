import { describe, it, expect, afterEach } from 'vitest'
import { buildPool, closePool, getPool } from '../../../src/multi/db/pool.js'

describe('buildPool', () => {
  afterEach(async () => {
    await closePool()
  })

  it('creates a pool with connection string', () => {
    const pool = buildPool('postgres://user:pass@localhost:5432/db')
    expect(pool).toBeDefined()
    expect(typeof pool.query).toBe('function')
  })

  it('getPool throws before buildPool', () => {
    expect(() => getPool()).toThrow(/not initialized/i)
  })

  it('getPool returns same instance after buildPool', () => {
    const p1 = buildPool('postgres://x')
    const p2 = getPool()
    expect(p1).toBe(p2)
  })

  it('closePool resets state', async () => {
    buildPool('postgres://x')
    await closePool()
    expect(() => getPool()).toThrow(/not initialized/i)
  })
})
