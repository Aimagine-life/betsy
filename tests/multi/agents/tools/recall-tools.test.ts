import { describe, it, expect, vi } from 'vitest'
import { createRecallTools } from '../../../../src/multi/agents/tools/recall-tools.js'
import { createRunContext } from '../../../../src/multi/agents/run-context.js'

function fakeGemini() {
  return {
    models: {
      embedContent: vi.fn().mockResolvedValue({
        embeddings: [{ values: Array(768).fill(0.1) }],
      }),
    },
  } as any
}

function fakeConvRepo(hits: any[]) {
  return {
    searchByEmbedding: vi.fn().mockResolvedValue(hits),
  } as any
}

describe('createRecallTools', () => {
  it('recall_messages embeds the query and returns shaped hits', async () => {
    const hits = [
      {
        id: 'r1',
        role: 'user',
        content: 'люблю чай с лимоном',
        chatId: '100',
        externalMessageId: 42,
        createdAt: new Date('2026-04-01T10:00:00Z'),
        distance: 0.15,
      },
    ]
    const convRepo = fakeConvRepo(hits)
    const gemini = fakeGemini()
    const runContext = createRunContext()
    const tools = createRecallTools({
      convRepo,
      gemini,
      workspaceId: 'ws1',
      currentChatId: '100',
      currentChannel: 'telegram',
      runContext,
    })
    const recall = tools.find((t) => t.name === 'recall_messages')!
    const result = (await recall.execute({ query: 'что я пью' })) as any

    expect(gemini.models.embedContent).toHaveBeenCalled()
    expect(convRepo.searchByEmbedding).toHaveBeenCalledWith(
      'ws1',
      expect.any(Array),
      expect.objectContaining({ chatId: '100', role: 'any', excludeRecentN: 200 }),
    )
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({
      role: 'user',
      content: 'люблю чай с лимоном',
      externalMessageId: 42,
      similarity: expect.any(Number),
    })
    expect(result.matches[0].similarity).toBeCloseTo(0.925, 2)
  })

  it('recall_messages passes role/since/until/limit through', async () => {
    const convRepo = fakeConvRepo([])
    const gemini = fakeGemini()
    const tools = createRecallTools({
      convRepo,
      gemini,
      workspaceId: 'ws1',
      currentChatId: '100',
      currentChannel: 'telegram',
      runContext: createRunContext(),
    })
    const recall = tools.find((t) => t.name === 'recall_messages')!
    await recall.execute({
      query: 'x',
      role: 'assistant',
      limit: 7,
      since: '2026-01-01',
      until: '2026-12-31',
    })
    expect(convRepo.searchByEmbedding).toHaveBeenCalledWith(
      'ws1',
      expect.any(Array),
      expect.objectContaining({
        role: 'assistant',
        limit: 7,
        since: '2026-01-01',
        until: '2026-12-31',
      }),
    )
  })

  it('recall_messages clamps limit to <= 20', async () => {
    const convRepo = fakeConvRepo([])
    const gemini = fakeGemini()
    const tools = createRecallTools({
      convRepo,
      gemini,
      workspaceId: 'ws1',
      currentChatId: '100',
      currentChannel: 'telegram',
      runContext: createRunContext(),
    })
    const recall = tools.find((t) => t.name === 'recall_messages')!
    await recall.execute({ query: 'x', limit: 999 })
    expect(convRepo.searchByEmbedding).toHaveBeenCalledWith(
      'ws1',
      expect.any(Array),
      expect.objectContaining({ limit: 20 }),
    )
  })

  it('set_reply_target writes into runContext', async () => {
    const convRepo = fakeConvRepo([])
    const gemini = fakeGemini()
    const runContext = createRunContext()
    const tools = createRecallTools({
      convRepo,
      gemini,
      workspaceId: 'ws1',
      currentChatId: '100',
      currentChannel: 'telegram',
      runContext,
    })
    const setReply = tools.find((t) => t.name === 'set_reply_target')!
    const result = (await setReply.execute({ externalMessageId: 42 })) as any
    expect(runContext.replyTarget).toBe(42)
    expect(result.ok).toBe(true)
  })

  it('set_reply_target is a no-op when currentChannel is not telegram', async () => {
    const tools = createRecallTools({
      convRepo: fakeConvRepo([]),
      gemini: fakeGemini(),
      workspaceId: 'ws1',
      currentChatId: '100',
      currentChannel: 'max',
      runContext: createRunContext(),
    })
    const setReply = tools.find((t) => t.name === 'set_reply_target')!
    const result = (await setReply.execute({ externalMessageId: 42 })) as any
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/only telegram/i)
  })
})
