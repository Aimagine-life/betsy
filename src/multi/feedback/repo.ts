import type { Pool } from 'pg'
import { withWorkspace } from '../db/rls.js'
import type { FeedbackEntry, RecordFeedbackInput } from './types.js'

function rowToFeedback(r: any): FeedbackEntry {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    conversationId: r.conversation_id ?? undefined,
    channel: r.channel,
    chatId: r.chat_id,
    messageId: r.message_id,
    rating: Number(r.rating) as 1 | -1,
    reason: r.reason ?? undefined,
    rawText: r.raw_text ?? undefined,
    userMessage: r.user_message ?? undefined,
    createdAt: r.created_at,
  }
}

export class FeedbackRepo {
  constructor(private readonly pool: Pool) {}

  /** Insert or overwrite a feedback entry. Uniqueness is (workspace, channel,
   *  message_id) — a double-click just updates the rating. */
  async record(input: RecordFeedbackInput): Promise<FeedbackEntry> {
    return withWorkspace(this.pool, input.workspaceId, async (client) => {
      const { rows } = await client.query(
        `insert into bc_feedback
           (workspace_id, conversation_id, channel, chat_id, message_id,
            rating, reason, raw_text, user_message)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (workspace_id, channel, message_id) do update set
           rating = excluded.rating,
           reason = excluded.reason,
           raw_text = coalesce(bc_feedback.raw_text, excluded.raw_text),
           user_message = coalesce(bc_feedback.user_message, excluded.user_message),
           conversation_id = coalesce(bc_feedback.conversation_id, excluded.conversation_id)
         returning *`,
        [
          input.workspaceId,
          input.conversationId ?? null,
          input.channel,
          input.chatId,
          input.messageId,
          input.rating,
          input.reason ?? null,
          input.rawText ?? null,
          input.userMessage ?? null,
        ],
      )
      return rowToFeedback(rows[0])
    })
  }

  /** Returns the most recent feedback entries, newest first. */
  async listRecent(workspaceId: string, limit: number): Promise<FeedbackEntry[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_feedback order by created_at desc limit $1`,
        [limit],
      )
      return rows.map(rowToFeedback)
    })
  }

  /** Aggregate counts over the last `sinceDays` days. */
  async countByRating(
    workspaceId: string,
    sinceDays: number,
  ): Promise<{ thumbsUp: number; thumbsDown: number }> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select
           sum(case when rating =  1 then 1 else 0 end)::int as up,
           sum(case when rating = -1 then 1 else 0 end)::int as down
         from bc_feedback
         where created_at >= now() - ($1 || ' days')::interval`,
        [String(sinceDays)],
      )
      return {
        thumbsUp: rows[0]?.up ?? 0,
        thumbsDown: rows[0]?.down ?? 0,
      }
    })
  }

  /** Look up an existing feedback row by its channel message id. */
  async getByMessage(
    workspaceId: string,
    channel: 'telegram' | 'max',
    messageId: string,
  ): Promise<FeedbackEntry | null> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_feedback
         where channel = $1 and message_id = $2
         limit 1`,
        [channel, messageId],
      )
      return rows.length > 0 ? rowToFeedback(rows[0]) : null
    })
  }
}
