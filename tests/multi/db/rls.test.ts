import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { withWorkspace, asAdmin } from '../../../src/multi/db/rls.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('RLS withWorkspace', () => {
  let pool: Pool
  let wsA: string
  let wsB: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('truncate workspaces cascade')
    const r = await asAdmin(pool, async (client) => {
      const a = await client.query(
        `insert into workspaces (display_name) values ('A') returning id`,
      )
      const b = await client.query(
        `insert into workspaces (display_name) values ('B') returning id`,
      )
      return { a: a.rows[0].id, b: b.rows[0].id }
    })
    wsA = r.a
    wsB = r.b
  })

  it('sees only own workspace data', async () => {
    await withWorkspace(pool, wsA, async (client) => {
      await client.query(
        `insert into bc_memory_facts (workspace_id, kind, content) values ($1, 'fact', 'A fact')`,
        [wsA],
      )
    })
    await withWorkspace(pool, wsB, async (client) => {
      await client.query(
        `insert into bc_memory_facts (workspace_id, kind, content) values ($1, 'fact', 'B fact')`,
        [wsB],
      )
    })

    const aResult = await withWorkspace(pool, wsA, async (client) => {
      return client.query(`select content from bc_memory_facts`)
    })
    expect(aResult.rows).toHaveLength(1)
    expect(aResult.rows[0].content).toBe('A fact')

    const bResult = await withWorkspace(pool, wsB, async (client) => {
      return client.query(`select content from bc_memory_facts`)
    })
    expect(bResult.rows).toHaveLength(1)
    expect(bResult.rows[0].content).toBe('B fact')
  })

  it('rolls back on error and releases client', async () => {
    let errorCaught = false
    try {
      await withWorkspace(pool, wsA, async (client) => {
        await client.query(
          `insert into bc_memory_facts (workspace_id, kind, content) values ($1, 'fact', 'should rollback')`,
          [wsA],
        )
        throw new Error('simulated failure')
      })
    } catch (e) {
      errorCaught = true
    }
    expect(errorCaught).toBe(true)

    const check = await withWorkspace(pool, wsA, async (client) => {
      return client.query(`select count(*)::int as c from bc_memory_facts`)
    })
    expect(check.rows[0].c).toBe(0)
  })

  it('asAdmin bypasses RLS for system operations', async () => {
    const result = await asAdmin(pool, async (client) => {
      return client.query(`select count(*)::int as c from workspaces`)
    })
    expect(result.rows[0].c).toBe(2)
  })
})
