import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'
import { RemindersRepo } from '../../../src/multi/reminders/repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('RemindersRepo', () => {
  let pool: Pool
  let wsRepo: WorkspaceRepo
  let repo: RemindersRepo
  let workspaceId: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    wsRepo = new WorkspaceRepo(pool)
    repo = new RemindersRepo(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('truncate workspaces cascade')
    const ws = await wsRepo.upsertForTelegram(1)
    workspaceId = ws.id
  })

  it('creates a reminder', async () => {
    const r = await repo.create(workspaceId, {
      fireAt: new Date(Date.now() + 3600_000),
      text: 'Купить молоко',
      preferredChannel: 'telegram',
    })
    expect(r.status).toBe('pending')
    expect(r.text).toBe('Купить молоко')
  })

  it('lists pending reminders for workspace', async () => {
    await repo.create(workspaceId, {
      fireAt: new Date(Date.now() + 1000),
      text: 'R1',
      preferredChannel: 'telegram',
    })
    await repo.create(workspaceId, {
      fireAt: new Date(Date.now() + 2000),
      text: 'R2',
      preferredChannel: 'telegram',
    })
    const list = await repo.listPending(workspaceId)
    expect(list).toHaveLength(2)
  })

  it('cancels a reminder by id', async () => {
    const r = await repo.create(workspaceId, {
      fireAt: new Date(Date.now() + 1000),
      text: 'X',
      preferredChannel: 'telegram',
    })
    await repo.cancel(workspaceId, r.id)
    const list = await repo.listPending(workspaceId)
    expect(list).toHaveLength(0)
  })

  it('marks reminder as fired', async () => {
    const r = await repo.create(workspaceId, {
      fireAt: new Date(Date.now() + 1000),
      text: 'X',
      preferredChannel: 'telegram',
    })
    await repo.markFired(workspaceId, r.id)
    const list = await repo.listPending(workspaceId)
    expect(list).toHaveLength(0)
  })
})
