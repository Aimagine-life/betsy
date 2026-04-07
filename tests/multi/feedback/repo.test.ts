import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'
import { FeedbackRepo } from '../../../src/multi/feedback/repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('FeedbackRepo (integration, RLS-gated)', () => {
  let pool: Pool
  let wsRepo: WorkspaceRepo
  let repo: FeedbackRepo
  let workspaceId: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    wsRepo = new WorkspaceRepo(pool)
    repo = new FeedbackRepo(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('truncate workspaces cascade')
    const ws = await wsRepo.upsertForTelegram(1)
    workspaceId = ws.id
  })

  it('record inserts a feedback row', async () => {
    const entry = await repo.record({
      workspaceId,
      channel: 'telegram',
      chatId: '100',
      messageId: '42',
      rating: 1,
      rawText: 'Привет',
      userMessage: 'Hi',
    })
    expect(entry.id).toBeTruthy()
    expect(entry.rating).toBe(1)
    expect(entry.rawText).toBe('Привет')
  })

  it('record is idempotent on (workspace, channel, message_id) — upserts rating', async () => {
    await repo.record({
      workspaceId,
      channel: 'telegram',
      chatId: '100',
      messageId: '42',
      rating: 1,
    })
    const second = await repo.record({
      workspaceId,
      channel: 'telegram',
      chatId: '100',
      messageId: '42',
      rating: -1,
    })
    expect(second.rating).toBe(-1)
    const list = await repo.listRecent(workspaceId, 10)
    expect(list).toHaveLength(1)
    expect(list[0].rating).toBe(-1)
  })

  it('listRecent returns newest first', async () => {
    await repo.record({
      workspaceId,
      channel: 'telegram',
      chatId: '100',
      messageId: '1',
      rating: 1,
    })
    await new Promise((r) => setTimeout(r, 10))
    await repo.record({
      workspaceId,
      channel: 'telegram',
      chatId: '100',
      messageId: '2',
      rating: -1,
    })
    const list = await repo.listRecent(workspaceId, 10)
    expect(list).toHaveLength(2)
    expect(list[0].messageId).toBe('2')
  })

  it('countByRating aggregates thumbs', async () => {
    await repo.record({ workspaceId, channel: 'telegram', chatId: '1', messageId: 'a', rating: 1 })
    await repo.record({ workspaceId, channel: 'telegram', chatId: '1', messageId: 'b', rating: 1 })
    await repo.record({ workspaceId, channel: 'telegram', chatId: '1', messageId: 'c', rating: -1 })
    const counts = await repo.countByRating(workspaceId, 7)
    expect(counts.thumbsUp).toBe(2)
    expect(counts.thumbsDown).toBe(1)
  })

  it('getByMessage finds by channel message id', async () => {
    await repo.record({
      workspaceId,
      channel: 'telegram',
      chatId: '1',
      messageId: 'msg-99',
      rating: 1,
    })
    const found = await repo.getByMessage(workspaceId, 'telegram', 'msg-99')
    expect(found?.rating).toBe(1)
    const missing = await repo.getByMessage(workspaceId, 'telegram', 'nope')
    expect(missing).toBeNull()
  })

  it('RLS isolates feedback across workspaces', async () => {
    const ws2 = await wsRepo.upsertForTelegram(2)
    await repo.record({
      workspaceId,
      channel: 'telegram',
      chatId: '1',
      messageId: 'aaa',
      rating: 1,
    })
    await repo.record({
      workspaceId: ws2.id,
      channel: 'telegram',
      chatId: '1',
      messageId: 'bbb',
      rating: -1,
    })
    const list1 = await repo.listRecent(workspaceId, 10)
    const list2 = await repo.listRecent(ws2.id, 10)
    expect(list1).toHaveLength(1)
    expect(list2).toHaveLength(1)
    expect(list1[0].messageId).toBe('aaa')
    expect(list2[0].messageId).toBe('bbb')
  })
})
