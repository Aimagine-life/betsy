import { describe, it, expect, vi } from 'vitest'
import { loadAgentContext } from '../../../src/multi/agents/context-loader.js'

describe('loadAgentContext', () => {
  it('loads facts and formats conversation history', async () => {
    const factsRepo = {
      list: vi.fn().mockResolvedValue([
        { id: '1', kind: 'fact', content: 'Пьёт кофе без сахара' },
        { id: '2', kind: 'fact', content: 'Работает в Wildbots' },
        { id: '3', kind: 'preference', content: 'Любит котов' },
      ]),
    }
    const convRepo = {
      recent: vi.fn().mockResolvedValue([
        { role: 'assistant', content: 'Привет!', channel: 'telegram' },
        { role: 'user', content: 'Как дела?', channel: 'telegram' },
      ]),
    }
    const out = await loadAgentContext({
      factsRepo: factsRepo as any,
      convRepo: convRepo as any,
      workspaceId: 'ws1',
      factLimit: 50,
      historyLimit: 20,
    })
    expect(out.factContents).toHaveLength(3)
    expect(out.factContents[0]).toContain('кофе')
    expect(out.history).toHaveLength(2)
    expect(out.history[0].role).toBe('user')
    expect(out.history[1].role).toBe('assistant')
  })

  it('returns empty arrays when nothing stored', async () => {
    const factsRepo = { list: vi.fn().mockResolvedValue([]) }
    const convRepo = { recent: vi.fn().mockResolvedValue([]) }
    const out = await loadAgentContext({
      factsRepo: factsRepo as any,
      convRepo: convRepo as any,
      workspaceId: 'ws1',
      factLimit: 50,
      historyLimit: 20,
    })
    expect(out.factContents).toEqual([])
    expect(out.history).toEqual([])
  })
})
