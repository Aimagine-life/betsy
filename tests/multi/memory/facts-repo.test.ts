import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'
import { FactsRepo } from '../../../src/multi/memory/facts-repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('FactsRepo', () => {
  let pool: Pool
  let wsRepo: WorkspaceRepo
  let repo: FactsRepo
  let workspaceId: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    wsRepo = new WorkspaceRepo(pool)
    repo = new FactsRepo(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('truncate workspaces cascade')
    const ws = await wsRepo.upsertForTelegram(1)
    workspaceId = ws.id
  })

  it('remember stores a fact', async () => {
    const f = await repo.remember(workspaceId, {
      kind: 'fact',
      content: 'Любит кофе с молоком без сахара',
    })
    expect(f.id).toBeTruthy()
    expect(f.content).toBe('Любит кофе с молоком без сахара')
  })

  it('list returns facts ordered by creation desc', async () => {
    await repo.remember(workspaceId, { kind: 'fact', content: 'First' })
    await new Promise((r) => setTimeout(r, 10))
    await repo.remember(workspaceId, { kind: 'fact', content: 'Second' })
    const facts = await repo.list(workspaceId, 10)
    expect(facts).toHaveLength(2)
    expect(facts[0].content).toBe('Second')
  })

  it('listByKind filters by kind', async () => {
    await repo.remember(workspaceId, { kind: 'fact', content: 'F' })
    await repo.remember(workspaceId, { kind: 'preference', content: 'P' })
    const prefs = await repo.listByKind(workspaceId, 'preference', 10)
    expect(prefs).toHaveLength(1)
    expect(prefs[0].content).toBe('P')
  })

  it('forget deletes single fact', async () => {
    const f = await repo.remember(workspaceId, { kind: 'fact', content: 'X' })
    await repo.forget(workspaceId, f.id)
    const after = await repo.list(workspaceId, 10)
    expect(after).toHaveLength(0)
  })

  it('forgetAll wipes workspace memory', async () => {
    await repo.remember(workspaceId, { kind: 'fact', content: '1' })
    await repo.remember(workspaceId, { kind: 'fact', content: '2' })
    await repo.forgetAll(workspaceId)
    const after = await repo.list(workspaceId, 10)
    expect(after).toHaveLength(0)
  })
})
