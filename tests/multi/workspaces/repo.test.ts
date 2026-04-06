import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('WorkspaceRepo', () => {
  let pool: Pool
  let repo: WorkspaceRepo

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    repo = new WorkspaceRepo(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('truncate workspaces cascade')
  })

  it('upsertForTelegram creates new workspace', async () => {
    const ws = await repo.upsertForTelegram(12345)
    expect(ws.ownerTgId).toBe(12345)
    expect(ws.status).toBe('onboarding')
    expect(ws.plan).toBe('trial')
    expect(ws.personaId).toBe('betsy')
  })

  it('upsertForTelegram is idempotent', async () => {
    const a = await repo.upsertForTelegram(99)
    const b = await repo.upsertForTelegram(99)
    expect(a.id).toBe(b.id)
  })

  it('upsertForMax creates for MAX id', async () => {
    const ws = await repo.upsertForMax(777)
    expect(ws.ownerMaxId).toBe(777)
    expect(ws.ownerTgId).toBeNull()
  })

  it('updateStatus changes status', async () => {
    const ws = await repo.upsertForTelegram(1)
    await repo.updateStatus(ws.id, 'active')
    const found = await repo.findById(ws.id)
    expect(found?.status).toBe('active')
  })

  it('updatePlan changes plan', async () => {
    const ws = await repo.upsertForTelegram(1)
    await repo.updatePlan(ws.id, 'personal')
    const found = await repo.findById(ws.id)
    expect(found?.plan).toBe('personal')
  })

  it('updateLastActiveChannel tracks channel', async () => {
    const ws = await repo.upsertForTelegram(1)
    await repo.updateLastActiveChannel(ws.id, 'telegram')
    const found = await repo.findById(ws.id)
    expect(found?.lastActiveChannel).toBe('telegram')
  })

  it('findByTelegram returns workspace by tg id', async () => {
    const created = await repo.upsertForTelegram(55)
    const found = await repo.findByTelegram(55)
    expect(found?.id).toBe(created.id)
  })

  it('findByTelegram returns null for unknown', async () => {
    const found = await repo.findByTelegram(9999)
    expect(found).toBeNull()
  })
})
