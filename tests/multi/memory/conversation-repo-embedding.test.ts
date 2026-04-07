import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'
import { ConversationRepo } from '../../../src/multi/memory/conversation-repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('ConversationRepo semantic search', () => {
  let pool: Pool
  let wsRepo: WorkspaceRepo
  let repo: ConversationRepo
  let workspaceId: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    wsRepo = new WorkspaceRepo(pool)
    // No gemini — tests use manually-set embeddings
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

  async function seedRow(
    content: string,
    embedding: number[],
    opts: { role?: 'user' | 'assistant'; chatId?: string; externalMessageId?: number } = {},
  ): Promise<string> {
    const msg = await repo.append(workspaceId, {
      channel: 'telegram',
      role: opts.role ?? 'user',
      content,
      chatId: opts.chatId ?? '100',
      externalMessageId: opts.externalMessageId,
    })
    await repo.setEmbedding(workspaceId, msg.id, embedding)
    return msg.id
  }

  it('returns rows ordered by cosine distance', async () => {
    const pad = (v: number[]): number[] => [...v, ...Array(768 - v.length).fill(0)]
    await seedRow('apple', pad([1, 0, 0]))
    await seedRow('banana', pad([0, 1, 0]))
    await seedRow('cherry', pad([0, 0, 1]))

    const results = await repo.searchByEmbedding(workspaceId, pad([0.9, 0.1, 0]), {
      chatId: '100',
      limit: 2,
    })
    expect(results).toHaveLength(2)
    expect(results[0].content).toBe('apple')
    expect(results[0].distance).toBeLessThan(results[1].distance)
  })

  it('filters by role', async () => {
    const pad = (v: number[]): number[] => [...v, ...Array(768 - v.length).fill(0)]
    await seedRow('user-a', pad([1, 0, 0]), { role: 'user' })
    await seedRow('assistant-a', pad([1, 0, 0]), { role: 'assistant' })
    const results = await repo.searchByEmbedding(workspaceId, pad([1, 0, 0]), {
      chatId: '100',
      limit: 10,
      role: 'assistant',
    })
    expect(results).toHaveLength(1)
    expect(results[0].role).toBe('assistant')
  })

  it('filters by chat_id', async () => {
    const pad = (v: number[]): number[] => [...v, ...Array(768 - v.length).fill(0)]
    await seedRow('in-chat-a', pad([1, 0, 0]), { chatId: 'A' })
    await seedRow('in-chat-b', pad([1, 0, 0]), { chatId: 'B' })
    const results = await repo.searchByEmbedding(workspaceId, pad([1, 0, 0]), {
      chatId: 'A',
      limit: 10,
    })
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('in-chat-a')
  })

  it('excludes recent N rows', async () => {
    const pad = (v: number[]): number[] => [...v, ...Array(768 - v.length).fill(0)]
    for (let i = 0; i < 5; i++) {
      await seedRow(`msg-${i}`, pad([1, 0, 0]))
      await new Promise((r) => setTimeout(r, 5))
    }
    const results = await repo.searchByEmbedding(workspaceId, pad([1, 0, 0]), {
      chatId: '100',
      limit: 10,
      excludeRecentN: 3,
    })
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.content).sort()).toEqual(['msg-0', 'msg-1'])
  })

  it('listMissingEmbeddings skips short and summarized rows', async () => {
    await repo.append(workspaceId, { channel: 'telegram', role: 'user', content: 'ok' })
    const summarized = await repo.append(workspaceId, {
      channel: 'telegram',
      role: 'user',
      content: 'long enough content here',
    })
    await repo.markSummarized(workspaceId, [summarized.id])
    await repo.append(workspaceId, {
      channel: 'telegram',
      role: 'user',
      content: 'this one should be backfilled',
    })

    const missing = await repo.listMissingEmbeddings(workspaceId, 10)
    expect(missing).toHaveLength(1)
    expect(missing[0].content).toBe('this one should be backfilled')
  })
})
