import type { Pool } from 'pg'
import type { GoogleGenAI } from '@google/genai'
import { withWorkspace } from '../db/rls.js'
import type { Conversation } from './types.js'
import { embedText, toPgVector } from './embeddings.js'
import { log } from '../observability/logger.js'
import { buildConversationSearchSQL } from './conversation-search.js'

function rowToConversation(r: any): Conversation {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    channel: r.channel,
    role: r.role,
    content: r.content,
    toolCalls: r.tool_calls,
    tokensUsed: r.tokens_used,
    meta: r.meta ?? {},
    chatId: r.chat_id ?? null,
    externalMessageId:
      r.external_message_id === null || r.external_message_id === undefined
        ? null
        : Number(r.external_message_id),
    createdAt: r.created_at,
  }
}

export interface AppendInput {
  channel: 'telegram' | 'max' | 'cabinet'
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: unknown
  tokensUsed?: number
  meta?: Record<string, unknown>
  /** Native column — platform chat id (Telegram chat.id stringified). */
  chatId?: string | null
  /** Native column — platform message id (Telegram message_id as bigint). */
  externalMessageId?: number | null
}

/** Minimum content length for embedding. Avoids indexing "ok"/"да"/emoji-only replies. */
const MIN_EMBED_LEN = 10

export class ConversationRepo {
  constructor(
    private pool: Pool,
    /** Optional — when provided, `append` inline-computes embeddings. */
    private gemini?: GoogleGenAI,
  ) {}

  async append(workspaceId: string, input: AppendInput): Promise<Conversation> {
    log().info('convRepo.append: start', {
      workspaceId,
      role: input.role,
      channel: input.channel,
      contentLen: input.content?.length ?? 0,
      hasChatId: input.chatId != null,
      hasExternalMessageId: input.externalMessageId != null,
    })
    try {
      const result = await withWorkspace(this.pool, workspaceId, async (client) => {
        const { rows } = await client.query(
          `insert into bc_conversation
            (workspace_id, channel, role, content, tool_calls, tokens_used, meta, chat_id, external_message_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           returning *`,
          [
            workspaceId,
            input.channel,
            input.role,
            input.content,
            input.toolCalls ? JSON.stringify(input.toolCalls) : null,
            input.tokensUsed ?? 0,
            JSON.stringify(input.meta ?? {}),
            input.chatId ?? null,
            input.externalMessageId ?? null,
          ],
        )
        return rowToConversation(rows[0])
      })
      log().info('convRepo.append: ok', { workspaceId, id: result.id, role: input.role })

      // Inline embedding (best-effort). Runs AFTER the insert succeeds so the
      // message is always persisted. Failure → log + leave embedding NULL.
      if (
        this.gemini &&
        (input.role === 'user' || input.role === 'assistant') &&
        input.content.length >= MIN_EMBED_LEN
      ) {
        this.embedAndStore(workspaceId, result.id, input.content).catch((e) =>
          log().warn('convRepo.append: inline embedding failed (will backfill)', {
            workspaceId,
            id: result.id,
            error: e instanceof Error ? e.message : String(e),
          }),
        )
      }

      return result
    } catch (e) {
      log().error('convRepo.append: failed', {
        workspaceId,
        role: input.role,
        error: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
  }

  /** Internal: embed content and write it to the row. Non-fatal on failure. */
  private async embedAndStore(workspaceId: string, id: string, content: string): Promise<void> {
    if (!this.gemini) return
    const vec = await embedText(this.gemini, content)
    await this.setEmbedding(workspaceId, id, vec)
  }

  /**
   * List messages created after `since`, oldest first.  Used by the Wave 2A
   * LearnerAgent to analyse the last 24 hours of dialogue.  Narrow and
   * additive — does not interact with the summarizer's "active" flag.
   */
  async listSince(
    workspaceId: string,
    since: Date,
    limit: number,
  ): Promise<Conversation[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_conversation
         where created_at >= $1
         order by created_at asc
         limit $2`,
        [since.toISOString(), limit],
      )
      return rows.map(rowToConversation)
    })
  }

  async recent(workspaceId: string, limit: number): Promise<Conversation[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      // Skip messages that have been summarized into a long-term summary fact
      const { rows } = await client.query(
        `select * from bc_conversation
         where coalesce(meta->>'summarized', 'false') <> 'true'
         order by created_at desc
         limit $1`,
        [limit],
      )
      return rows.map(rowToConversation)
    })
  }

  /**
   * Returns the count of NOT-yet-summarized messages — used by the summarizer
   * to decide whether the threshold has been crossed.
   */
  async countActive(workspaceId: string): Promise<number> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select count(*)::int as c
         from bc_conversation
         where coalesce(meta->>'summarized', 'false') <> 'true'`,
      )
      return rows[0].c as number
    })
  }

