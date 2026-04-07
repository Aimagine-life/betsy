import { describe, it, expect, vi } from 'vitest'
import { createOAuthTools } from '../../../src/multi/oauth/oauth-tools.js'
import type { OAuthRepo, ListedToken } from '../../../src/multi/oauth/repo.js'
import type { McpServersRepo } from '../../../src/multi/agents/mcp/repo.js'
import { BUILTIN_MCP_SERVERS } from '../../../src/multi/agents/mcp/builtin.js'

function mkRepo(tokens: ListedToken[] = []): OAuthRepo {
  return {
    listTokens: vi.fn(async () => tokens),
    getToken: vi.fn(async () => null),
    upsertToken: vi.fn(async () => 'id'),
    deleteToken: vi.fn(async () => true),
  } as unknown as OAuthRepo
}

function mkMcpRepo(): McpServersRepo {
  return {
    upsertServer: vi.fn(async () => ({ id: 'x', name: 'fs', transport: 'stdio', enabled: true, args: [], env: {}, config: {} })),
    deleteServer: vi.fn(async () => true),
    listServers: vi.fn(async () => []),
    listEnabled: vi.fn(async () => []),
    setEnabled: vi.fn(async () => true),
  } as unknown as McpServersRepo
}

const WS = '11111111-1111-1111-1111-111111111111'

