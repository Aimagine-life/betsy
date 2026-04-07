import { describe, it, expect, vi } from 'vitest'
import { createMemoryTools } from '../../../../src/multi/agents/tools/memory-tools.js'

function mockFactsRepo() {
  return {
    remember: vi.fn().mockResolvedValue({ id: 'f1', content: 'stored' }),
    list: vi.fn().mockResolvedValue([
      { id: 'f1', kind: 'fact', content: 'Пьёт кофе', createdAt: new Date() },
    ]),
    searchByContent: vi.fn().mockResolvedValue([
      { id: 'f1', kind: 'fact', content: 'Пьёт кофе', createdAt: new Date() },
    ]),
    forgetAll: vi.fn().mockResolvedValue(undefined),
  }
}

describe('createMemoryTools', () => {
  it('remember calls factsRepo.remember with workspaceId', async () => {
    const facts = mockFactsRepo()
    const tools = createMemoryTools({ factsRepo: facts as any, workspaceId: 'ws1' })
    const remember = tools.find((t) => t.name === 'remember')!
    const result = await remember.execute({
      kind: 'fact',
      content: 'Пьёт кофе без сахара',
    })
    expect(facts.remember).toHaveBeenCalledWith('ws1', {
      kind: 'fact',
      content: 'Пьёт кофе без сахара',
    })
    expect(result).toMatchObject({ success: true })
  })

  it('recall searches facts by query', async () => {
    const facts = mockFactsRepo()
    const tools = createMemoryTools({ factsRepo: facts as any, workspaceId: 'ws1' })
    const recall = tools.find((t) => t.name === 'recall')!
    const result = await recall.execute({ query: 'кофе' })
    expect(facts.searchByContent).toHaveBeenCalledWith('ws1', 'кофе', 20)
    expect((result as any).facts).toHaveLength(1)
  })

  it('forget_all wipes memory', async () => {
    const facts = mockFactsRepo()
    const tools = createMemoryTools({ factsRepo: facts as any, workspaceId: 'ws1' })
    const forget = tools.find((t) => t.name === 'forget_all')!
    const result = await forget.execute({ confirm: true })
    expect(facts.forgetAll).toHaveBeenCalledWith('ws1')
    expect((result as any).success).toBe(true)
  })

  it('forget_all refuses without confirm=true', async () => {
    const facts = mockFactsRepo()
    const tools = createMemoryTools({ factsRepo: facts as any, workspaceId: 'ws1' })
    const forget = tools.find((t) => t.name === 'forget_all')!
    const result = await forget.execute({ confirm: false })
    expect(facts.forgetAll).not.toHaveBeenCalled()
    expect((result as any).success).toBe(false)
  })
})
