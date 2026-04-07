import type { Pool } from 'pg'
import type { GoogleGenAI } from '@google/genai'
import { withWorkspace } from '../db/rls.js'
import { embedText, toPgVector } from './embeddings.js'
import { log } from '../observability/logger.js'
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
  constructor(
    private pool: Pool,
    /** Optional Gemini client for computing embeddings on remember(). */
    private gemini?: GoogleGenAI,
  ) {}

  async remember(workspaceId: string, input: RememberInput): Promise<MemoryFact> {
    // Attempt to compute embedding; on failure fall back to null (non-breaking)
    let embeddingLiteral: string | null = null
    if (this.gemini) {
      try {
        const vec = await embedText(this.gemini, input.content)
        embeddingLiteral = toPgVector(vec)
      } catch (e) {
        log().warn('factsRepo.remember: embedding failed, inserting with null embedding', {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }

    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `insert into bc_memory_facts (workspace_id, kind, content, meta, embedding)
         values ($1, $2, $3, $4, $5::vector)
         returning *`,
        [workspaceId, input.kind, input.content, JSON.stringify(input.meta ?? {}), embeddingLiteral],
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

  /**
   * Internal: semantic search returning facts + cosine distance from the query vector.
   * Distance is 0 = identical, 1 = orthogonal (pgvector cosine distance = 1 - similarity).
   */
  async searchByEmbeddingWithDistance(
    workspaceId: string,
    queryVec: number[],
    limit: number,
    kindsToExclude?: FactKind[],
  ): Promise<Array<MemoryFact & { distance: number }>> {
    const pgVec = toPgVector(queryVec)

    return withWorkspace(this.pool, workspaceId, async (client) => {
      let sql: string
      let params: unknown[]

      if (kindsToExclude && kindsToExclude.length > 0) {
        sql = `
          select *, embedding <=> $1::vector as distance
          from bc_memory_facts
          where embedding is not null
            and kind <> all($3::text[])
          order by embedding <=> $1::vector
          limit $2`
        params = [pgVec, limit, kindsToExclude]
      } else {
        sql = `
          select *, embedding <=> $1::vector as distance
          from bc_memory_facts
          where embedding is not null
          order by embedding <=> $1::vector
          limit $2`
        params = [pgVec, limit]
      }

      const { rows } = await client.query(sql, params)
      return rows.map((r: any) => ({
        ...rowToFact(r),
        distance: parseFloat(r.distance),
      }))
    })
  }

  /**
   * Semantic nearest-neighbour search using the pre-computed embedding column.
   * Only returns facts that already have an embedding (null rows are skipped).
   * Distance is stripped — use {@link searchByEmbeddingWithDistance} internally
   * when you need it (e.g. dedup).
   */
  async searchByEmbedding(
    workspaceId: string,
    queryVec: number[],
    limit: number,
    kindsToExclude?: FactKind[],
  ): Promise<MemoryFact[]> {
    const rows = await this.searchByEmbeddingWithDistance(workspaceId, queryVec, limit, kindsToExclude)
    return rows.map(({ distance: _d, ...fact }) => fact as MemoryFact)
  }

  /**
   * Return up to `limit` facts that have no embedding yet (for background backfill).
   */
  async listMissingEmbeddings(workspaceId: string, limit: number): Promise<MemoryFact[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_memory_facts
         where embedding is null
         order by created_at asc
         limit $1`,
        [limit],
      )
      return rows.map(rowToFact)
    })
  }

  /**
   * Update the embedding for a single fact (used by the background backfill task).
   */
  async setEmbedding(workspaceId: string, id: string, vec: number[]): Promise<void> {
    const pgVec = toPgVector(vec)
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(
        `update bc_memory_facts set embedding = $1::vector where id = $2`,
        [pgVec, id],
      )
    })
  }
}
