import { describe, it, expect } from 'vitest'
import { buildConversationSearchSQL } from '../../../src/multi/memory/conversation-search.js'

describe('buildConversationSearchSQL', () => {
  it('builds the minimal query with just workspace + chat', () => {
    const { sql, params } = buildConversationSearchSQL({
      workspaceId: 'ws1',
      queryVecLiteral: '[0.1,0.2]',
      chatId: 'chat1',
      limit: 5,
    })
    expect(sql).toContain("embedding <=> $1::vector as distance")
    expect(sql).toContain('chat_id = $2')
    expect(sql).toContain('order by embedding <=> $1::vector')
    expect(sql).toContain('limit $3')
    expect(params).toEqual(['[0.1,0.2]', 'chat1', 5])
  })

  it('adds role filter when specified', () => {
    const { sql, params } = buildConversationSearchSQL({
      workspaceId: 'ws1',
      queryVecLiteral: '[0]',
      chatId: 'c',
      limit: 3,
      role: 'user',
    })
    expect(sql).toContain('role = $4')
    expect(params).toContain('user')
  })

  it('omits role filter when role = any', () => {
    const { sql } = buildConversationSearchSQL({
      workspaceId: 'ws1',
      queryVecLiteral: '[0]',
      chatId: 'c',
      limit: 3,
      role: 'any',
    })
    expect(sql).not.toContain('role =')
  })

  it('adds since/until filters', () => {
    const { sql, params } = buildConversationSearchSQL({
      workspaceId: 'ws1',
      queryVecLiteral: '[0]',
      chatId: 'c',
      limit: 3,
      since: '2026-01-01',
      until: '2026-12-31',
    })
    expect(sql).toContain('created_at >=')
    expect(sql).toContain('created_at <=')
    expect(params).toContain('2026-01-01')
    expect(params).toContain('2026-12-31')
  })

  it('excludes the most recent N rows via NOT IN subquery', () => {
    const { sql, params } = buildConversationSearchSQL({
      workspaceId: 'ws1',
      queryVecLiteral: '[0]',
      chatId: 'c',
      limit: 5,
      excludeRecentN: 200,
    })
    expect(sql).toContain('not in (')
    expect(sql).toContain('order by created_at desc')
    expect(params).toContain(200)
  })

  it('always skips summarized rows and null embeddings', () => {
    const { sql } = buildConversationSearchSQL({
      workspaceId: 'ws1',
      queryVecLiteral: '[0]',
      chatId: 'c',
      limit: 3,
    })
    expect(sql).toContain('embedding is not null')
    expect(sql).toContain("coalesce(meta->>'summarized', 'false') <> 'true'")
  })
})
