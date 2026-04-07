import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'
import { LinkCodesRepo } from '../../../src/multi/linking/repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('LinkCodesRepo', () => {
  let pool: Pool
  let wsRepo: WorkspaceRepo
  let repo: LinkCodesRepo
  let wsId: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    wsRepo = new WorkspaceRepo(pool)
    repo = new LinkCodesRepo(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('truncate workspaces cascade')
    const ws = await wsRepo.upsertForTelegram(1)
    wsId = ws.id
  })

  it('creates a code and finds it', async () => {
    const code = await repo.create(wsId, 10 * 60 * 1000)
    expect(code.code).toMatch(/^\d{6}$/)
    const found = await repo.findByCode(code.code)
    expect(found?.workspaceId).toBe(wsId)
  })

  it('consumes a code — returns it once and then gone', async () => {
    const code = await repo.create(wsId, 10 * 60 * 1000)
    const first = await repo.consume(code.code)
    expect(first?.workspaceId).toBe(wsId)
    const second = await repo.consume(code.code)
    expect(second).toBeNull()
  })

  it('findByCode returns null for expired codes', async () => {
    const code = await repo.create(wsId, -1000)
    const found = await repo.findByCode(code.code)
    expect(found).toBeNull()
  })

  it('countRecentForWorkspace returns number of codes in last hour', async () => {
    await repo.create(wsId, 10 * 60 * 1000)
    await repo.create(wsId, 10 * 60 * 1000)
    const count = await repo.countRecentForWorkspace(wsId, 60 * 60 * 1000)
    expect(count).toBe(2)
  })
})
