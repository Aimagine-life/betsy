import { describe, it, expect, vi } from 'vitest'
import { McpClient } from '../../../../src/multi/agents/mcp/client.js'

function fakeSdkClient(opts: {
  listTools?: () => Promise<any>
  callTool?: (p: any) => Promise<any>
  connect?: () => Promise<void>
}) {
  return {
    connect: vi.fn(opts.connect ?? (async () => {})),
    listTools: vi.fn(opts.listTools ?? (async () => ({ tools: [] }))),
    callTool: vi.fn(opts.callTool ?? (async () => ({ content: [] }))),
    close: vi.fn(async () => {}),
  }
}

describe('McpClient', () => {
  it('listTools happy path', async () => {
    const fake = fakeSdkClient({
      listTools: async () => ({
        tools: [
          {
            name: 'echo',
            description: 'echoes',
            inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
          },
        ],
      }),
    })
    const c = new McpClient(
      { name: 's', transport: 'stdio', command: 'node', enabled: true },
      { clientFactory: () => fake },
    )
    const tools = await c.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('echo')
    expect(fake.connect).toHaveBeenCalledOnce()
  })

  it('callTool aggregates text content blocks', async () => {
    const fake = fakeSdkClient({
      callTool: async () => ({
        content: [
          { type: 'text', text: 'line1' },
          { type: 'text', text: 'line2' },
          { type: 'image', data: 'ignored' },
        ],
        isError: false,
      }),
    })
    const c = new McpClient(
      { name: 's', transport: 'stdio', command: 'node', enabled: true },
      { clientFactory: () => fake },
    )
    const r = await c.callTool('do', { x: 1 })
    expect(r.text).toBe('line1\nline2')
    expect(r.isError).toBe(false)
  })

  it('connect is idempotent', async () => {
    const fake = fakeSdkClient({})
    const c = new McpClient(
      { name: 's', transport: 'stdio', command: 'node', enabled: true },
      { clientFactory: () => fake },
    )
    await c.connect()
    await c.connect()
    await c.connect()
    expect(fake.connect).toHaveBeenCalledTimes(1)
  })

  it('listTools propagates failure after retry', async () => {
    let attempts = 0
    const fake = fakeSdkClient({
      listTools: async () => {
        attempts++
        throw new Error('boom')
      },
    })
    const c = new McpClient(
      { name: 's', transport: 'stdio', command: 'node', enabled: true },
      { clientFactory: () => fake, timeoutMs: 500 },
    )
    await expect(c.listTools()).rejects.toThrow('boom')
    expect(attempts).toBeGreaterThanOrEqual(2) // initial + 1 retry
  })

  it('times out a hanging call', async () => {
    const fake = fakeSdkClient({
      listTools: () => new Promise(() => {}),
    })
    const c = new McpClient(
      { name: 's', transport: 'stdio', command: 'node', enabled: true },
      { clientFactory: () => fake, timeoutMs: 50 },
    )
    await expect(c.listTools()).rejects.toThrow(/timed out/)
  })

  it('rejects stdio without command', async () => {
    const c = new McpClient(
      { name: 's', transport: 'stdio', enabled: true } as any,
      { clientFactory: () => fakeSdkClient({}) },
    )
    await expect(c.connect()).rejects.toThrow(/stdio requires command/)
  })
})
