/**
 * Wave 3c — agent-facing OAuth integration tools.
 *
 * Exposes list/connect/disconnect/status of builtin MCP integrations to
 * the root agent. Connection of OAuth-backed integrations does NOT write
 * tokens directly: it hands back an auth-relay URL that, after user consent,
 * POSTs the token to /oauth/token (see relay-callback.ts).
 *
 * Non-OAuth builtins (e.g. Playwright, Filesystem) can be enabled directly
 * by writing the MCP server row.
 */
import { z } from 'zod'
import type { MemoryTool } from '../agents/tools/memory-tools.js'
import type { OAuthRepo, ListedToken } from './repo.js'
import type { McpServersRepo } from '../agents/mcp/repo.js'
import {
  BUILTIN_MCP_SERVERS,
  getBuiltinMcpServer,
  type BuiltinMcpServer,
} from '../agents/mcp/builtin.js'
import { log } from '../observability/logger.js'

export interface OAuthToolsDeps {
  workspaceId: string
  oauthRepo: OAuthRepo
  /** Optional — when absent, connect/disconnect cannot touch MCP server rows
   *  but list/status still work. */
  mcpServersRepo?: McpServersRepo
  /** Base URL of the auth relay. Default: process.env.BC_AUTH_RELAY_URL ?? 'https://auth.betsyai.io' */
  relayBaseUrl?: string
}

interface IntegrationSummary {
  id: string
  name: string
  description: string
  category: string
  status: 'available' | 'connected'
  accountLabel?: string
  expiresAt?: string
  expired?: boolean
  scopes?: string[]
}

function summarize(
  builtin: BuiltinMcpServer,
  token: ListedToken | undefined,
  includeScopes = false,
): IntegrationSummary {
  const summary: IntegrationSummary = {
    id: builtin.id,
    name: builtin.name,
    description: builtin.description,
    category: builtin.category,
    status: token ? 'connected' : 'available',
  }
  if (token) {
    if (token.accountLabel) summary.accountLabel = token.accountLabel
    if (token.expiresAt) summary.expiresAt = token.expiresAt.toISOString()
    if (typeof token.expired === 'boolean') summary.expired = token.expired
  }
  if (includeScopes && builtin.oauth) {
    summary.scopes = builtin.oauth.scopes
  }
  return summary
}

/**
 * Pick the first token matching a provider with no account_label, to model
 * the "default account" of that provider. Uses listTokens (metadata only —
 * no decryption) to stay cheap.
 */
function pickDefaultToken(tokens: ListedToken[], provider: string): ListedToken | undefined {
  return tokens.find(
    (t) => t.provider === provider && (t.accountLabel === undefined || t.accountLabel === null),
  )
}

function resolveRelayBase(deps: OAuthToolsDeps): string {
  return (
    deps.relayBaseUrl ?? process.env.BC_AUTH_RELAY_URL ?? 'https://auth.betsyai.io'
  ).replace(/\/+$/, '')
}

function buildAuthUrl(
  base: string,
  params: Record<string, string>,
): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    qs.set(k, v)
  }
  return `${base}/start?${qs.toString()}`
}

