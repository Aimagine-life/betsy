import type { Pool } from 'pg'
import { withWorkspace } from '../db/rls.js'
import type { FactKind, MemoryFact } from './types.js'

function rowToFact(r: any): MemoryFact {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind as FactKind,
    content: r.content,
    meta: r.meta ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface RememberInput {
  kind: FactKind
  content: string
  meta?: Record<string, unknown>
}

export class FactsRepo {
  constructor(private pool: Pool) {}

  async remember(workspaceId: string, input: RememberInput): Promise<MemoryFact> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `insert into bc_memory_facts (workspace_id, kind, content, meta)
         values ($1, $2, $3, $4)
         returning *`,
        [workspaceId, input.kind, input.content, JSON.stringify(input.meta ?? {})],
      )
      return rowToFact(rows[0])
    })
  }

  async list(workspaceId: string, limit: number): Promise<MemoryFact[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_memory_facts
         order by created_at desc
         limit $1`,
        [limit],
      )
      return rows.map(rowToFact)
    })
  }

  async listByKind(
    workspaceId: string,
    kind: FactKind,
    limit: number,
  ): Promise<MemoryFact[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_memory_facts
         where kind = $1
         order by created_at desc
         limit $2`,
        [kind, limit],
      )
      return rows.map(rowToFact)
    })
  }

  async forget(workspaceId: string, id: string): Promise<void> {
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(`delete from bc_memory_facts where id = $1`, [id])
    })
  }

  async forgetAll(workspaceId: string): Promise<void> {
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(`delete from bc_memory_facts`)
    })
  }

  async searchByContent(
    workspaceId: string,
    query: string,
    limit: number,
  ): Promise<MemoryFact[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_memory_facts
         where content ilike $1
         order by created_at desc
         limit $2`,
        [`%${query}%`, limit],
      )
      return rows.map(rowToFact)
    })
  }
}
