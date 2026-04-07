import type { Pool } from 'pg'
import { withWorkspace } from '../db/rls.js'
import type { Conversation } from './types.js'
import { log } from '../observability/logger.js'

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
}

export class ConversationRepo {
  constructor(private pool: Pool) {}

  async append(workspaceId: string, input: AppendInput): Promise<Conversation> {
    log().info('convRepo.append: start', {
      workspaceId,
      role: input.role,
      channel: input.channel,
      contentLen: input.content?.length ?? 0,
    })
    try {
      const result = await withWorkspace(this.pool, workspaceId, async (client) => {
        const { rows } = await client.query(
          `insert into bc_conversation
            (workspace_id, channel, role, content, tool_calls, tokens_used, meta)
           values ($1, $2, $3, $4, $5, $6, $7)
           returning *`,
          [
            workspaceId,
            input.channel,
            input.role,
            input.content,
            input.toolCalls ? JSON.stringify(input.toolCalls) : null,
            input.tokensUsed ?? 0,
            JSON.stringify(input.meta ?? {}),
          ],
        )
        return rowToConversation(rows[0])
      })
      log().info('convRepo.append: ok', { workspaceId, id: result.id, role: input.role })
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

  async recent(workspaceId: string, limit: number): Promise<Conversation[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_conversation
         order by created_at desc
         limit $1`,
        [limit],
      )
      return rows.map(rowToConversation)
    })
  }

  async purgeAll(workspaceId: string): Promise<void> {
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(`delete from bc_conversation`)
    })
  }
}
