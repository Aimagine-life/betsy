import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('runMigrations', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
  })

  afterAll(async () => {
    await pool.end()
  })

  it('applies 001_init and is idempotent', async () => {
    const first = await runMigrations(pool)
    expect(first).toContain('001_init.sql')

    const second = await runMigrations(pool)
    expect(second).toEqual([])

    const r = await pool.query("select to_regclass('public.workspaces') as t")
    expect(r.rows[0].t).toBe('workspaces')

    const rls = await pool.query("select relrowsecurity from pg_class where relname = 'workspaces'")
    expect(rls.rows[0].relrowsecurity).toBe(true)
  })
})