  /**
   * Returns the OLDEST not-yet-summarized messages, oldest first.
   * The summarizer takes the first N to fold into the summary, leaving the
   * remaining `keepRecent` newest messages alive in the chat history.
   */
  async oldestActive(workspaceId: string, limit: number): Promise<Conversation[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_conversation
         where coalesce(meta->>'summarized', 'false') <> 'true'
         order by created_at asc
         limit $1`,
        [limit],
      )
      return rows.map(rowToConversation)
    })
  }

  /** Marks the given message ids as summarized. */
  async markSummarized(workspaceId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(
        `update bc_conversation
         set meta = coalesce(meta, '{}'::jsonb) || '{"summarized":"true"}'::jsonb
         where id = any($1::uuid[])`,
        [ids],
      )
    })
  }

  /**
   * Delete the messages with the given UUIDs.
   * Returns the number actually deleted.
   */
  async deleteByIds(workspaceId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const result = await client.query(
        `delete from bc_conversation where id = any($1::uuid[])`,
        [ids],
      )
      return result.rowCount ?? 0
    })
  }

  /**
   * Delete all messages whose content matches ANY of the given ILIKE patterns.
   * Returns the number actually deleted. Case-insensitive substring match.
   */
  async deleteMatching(workspaceId: string, patterns: string[]): Promise<number> {
    if (patterns.length === 0) return 0
    return withWorkspace(this.pool, workspaceId, async (client) => {
      // Build an OR of ILIKE clauses
      const clauses = patterns.map((_, i) => `content ilike $${i + 1}`).join(' or ')
      const args = patterns.map((p) => `%${p}%`)
      const result = await client.query(
        `delete from bc_conversation where ${clauses}`,
        args,
      )
      return result.rowCount ?? 0
    })
  }

  /**
   * Delete the N most recent messages (regardless of role).
   * Returns the number actually deleted.
   */
  async deleteRecent(workspaceId: string, count: number): Promise<number> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const result = await client.query(
        `delete from bc_conversation
         where id in (
           select id from bc_conversation
           order by created_at desc
           limit $1
         )`,
        [count],
      )
      return result.rowCount ?? 0
    })
  }

  async purgeAll(workspaceId: string): Promise<number> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const result = await client.query(`delete from bc_conversation`)
      return result.rowCount ?? 0
    })
  }

  async setExternalMessageId(
    workspaceId: string,
    id: string,
    externalMessageId: number,
  ): Promise<void> {
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(
        `update bc_conversation set external_message_id = $1 where id = $2`,
        [externalMessageId, id],
      )
    })
  }

  async setEmbedding(workspaceId: string, id: string, vec: number[]): Promise<void> {
    const pgVec = toPgVector(vec)
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(
        `update bc_conversation set embedding = $1::vector where id = $2`,
        [pgVec, id],
      )
    })
  }

  async searchByEmbedding(
    workspaceId: string,
    queryVec: number[],
    opts: {
      chatId: string
      limit: number
      role?: 'user' | 'assistant' | 'any'
      since?: string
      until?: string
      excludeRecentN?: number
    },
  ): Promise<Array<Conversation & { distance: number }>> {
    const { sql, params } = buildConversationSearchSQL({
      workspaceId,
      queryVecLiteral: toPgVector(queryVec),
      chatId: opts.chatId,
      limit: opts.limit,
      role: opts.role,
      since: opts.since,
      until: opts.until,
      excludeRecentN: opts.excludeRecentN,
    })
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(sql, params)
      return rows.map((r: any) => ({
        ...rowToConversation(r),
        distance: parseFloat(r.distance),
      }))
    })
  }

  async listMissingEmbeddings(workspaceId: string, limit: number): Promise<Conversation[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_conversation
         where embedding is null
           and role in ('user','assistant')
           and length(content) >= 10
           and coalesce(meta->>'summarized', 'false') <> 'true'
         order by created_at asc
         limit $1`,
        [limit],
      )
      return rows.map(rowToConversation)
    })
  }
}
