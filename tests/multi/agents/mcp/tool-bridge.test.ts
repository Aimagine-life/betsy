import { describe, it, expect, vi } from 'vitest'
import { jsonSchemaToZod, bridgeMcpTool } from '../../../../src/multi/agents/mcp/tool-bridge.js'
import type { McpClient } from '../../../../src/multi/agents/mcp/client.js'

describe('jsonSchemaToZod', () => {
  it('handles primitives', () => {
    expect(jsonSchemaToZod({ type: 'string' }).safeParse('hi').success).toBe(true)
    expect(jsonSchemaToZod({ type: 'number' }).safeParse(3).success).toBe(true)
    expect(jsonSchemaToZod({ type: 'integer' }).safeParse(3.5).success).toBe(false)
    expect(jsonSchemaToZod({ type: 'boolean' }).safeParse(true).success).toBe(true)
  })

  it('handles object with required fields', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
      required: ['name'],
    }
    const z = jsonSchemaToZod(schema)
    expect(z.safeParse({ name: 'Lara' }).success).toBe(true)
    expect(z.safeParse({ name: 'Lara', age: 30 }).success).toBe(true)
    expect(z.safeParse({ age: 30 }).success).toBe(false)
  })

  it('handles enums', () => {
    const z = jsonSchemaToZod({ enum: ['a', 'b', 'c'] })
    expect(z.safeParse('a').success).toBe(true)
    expect(z.safeParse('z').success).toBe(false)
  })

  it('handles arrays', () => {
    const z = jsonSchemaToZod({ type: 'array', items: { type: 'string' } })
    expect(z.safeParse(['x', 'y']).success).toBe(true)
    expect(z.safeParse([1, 2]).success).toBe(false)
  })

  it('passes through extra object fields', () => {
    const z = jsonSchemaToZod({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    })
    expect(z.safeParse({ a: 'x', extra: 1 }).success).toBe(true)
  })

  it('falls back to z.any for unknown shapes', () => {
    const z = jsonSchemaToZod({})
    expect(z.safeParse({ anything: true }).success).toBe(true)
  })
})

describe('bridgeMcpTool', () => {
  function fakeClient(callImpl: (n: string, a: any) => Promise<any>): McpClient {
    return {
      name: 'srv',
      callTool: vi.fn(callImpl),
    } as unknown as McpClient
  }

  it('returns a MemoryTool with prefixed name', () => {
    const client = fakeClient(async () => ({ text: 'ok', isError: false }))
    const tool = bridgeMcpTool('my-srv', client, {
      name: 'do_thing',
      description: 'does',
      inputSchema: { type: 'object', properties: {} },
    })!
    expect(tool).not.toBeNull()
    expect(tool.name).toBe('mcp__my_srv__do_thing')
  })

  it('execute returns text payload on success', async () => {
    const client = fakeClient(async () => ({ text: 'hello world', isError: false }))
    const tool = bridgeMcpTool('s', client, {
      name: 'echo',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
    })!
    const result = await tool.execute({ msg: 'hi' })
    expect(result).toEqual({ text: 'hello world' })
  })

  it('execute marks error when isError=true', async () => {
    const client = fakeClient(async () => ({ text: 'boom', isError: true }))
    const tool = bridgeMcpTool('s', client, {
      name: 'fail',
      inputSchema: { type: 'object', properties: {} },
    })!
    const result: any = await tool.execute({})
    expect(result.isError).toBe(true)
  })

  it('execute catches thrown errors', async () => {
    const client = fakeClient(async () => {
      throw new Error('network down')
    })
    const tool = bridgeMcpTool('s', client, {
      name: 'broken',
      inputSchema: { type: 'object', properties: {} },
    })!
    const result: any = await tool.execute({})
    expect(result.isError).toBe(true)
    expect(result.error).toContain('network down')
  })

  it('truncates oversized payloads', async () => {
    const big = 'x'.repeat(20_000)
    const client = fakeClient(async () => ({
      text: '',
      isError: false,
      structuredContent: { huge: big },
    }))
    const tool = bridgeMcpTool('s', client, {
      name: 'big',
      inputSchema: { type: 'object', properties: {} },
    })!
    const result: any = await tool.execute({})
    expect(result.truncated).toBe(true)
    expect(result.originalBytes).toBeGreaterThan(10_000)
  })
})
