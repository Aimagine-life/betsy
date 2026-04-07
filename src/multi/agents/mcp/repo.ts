/**
 * CRUD over bc_workspace_mcp_servers.
 *
 * All access goes through withWorkspace() so RLS enforces tenant isolation.
 * NEVER pass user input as workspace_id to asAdmin().
 */
import type { Pool } from 'pg'
import { withWorkspace } from '../../db/rls.js'
import type { McpServerConfig, McpTransport } from './types.js'

function rowToConfig(row: any): McpServerConfig {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport as McpTransport,
    command: row.command ?? undefined,
    args: Array.isArray(row.args) ? row.args : [],
    env: row.env && typeof row.env === 'object' ? row.env : {},
    url: row.url ?? undefined,
    enabled: Boolean(row.enabled),
    config: row.config && typeof row.config === 'object' ? row.config : {},
  }
}

export class McpServersRepo {
  constructor(private readonly pool: Pool) {}

  async listServers(workspaceId: string): Promise<McpServerConfig[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const res = await client.query(
        `select id, name, transport, command, args, env, url, enabled, config
           from bc_workspace_mcp_servers
          order by name asc`,
      )
      return res.rows.map(rowToConfig)
    })
  }

  async listEnabled(workspaceId: string): Promise<McpServerConfig[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const res = await client.query(
        `select id, name, transport, command, args, env, url, enabled, config
           from bc_workspace_mcp_servers
          where enabled = true
          order by name asc`,
      )
      return res.rows.map(rowToConfig)
    })
  }

  async upsertServer(
    workspaceId: string,
    cfg: Omit<McpServerConfig, 'id'>,
  ): Promise<McpServerConfig> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const res = await client.query(
        `insert into bc_workspace_mcp_servers
            (workspace_id, name, transport, command, args, env, url, enabled, config)
          values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb)
          on conflict (workspace_id, name) do update set
            transport = excluded.transport,
            command   = excluded.command,
            args      = excluded.args,
            env       = excluded.env,
            url       = excluded.url,
            enabled   = excluded.enabled,
            config    = excluded.config,
            updated_at = now()
          returning id, name, transport, command, args, env, url, enabled, config`,
        [
          workspaceId,
          cfg.name,
          cfg.transport,
          cfg.command ?? null,
          JSON.stringify(cfg.args ?? []),
          JSON.stringify(cfg.env ?? {}),
          cfg.url ?? null,
          cfg.enabled,
          JSON.stringify(cfg.config ?? {}),
        ],
      )
      return rowToConfig(res.rows[0])
    })
  }

  async deleteServer(workspaceId: string, name: string): Promise<boolean> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const res = await client.query(
        `delete from bc_workspace_mcp_servers where name = $1`,
        [name],
      )
      return (res.rowCount ?? 0) > 0
    })
  }

  async setEnabled(
    workspaceId: string,
    name: string,
    enabled: boolean,
  ): Promise<boolean> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const res = await client.query(
        `update bc_workspace_mcp_servers
            set enabled = $1, updated_at = now()
          where name = $2`,
        [enabled, name],
      )
      return (res.rowCount ?? 0) > 0
    })
  }
}