export function createOAuthTools(deps: OAuthToolsDeps): MemoryTool[] {
  const { workspaceId, oauthRepo, mcpServersRepo } = deps

  const listIntegrations: MemoryTool = {
    name: 'list_integrations',
    description:
      'Показывает доступные интеграции (Google Calendar, Gmail, Drive, Notion, Playwright, Filesystem) и какие из них подключены к этому workspace.',
    parameters: z.object({}),
    async execute(): Promise<unknown> {
      let tokens: ListedToken[] = []
      try {
        tokens = await oauthRepo.listTokens(workspaceId)
      } catch (e) {
        log().warn('list_integrations: listTokens failed', {
          workspaceId,
          error: e instanceof Error ? e.message : String(e),
        })
      }
      const integrations = BUILTIN_MCP_SERVERS.map((b) => {
        const token = b.oauth ? pickDefaultToken(tokens, b.oauth.provider) : undefined
        return summarize(b, token)
      })
      return { integrations }
    },
  }

  const connectIntegration: MemoryTool = {
    name: 'connect_integration',
    description:
      'Начинает подключение интеграции по id. Для OAuth-интеграций возвращает authUrl, который нужно открыть пользователю. Для не-OAuth — просто включает MCP-сервер.',
    parameters: z.object({
      id: z.string().min(1),
      returnTo: z.string().optional(),
    }),
    async execute(params: { id: string; returnTo?: string }): Promise<unknown> {
      const builtin = getBuiltinMcpServer(params.id)
      if (!builtin) return { error: 'unknown integration' }

      if (!builtin.oauth) {
        // Non-OAuth — enable MCP server row directly.
        if (!mcpServersRepo) {
          return { error: 'mcp servers repo not configured' }
        }
        try {
          await mcpServersRepo.upsertServer(workspaceId, {
            name: builtin.id,
            transport: builtin.transport,
            command: builtin.command,
            args: builtin.args ?? [],
            env: builtin.envTemplate ?? {},
            enabled: true,
          })
        } catch (e) {
          log().warn('connect_integration: upsertServer failed', {
            workspaceId,
            id: builtin.id,
            error: e instanceof Error ? e.message : String(e),
          })
          return { error: 'failed to enable integration' }
        }
        return { status: 'enabled', requiresAuth: false }
      }

      // OAuth — return relay auth URL; DB writes happen on callback.
      const base = resolveRelayBase(deps)
      const authUrl = buildAuthUrl(base, {
        provider: builtin.oauth.provider,
        workspace_id: workspaceId,
        integration: builtin.id,
        scopes: builtin.oauth.scopes.join(' '),
        return_to: params.returnTo ?? '',
      })
      return { status: 'redirect', authUrl, requiresAuth: true }
    },
  }

  const disconnectIntegration: MemoryTool = {
    name: 'disconnect_integration',
    description:
      'Отключает интеграцию: удаляет сохранённый OAuth-токен и/или запись MCP-сервера для этого workspace.',
    parameters: z.object({ id: z.string().min(1) }),
    async execute(params: { id: string }): Promise<unknown> {
      const builtin = getBuiltinMcpServer(params.id)
      if (!builtin) return { error: 'unknown integration' }

      const removed: string[] = []

      if (builtin.oauth) {
        try {
          const ok = await oauthRepo.deleteToken(workspaceId, builtin.oauth.provider, undefined)
          if (ok) removed.push('oauth_token')
        } catch (e) {
          log().warn('disconnect_integration: deleteToken failed', {
            workspaceId,
            id: builtin.id,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }

      if (mcpServersRepo) {
        try {
          const ok = await mcpServersRepo.deleteServer(workspaceId, builtin.id)
          if (ok) removed.push('mcp_server')
        } catch (e) {
          log().warn('disconnect_integration: deleteServer failed', {
            workspaceId,
            id: builtin.id,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }

      return { ok: true, removed }
    },
  }

  const integrationStatus: MemoryTool = {
    name: 'integration_status',
    description:
      'Возвращает детальный статус одной интеграции: подключена ли, для какого аккаунта, когда истекает токен, какие scopes.',
    parameters: z.object({ id: z.string().min(1) }),
    async execute(params: { id: string }): Promise<unknown> {
      const builtin = getBuiltinMcpServer(params.id)
      if (!builtin) return { error: 'unknown integration' }

      let tokens: ListedToken[] = []
      try {
        tokens = await oauthRepo.listTokens(workspaceId)
      } catch (e) {
        log().warn('integration_status: listTokens failed', {
          workspaceId,
          id: builtin.id,
          error: e instanceof Error ? e.message : String(e),
        })
      }
      const token = builtin.oauth ? pickDefaultToken(tokens, builtin.oauth.provider) : undefined
      return summarize(builtin, token, true)
    },
  }

  return [listIntegrations, connectIntegration, disconnectIntegration, integrationStatus]
}
