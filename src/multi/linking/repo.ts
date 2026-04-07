import type { Pool } from 'pg'
import { asAdmin } from '../db/rls.js'
import type { LinkCode } from './types.js'

function rowToLinkCode(r: any): LinkCode {
  return {
    code: r.code,
    workspaceId: r.workspace_id,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  }
}

function generateCode(): string {
  return String(Math.floor(Math.random() * 900000) + 100000)
}

/**
 * LinkCodesRepo uses asAdmin because the incoming user scans/types a code
 * without knowing the workspace_id — we need to look up the code globally.
 */
export class LinkCodesRepo {
  constructor(private pool: Pool) {}

  async create(workspaceId: string, ttlMs: number): Promise<LinkCode> {
    return asAdmin(this.pool, async (client) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateCode()
        const expiresAt = new Date(Date.now() + ttlMs)
        try {
          const { rows } = await client.query(
            `insert into bc_link_codes (code, workspace_id, expires_at)
             values ($1, $2, $3)
             returning *`,
            [code, workspaceId, expiresAt],
          )
          return rowToLinkCode(rows[0])
        } catch (e) {
          if ((e as any).code === '23505') continue
          throw e
        }
      }
      throw new Error('failed to generate unique link code after 5 attempts')
    })
  }

  async findByCode(code: string): Promise<LinkCode | null> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `select * from bc_link_codes where code = $1 and expires_at > now()`,
        [code],
      )
      return rows[0] ? rowToLinkCode(rows[0]) : null
    })
  }

  async consume(code: string): Promise<LinkCode | null> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `delete from bc_link_codes
         where code = $1 and expires_at > now()
         returning *`,
        [code],
      )
      return rows[0] ? rowToLinkCode(rows[0]) : null
    })
  }

  async countRecentForWorkspace(workspaceId: string, windowMs: number): Promise<number> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `select count(*)::int as c
         from bc_link_codes
         where workspace_id = $1 and created_at > now() - ($2::bigint || ' milliseconds')::interval`,
        [workspaceId, windowMs],
      )
      return rows[0].c as number
    })
  }

  async cleanup(): Promise<number> {
    return asAdmin(this.pool, async (client) => {
      const { rowCount } = await client.query(
        `delete from bc_link_codes where expires_at < now()`,
      )
      return rowCount ?? 0
    })
  }
}
