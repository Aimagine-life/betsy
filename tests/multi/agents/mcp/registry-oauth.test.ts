import { describe, it, expect, vi } from 'vitest'
import { McpRegistry } from '../../../../src/multi/agents/mcp/registry.js'
import type { McpClient } from '../../../../src/multi/agents/mcp/client.js'
import type { McpServerConfig } from '../../../../src/multi/agents/mcp/types.js'
import type { OAuthResolver, ResolveOAuthEnvResult } from '../../../../src/multi/agents/mcp/oauth-resolver.js'

function fakeRepo(servers: McpServerConfig[]) {
  return {
    listEnabled: vi.fn(async () => servers),
    listServers: vi.fn(async () => servers),
    upsertServer: vi.fn(),
    deleteServer: vi.fn(),
    setEnabled: vi.fn(),
  }
}

function fakeClient(name: string): McpClient {
  return {
    name,
    listTools: vi.fn(async () => [
      { name: 't', inputSchema: { type: 'object', properties: {} } },
    ]),
    callTool: vi.fn(),
    close: vi.fn(async () => {}),
  } as unknown as McpClient
}

function mkResolver(result: ResolveOAuthEnvResult): OAuthResolver {
  return { resolve: vi.fn(async () => result) } as unknown as OAuthResolver
}

describe('McpRegistry + OAuthResolver', () => {
  it('no resolver → env from DB only (pre-3c behaviour)', async () => {
    const cfg: McpServerConfig = {
      name: 'gcal',
      transport: 'stdio',
      command: 'x',
      env: { FOO: 'bar' },
      enabled: true,
    }
    const received: McpServerConfig[] = []
    const reg = new McpRegistry({
      pool: {} as any,
      repo: fakeRepo([cfg]) as any,
      clientFactory: (c) => {
        received.push(c)
        return fakeClient(c.name)
      },
    })
    await reg.loadForWorkspace('ws-1')
    expect(received[0].env).toEqual({ FOO: 'bar' })
  })

  it('resolver present, builtin without oauth (fs) → resolver NOT called', async () => {
    const cfg: McpServerConfig = {
      name: 'fs',
      transport: 'stdio',
      command: 'x',
      env: { KEEP: '1' },
      enabled: true,
    }
    const resolver = mkResolver({ ok: true, env: { INJECTED: 'yes' } })
    const received: McpServerConfig[] = []
    const reg = new McpRegistry({
      pool: {} as any,
      repo: fakeRepo([cfg]) as any,
      oauthResolver: resolver,
      clientFactory: (c) => {
        received.push(c)
        return fakeClient(c.name)
      },
    })
    await reg.loadForWorkspace('ws-1')
    expect((resolver as any).resolve).not.toHaveBeenCalled()
    expect(received[0].env).toEqual({ KEEP: '1' })
  })

  it('resolver ok=true for builtin with oauth → env merged (oauth wins)', async () => {
    const cfg: McpServerConfig = {
      name: 'gcal',
      transport: 'stdio',
      command: 'x',
      env: { GOOGLE_OAUTH_ACCESS_TOKEN: 'OLD', FROM_DB: 'yes' },
      enabled: true,
    }
    const resolver = mkResolver({
      ok: true,
      env: { GOOGLE_OAUTH_ACCESS_TOKEN: 'FRESH', GOOGLE_OAUTH_REFRESH_TOKEN: 'RT' },
    })
    const received: McpServerConfig[] = []
    const reg = new McpRegistry({
      pool: {} as any,
      repo: fakeRepo([cfg]) as any,
      oauthResolver: resolver,
      clientFactory: (c) => {
        received.push(c)
        return fakeClient(c.name)
      },
    })
    await reg.loadForWorkspace('ws-1')
    expect(received[0].env).toEqual({
      FROM_DB: 'yes',
      GOOGLE_OAUTH_ACCESS_TOKEN: 'FRESH',
      GOOGLE_OAUTH_REFRESH_TOKEN: 'RT',
    })
  })

  it('resolver ok=false (no_token) for builtin with oauth → server skipped', async () => {
    const cfg: McpServerConfig = {
      name: 'gcal',
      transport: 'stdio',
      command: 'x',
      enabled: true,
    }
    const resolver = mkResolver({ ok: false, reason: 'no_token' })
    const factory = vi.fn((c: McpServerConfig) => fakeClient(c.name))
    const reg = new McpRegistry({
      pool: {} as any,
      repo: fakeRepo([cfg]) as any,
      oauthResolver: resolver,
      clientFactory: factory,
    })
    const loaded = await reg.loadForWorkspace('ws-1')
    expect(factory).not.toHaveBeenCalled()
    expect(loaded.getTools()).toEqual([])
  })

  it('server name not in builtin catalog → resolver NOT called', async () => {
    const cfg: McpServerConfig = {
      name: 'custom-xyz',
      transport: 'stdio',
      command: 'x',
      enabled: true,
    }
    const resolver = mkResolver({ ok: true, env: { X: 'y' } })
    const reg = new McpRegistry({
      pool: {} as any,
      repo: fakeRepo([cfg]) as any,
      oauthResolver: resolver,
      clientFactory: (c) => fakeClient(c.name),
    })
    await reg.loadForWorkspace('ws-1')
    expect((resolver as any).resolve).not.toHaveBeenCalled()
  })
})
