/**
 * Workspace-scoped repository for OAuth tokens.
 *
 * Access/refresh tokens are encrypted on write and decrypted on read.
 * All queries go through `withWorkspace` so Postgres RLS enforces isolation.
 * `listTokens` intentionally does NOT decrypt — it only returns metadata.
 */

import type { Pool } from 'pg'
import { withWorkspace } from '../db/rls.js'
import { encryptSecret, decryptSecret } from './crypto.js'

export interface OAuthTokenRecord {
  id: string
  workspaceId: string
  provider: string
  scopes: string[]
  accessToken: string // decrypted
  refreshToken?: string // decrypted
  expiresAt?: Date
  accountLabel?: string
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface UpsertTokenInput {
  provider: string
  scopes?: string[]
  accessToken: string
  refreshToken?: string
  expiresAt?: Date
  accountLabel?: string
  metadata?: Record<string, unknown>
}

export interface ListedToken {
  id: string
  provider: string
  scopes: string[]
  expiresAt?: Date
  accountLabel?: string
  expired: boolean
  createdAt: Date
  updatedAt: Date
}

export class OAuthRepo {
  constructor(private readonly pool: Pool) {}

  async upsertToken(workspaceId: string, input: UpsertTokenInput): Promise<string> {
    const accessEnc = encryptSecret(input.accessToken)
    const refreshEnc = input.refreshToken ? encryptSecret(input.refreshToken) : null
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const res = await client.query<{ id: string }>(
        `INSERT INTO bc_oauth_tokens
           (workspace_id, provider, scopes, access_token, refresh_token, expires_at, account_label, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (workspace_id, provider, COALESCE(account_label, ''))
         DO UPDATE SET
           scopes = EXCLUDED.scopes,
           access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           expires_at = EXCLUDED.expires_at,
           metadata = EXCLUDED.metadata,
           updated_at = now()
         RETURNING id`,
        [
          workspaceId,
          input.provider,
          input.scopes ?? [],
          accessEnc,
          refreshEnc,
          input.expiresAt ?? null,
          input.accountLabel ?? null,
          input.metadata ?? {},
        ],
      )
      return res.rows[0].id
    })
  }

  async getToken(
    workspaceId: string,
    provider: string,
    accountLabel?: string,
  ): Promise<OAuthTokenRecord | null> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const res = await client.query(
        `SELECT * FROM bc_oauth_tokens
         WHERE workspace_id = $1
           AND provider = $2
           AND COALESCE(account_label, '') = COALESCE($3, '')
         LIMIT 1`,
        [workspaceId, provider, accountLabel ?? null],
      )
      if (res.rows.length === 0) return null
      const row = res.rows[0]
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        provider: row.provider,
        scopes: row.scopes,
        accessToken: decryptSecret(row.access_token),
        refreshToken: row.refresh_token ? decryptSecret(row.refresh_token) : undefined,
        expiresAt: row.expires_at ?? undefined,
        accountLabel: row.account_label ?? undefined,
        metadata: row.metadata ?? {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    })
  }

  async listTokens(workspaceId: string): Promise<ListedToken[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const res = await client.query(
        `SELECT id, provider, scopes, expires_at, account_label, created_at, updated_at
         FROM bc_oauth_tokens
         WHERE workspace_id = $1
         ORDER BY created_at DESC`,
        [workspaceId],
      )
      const now = Date.now()
      return res.rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        scopes: r.scopes,
        expiresAt: r.expires_at ?? undefined,
        accountLabel: r.account_label ?? undefined,
        expired: r.expires_at ? new Date(r.expires_at).getTime() < now : false,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }))
    })
  }

  async deleteToken(
    workspaceId: string,
    provider: string,
    accountLabel?: string,
  ): Promise<boolean> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const res = await client.query(
        `DELETE FROM bc_oauth_tokens
         WHERE workspace_id = $1
           AND provider = $2
           AND COALESCE(account_label, '') = COALESCE($3, '')`,
        [workspaceId, provider, accountLabel ?? null],
      )
      return (res.rowCount ?? 0) > 0
    })
  }
}
