/**
 * Pure SQL builder for semantic search over bc_conversation.
 *
 * Extracted from ConversationRepo so it can be unit-tested without a database.
 * The caller (ConversationRepo.searchByEmbedding) wraps the result in a
 * withWorkspace() RLS-scoped client.query.
 *
 * Hard invariants (unconditional):
 *   - embedding must not be null
 *   - summarized rows (meta.summarized = 'true') are skipped
 *   - results are scoped to the given chat_id
 */

export interface BuildConversationSearchInput {
  workspaceId: string
  queryVecLiteral: string
  chatId: string
  limit: number
  role?: 'user' | 'assistant' | 'any'
  since?: string // ISO date
  until?: string // ISO date
  /** When set, exclude the N most recent rows in this chat (they are already
   *  loaded into live context by loadAgentContext). */
  excludeRecentN?: number
}

export interface BuildConversationSearchResult {
  sql: string
  params: unknown[]
}

export function buildConversationSearchSQL(
  input: BuildConversationSearchInput,
): BuildConversationSearchResult {
  // $1 = queryVec, $2 = chatId, $3 = limit — these three are always present.
  const params: unknown[] = [input.queryVecLiteral, input.chatId, input.limit]
  const whereClauses: string[] = [
    'embedding is not null',
    'chat_id = $2',
    `coalesce(meta->>'summarized', 'false') <> 'true'`,
  ]

  if (input.role && input.role !== 'any') {
    params.push(input.role)
    whereClauses.push(`role = $${params.length}`)
  }

  if (input.since) {
    params.push(input.since)
    whereClauses.push(`created_at >= $${params.length}`)
  }

  if (input.until) {
    params.push(input.until)
    whereClauses.push(`created_at <= $${params.length}`)
  }

  if (input.excludeRecentN && input.excludeRecentN > 0) {
    params.push(input.excludeRecentN)
    whereClauses.push(
      `id not in (
         select id from bc_conversation
         where chat_id = $2
         order by created_at desc
         limit $${params.length}
       )`,
    )
  }

  const sql = `
    select *, embedding <=> $1::vector as distance
    from bc_conversation
    where ${whereClauses.join(' and ')}
    order by embedding <=> $1::vector
    limit $3
  `

  return { sql, params }
}
