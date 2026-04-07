import { describe, it, expect, vi } from 'vitest'
import { McpRegistry } from '../../../../src/multi/agents/mcp/registry.js'
import type { McpClient } from '../../../../src/multi/agents/mcp/client.js'
import type { McpServerConfig } from '../../../../src/multi/agents/mcp/types.js'

function fakeRepo(servers: McpServerConfig[]) {
  return {
    listEnabled: vi.fn(async () => servers),
    listServers: vi.fn(async () => servers),
    upsertServer: vi.fn(),
    deleteServer: vi.fn(),
    setEnabled: vi.fn(),
  }
}

function fakeClient(name: string, tools: any[], opts: { fail?: boolean } = {}): McpClient {
  return {
    name,
    listTools: vi.fn(async () => {
      if (opts.fail) throw new Error('connect refused')
      return tools
    }),
    callTool: vi.fn(async () => ({ text: 'ok', isError: false })),
    close: vi.fn(async () => {}),
  } as unknown as McpClient
}

describe('McpRegistry', () => {
  it('loads enabled servers and bridges their tools', async () => {
    const cfg: McpServerConfig = {
      name: 'srvA',
      transport: 'stdio',
      command: 'x',
      enabled: true,
    }
    const repo = fakeRepo([cfg])
    const reg = new McpRegistry({
      pool: {} as any,
      repo: repo as any,
      clientFactory: () =>
        fakeClient('srvA', [
          { name: 't1', inputSchema: { type: 'object', properties: {} } },
          { name: 't2', inputSchema: { type: 'object', properties: {} } },
        ]),
    })
    const loaded = await reg.loadForWorkspace('ws-1')
    const tools = loaded.getTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['mcp__srvA__t1', 'mcp__srvA__t2'])
  })

  it('skips servers that fail to connect', async () => {
    const repo = fakeRepo([
      { name: 'good', transport: 'stdio', command: 'x', enabled: true },
      { name: 'bad', transport: 'stdio', command: 'x', enabled: true },
    ])
    let i = 0
    const reg = new McpRegistry({
      pool: {} as any,
      repo: repo as any,
      clientFactory: () => {
        const isBad = i++ === 1
        return fakeClient(
          isBad ? 'bad' : 'good',
          [{ name: 'ok', inputSchema: { type: 'object', properties: {} } }],
          { fail: isBad },
        )
      },
    })
    const loaded = await reg.loadForWorkspace('ws-1')
    const tools = loaded.getTools()
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('mcp__good__ok')
  })

  it('returns empty registry when repo throws', async () => {
    const repo = {
      listEnabled: vi.fn(async () => {
        throw new Error('db down')
      }),
    }
    const reg = new McpRegistry({ pool: {} as any, repo: repo as any })
    const loaded = await reg.loadForWorkspace('ws-1')
    expect(loaded.getTools()).toEqual([])
  })

  it('closeAll closes every client', async () => {
    const cfg: McpServerConfig = {
      name: 's',
      transport: 'stdio',
      command: 'x',
      enabled: true,
    }
    const fake = fakeClient('s', [{ name: 'a', inputSchema: { type: 'object', properties: {} } }])
    const reg = new McpRegistry({
      pool: {} as any,
      repo: fakeRepo([cfg]) as any,
      clientFactory: () => fake,
    })
    const loaded = await reg.loadForWorkspace('ws-1')
    await loaded.closeAll()
    expect((fake as any).close).toHaveBeenCalled()
  })
})