function getTool(tools: ReturnType<typeof createOAuthTools>, name: string) {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool not found: ${name}`)
  return t
}

describe('oauth-tools: list_integrations', () => {
  it('all available when no tokens', async () => {
    const tools = createOAuthTools({
      workspaceId: WS,
      oauthRepo: mkRepo([]),
      mcpServersRepo: mkMcpRepo(),
    })
    const res: any = await getTool(tools, 'list_integrations').execute({})
    expect(res.integrations).toHaveLength(BUILTIN_MCP_SERVERS.length)
    for (const i of res.integrations) expect(i.status).toBe('available')
  })

  it('gcal connected when google token present', async () => {
    const exp = new Date(Date.now() + 3600_000)
    const tokens: ListedToken[] = [
      {
        id: 't1',
        provider: 'google',
        scopes: ['x'],
        expiresAt: exp,
        accountLabel: 'me@example.com',
        expired: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]
    const tools = createOAuthTools({
      workspaceId: WS,
      oauthRepo: mkRepo(tokens),
      mcpServersRepo: mkMcpRepo(),
    })
    // default token picked up is account_label=undefined ones — but here label is set.
    // So gcal should still be 'available'. Add one without label too.
    tokens.push({
      id: 't2',
      provider: 'google',
      scopes: ['x'],
      expiresAt: exp,
      accountLabel: undefined,
      expired: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const res: any = await getTool(tools, 'list_integrations').execute({})
    const gcal = res.integrations.find((i: any) => i.id === 'gcal')
    expect(gcal.status).toBe('connected')
    expect(gcal.expiresAt).toBe(exp.toISOString())
    expect(gcal.expired).toBe(false)
  })

  it('uses listTokens (not getToken/decrypt)', async () => {
    const repo = mkRepo([])
    const tools = createOAuthTools({
      workspaceId: WS,
      oauthRepo: repo,
      mcpServersRepo: mkMcpRepo(),
    })
    await getTool(tools, 'list_integrations').execute({})
    expect(repo.listTokens).toHaveBeenCalled()
    expect((repo as any).getToken).not.toHaveBeenCalled()
  })
})

describe('oauth-tools: connect_integration', () => {
  it('unknown id returns error', async () => {
    const tools = createOAuthTools({
      workspaceId: WS,
      oauthRepo: mkRepo(),
      mcpServersRepo: mkMcpRepo(),
    })
    const res: any = await getTool(tools, 'connect_integration').execute({ id: 'bogus' })
    expect(res.error).toBeTruthy()
  })

  it('non-oauth (fs) enables MCP server row directly', async () => {
    const mcp = mkMcpRepo()
    const tools = createOAuthTools({
      workspaceId: WS,
      oauthRepo: mkRepo(),
      mcpServersRepo: mcp,
    })
    const res: any = await getTool(tools, 'connect_integration').execute({ id: 'fs' })
    expect(res).toEqual({ status: 'enabled', requiresAuth: false })
    expect(mcp.upsertServer).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ name: 'fs', enabled: true }),
    )
  })

  it('oauth integration returns relay URL and does NOT write MCP row', async () => {
    const mcp = mkMcpRepo()
    const tools = createOAuthTools({
      workspaceId: WS,
      oauthRepo: mkRepo(),
      mcpServersRepo: mcp,
      relayBaseUrl: 'https://auth.example.com',
    })
    const res: any = await getTool(tools, 'connect_integration').execute({ id: 'gcal' })
    expect(res.status).toBe('redirect')
    expect(res.requiresAuth).toBe(true)
    expect(res.authUrl).toContain('https://auth.example.com/start?')
    expect(res.authUrl).toContain('provider=google')
    expect(res.authUrl).toContain(`workspace_id=${WS}`)
    expect(res.authUrl).toContain('integration=gcal')
    expect(mcp.upsertServer).not.toHaveBeenCalled()
  })

  it('url encodes scopes (spaces as %20 or +)', async () => {
    const tools = createOAuthTools({
      workspaceId: WS,
      oauthRepo: mkRepo(),
      mcpServersRepo: mkMcpRepo(),
      relayBaseUrl: 'https://auth.example.com',
    })
    const res: any = await getTool(tools, 'connect_integration').execute({ id: 'gmail' })
    // URLSearchParams encodes spaces as '+' and slashes as %2F
    expect(res.authUrl).toMatch(/scopes=[^&]*gmail\.readonly/)
    expect(res.authUrl).toMatch(/\+https%3A%2F%2F[^&]*gmail\.send/)
  })

  it('relayBaseUrl override via deps', async () => {
    const tools = createOAuthTools({
      workspaceId: WS,
      oauthRepo: mkRepo(),
      mcpServersRepo: mkMcpRepo(),
      relayBaseUrl: 'https://custom.relay.test/',
    })
    const res: any = await getTool(tools, 'connect_integration').execute({ id: 'notion' })
    expect(res.authUrl.startsWith('https://custom.relay.test/start?')).toBe(true)
  })
})

describe('oauth-tools: disconnect_integration', () => {
  it('existing with oauth removes token AND mcp server', async () => {
    const repo = mkRepo()
    const mcp = mkMcpRepo()
    const tools = createOAuthTools({
      workspaceId: WS,
      oauthRepo: repo,
      mcpServersRepo: mcp,
    })
    const res: any = await getTool(tools, 'disconnect_integration').execute({ id: 'gcal' })
    expect(res.ok).toBe(true)
    expect(res.removed).toContain('oauth_token')
    expect(res.removed).toContain('mcp_server')
    expect(repo.deleteToken).toHaveBeenCalledWith(WS, 'google', undefined)
    expect(mcp.deleteServer).toHaveBeenCalledWith(WS, 'gcal')
  })

  it('non-oauth integration only removes MCP server', async () => {
    const repo = mkRepo()
    const mcp = mkMcpRepo()
    const tools = createOAuthTools({
      workspaceId: WS,
      oauthRepo: repo,
      mcpServersRepo: mcp,
    })
    const res: any = await getTool(tools, 'disconnect_integration').execute({ id: 'fs' })
    expect(res.removed).not.toContain('oauth_token')
    expect(res.removed).toContain('mcp_server')
    expect(repo.deleteToken).not.toHaveBeenCalled()
  })
})

describe('oauth-tools: integration_status', () => {
  it('unknown returns error', async () => {
    const tools = createOAuthTools({
      workspaceId: WS,
      oauthRepo: mkRepo(),
      mcpServersRepo: mkMcpRepo(),
    })
    const res: any = await getTool(tools, 'integration_status').execute({ id: 'bogus' })
    expect(res.error).toBeTruthy()
  })

  it('connected integration returns scopes and details', async () => {
    const tokens: ListedToken[] = [
      {
        id: 't1',
        provider: 'google',
        scopes: ['x'],
        expiresAt: new Date(Date.now() + 3600_000),
        accountLabel: undefined,
        expired: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]
    const tools = createOAuthTools({
      workspaceId: WS,
      oauthRepo: mkRepo(tokens),
      mcpServersRepo: mkMcpRepo(),
    })
    const res: any = await getTool(tools, 'integration_status').execute({ id: 'gcal' })
    expect(res.status).toBe('connected')
    expect(Array.isArray(res.scopes)).toBe(true)
    expect(res.scopes.length).toBeGreaterThan(0)
  })
})
