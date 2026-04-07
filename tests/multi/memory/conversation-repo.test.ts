import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'
import { ConversationRepo } from '../../../src/multi/memory/conversation-repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('ConversationRepo', () => {
  let pool: Pool
  let wsRepo: WorkspaceRepo
  let repo: ConversationRepo
  let workspaceId: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    wsRepo = new WorkspaceRepo(pool)
    repo = new ConversationRepo(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('truncate workspaces cascade')
    const ws = await wsRepo.upsertForTelegram(1)
    workspaceId = ws.id
  })

  it('append stores a message', async () => {
    const msg = await repo.append(workspaceId, {
      channel: 'telegram',
      role: 'user',
      content: 'Привет',
    })
    expect(msg.role).toBe('user')
    expect(msg.content).toBe('Привет')
  })

  it('recent returns messages ordered newest first', async () => {
    await repo.append(workspaceId, { channel: 'telegram', role: 'user', content: 'Hi' })
    await new Promise((r) => setTimeout(r, 10))
    await repo.append(workspaceId, {
      channel: 'telegram',
      role: 'assistant',
      content: 'Hello',
    })
    const msgs = await repo.recent(workspaceId, 10)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].content).toBe('Hello')
  })

  it('recent respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await repo.append(workspaceId, {
        channel: 'telegram',
        role: 'user',
        content: `msg ${i}`,
      })
    }
    const msgs = await repo.recent(workspaceId, 3)
    expect(msgs).toHaveLength(3)
  })

  it('tokensUsed is stored and returned', async () => {
    await repo.append(workspaceId, {
      channel: 'telegram',
      role: 'assistant',
      content: 'Hi',
      tokensUsed: 150,
    })
    const msgs = await repo.recent(workspaceId, 1)
    expect(msgs[0].tokensUsed).toBe(150)
  })

  it('append persists chat_id and external_message_id when provided', async () => {
    const msg = await repo.append(workspaceId, {
      channel: 'telegram',
      role: 'user',
      content: 'Привет',
      chatId: '123456',
      externalMessageId: 789,
    })
    expect(msg.chatId).toBe('123456')
    expect(msg.externalMessageId).toBe(789)

    const recent = await repo.recent(workspaceId, 1)
    expect(recent[0].chatId).toBe('123456')
    expect(recent[0].externalMessageId).toBe(789)
  })

  it('append allows chat_id and external_message_id to be omitted (legacy callers)', async () => {
    const msg = await repo.append(workspaceId, {
      channel: 'telegram',
      role: 'assistant',
      content: 'Ответ',
    })
    expect(msg.chatId).toBeNull()
    expect(msg.externalMessageId).toBeNull()
  })

  it('setExternalMessageId updates the row', async () => {
    const msg = await repo.append(workspaceId, {
      channel: 'telegram',
      role: 'assistant',
      content: 'ok',
      chatId: '1',
    })
    await repo.setExternalMessageId(workspaceId, msg.id, 555)
    const recent = await repo.recent(workspaceId, 1)
    expect(recent[0].externalMessageId).toBe(555)
  })
})
