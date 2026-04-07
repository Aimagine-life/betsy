/**
 * Per-workspace MCP registry.
 *
 * - Loads enabled MCP server configs from bc_workspace_mcp_servers via repo.
 * - Owns lazy McpClient instances; connect happens on first listTools() call.
 * - Aggregates bridged tools across all servers in a workspace.
 *
 * Designed to be created fresh per agent run (or shared per request scope) —
 * not a process-wide singleton, because workspace_id changes per call.
 */
import type { Pool } from 'pg'
import { McpServersRepo } from './repo.js'
import { McpClient } from './client.js'
import { bridgeMcpTool } from './tool-bridge.js'
import type { McpServerConfig } from './types.js'
import type { MemoryTool } from '../tools/memory-tools.js'
import { log } from '../../observability/logger.js'
import type { OAuthResolver } from './oauth-resolver.js'
import { getBuiltinMcpServer } from './builtin.js'

export interface McpRegistryDeps {
  pool: Pool
  /** Override repo (for tests). */
  repo?: McpServersRepo
  /** Override client constructor (for tests). */
  clientFactory?: (cfg: McpServerConfig) => McpClient
  /** Wave 3c — optional resolver that injects OAuth env vars for builtin
   *  servers whose name matches a BUILTIN_MCP_SERVERS.id with an oauth spec.
   *  When absent, the registry keeps its pre-3c behaviour (env from DB only). */
  oauthResolver?: OAuthResolver
}

export interface LoadedRegistry {
  workspaceId: string
  configs: McpServerConfig[]
  clients: McpClient[]
  /** Bridged tools ready to be appended to the agent's tool list. */
  getTools(): MemoryTool[]
  /** Close all underlying MCP connections. Call at end of agent run. */
  closeAll(): Promise<void>
}

export class McpRegistry {
  private readonly repo: McpServersRepo
  private readonly clientFactory: (cfg: McpServerConfig) => McpClient
  private readonly oauthResolver?: OAuthResolver

  constructor(deps: McpRegistryDeps) {
    this.repo = deps.repo ?? new McpServersRepo(deps.pool)
    this.clientFactory = deps.clientFactory ?? ((cfg) => new McpClient(cfg))
    this.oauthResolver = deps.oauthResolver
  }

  /**
   * Load enabled MCP servers for a workspace and return a lazy registry.
   * Connections are established on demand inside getTools()'s child calls.
   */
  async loadForWorkspace(workspaceId: string): Promise<LoadedRegistry> {
    let configs: McpServerConfig[] = []
    try {
      configs = await this.repo.listEnabled(workspaceId)
    } catch (e) {
      log().warn('mcp: failed to load servers from db', {
        workspaceId,
        error: e instanceof Error ? e.message : String(e),
      })
      configs = []
    }

    const clients: McpClient[] = []
    const tools: MemoryTool[] = []

    for (const rawCfg of configs) {
      // Wave 3c: if a builtin with an oauth spec matches by name, ask the
      // resolver for env vars and merge them over the DB env. If the resolver
      // reports no_token / crypto_error / etc, skip the server gracefully.
      let cfg: McpServerConfig = rawCfg
      if (this.oauthResolver) {
        const builtin = getBuiltinMcpServer(rawCfg.name)
        if (builtin?.oauth) {
          const res = await this.oauthResolver.resolve({
            workspaceId,
            oauth: builtin.oauth,
          })
          if (!res.ok) {
            log().warn('mcp: oauth env unavailable, skipping server', {
              workspaceId,
              server: rawCfg.name,
              reason: res.reason,
            })
            continue
          }
          cfg = {
            ...rawCfg,
            env: { ...(rawCfg.env ?? {}), ...res.env },
          }
        }
      }

      const client = this.clientFactory(cfg)
      clients.push(client)
      try {
        const descriptors = await client.listTools()
        for (const d of descriptors) {
          const bridged = bridgeMcpTool(cfg.name, client, d)
          if (bridged) tools.push(bridged)
        }
        log().info('mcp: loaded server', {
          workspaceId,
          server: cfg.name,
          toolCount: descriptors.length,
        })
      } catch (e) {
        log().warn('mcp: server unavailable, skipping', {
          workspaceId,
          server: cfg.name,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }

    return {
      workspaceId,
      configs,
      clients,
      getTools: () => tools,
      async closeAll() {
        await Promise.all(
          clients.map((c) =>
            c.close().catch((e) =>
              log().warn('mcp: close failed', {
                server: c.name,
                error: e instanceof Error ? e.message : String(e),
              }),
            ),
          ),
        )
      },
    }
  }
}
