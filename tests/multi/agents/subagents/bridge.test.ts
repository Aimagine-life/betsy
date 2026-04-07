import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  createDelegationTool,
  createAllDelegationTools,
  MAX_DELEGATION_DEPTH,
  type DelegationRunner,
} from '../../../../src/multi/agents/subagents/bridge.js'
import { SubAgentRegistry } from '../../../../src/multi/agents/subagents/registry.js'
import type { SubAgent } from '../../../../src/multi/agents/subagents/types.js'
import type { MemoryTool } from '../../../../src/multi/agents/tools/memory-tools.js'

const fakeGemini = {} as any

function tool(name: string): MemoryTool {
  return {
    name,
    description: `${name} tool`,
    parameters: z.object({}),
    async execute() {
      return { ok: true }
    },
  }
}

function agent(name: string, overrides: Partial<SubAgent> = {}): SubAgent {
  return {
    name,
    description: `${name} description`,
    systemPrompt: `system prompt for ${name}`,
    tools: [tool(`${name}_tool`)],
    ...overrides,
  }
}

function okRunner(text = 'inner result'): DelegationRunner {
  return vi.fn(async () => ({ text, toolCalls: [], tokensUsed: 0 }))
}

describe('createDelegationTool', () => {
  it('builds a tool named delegate_to_<agent>', () => {
    const t = createDelegationTool(agent('memory'), { gemini: fakeGemini }, okRunner())
    expect(t.name).toBe('delegate_to_memory')
    expect(t.description).toContain('memory')
  })

  it('passes systemPrompt and sub-agent tools through to the inner runner', async () => {
    const runner = okRunner('hello')
    const sub = agent('research')
    const t = createDelegationTool(sub, { gemini: fakeGemini }, runner)

    await t.execute({ task: 'find x' })

    expect(runner).toHaveBeenCalledTimes(1)
    const [g, innerAgent, msg, history] = (runner as any).mock.calls[0]
    expect(g).toBe(fakeGemini)
    expect(innerAgent.instruction).toBe(sub.systemPrompt)
    expect(innerAgent.tools).toBe(sub.tools)
    expect(innerAgent.model).toBe('gemini-2.5-flash')
    expect(msg).toBe('find x')
    expect(history).toEqual([])
  })

  it('uses agent.model override when provided', async () => {
    const runner = okRunner()
    const sub = agent('planner', { model: 'gemini-2.5-pro' })
    const t = createDelegationTool(sub, { gemini: fakeGemini }, runner)
    await t.execute({ task: 't' })
    expect((runner as any).mock.calls[0][1].model).toBe('gemini-2.5-pro')
  })

  it('returns ok with output text on success', async () => {
    const runner = okRunner('the answer')
    const t = createDelegationTool(agent('memory'), { gemini: fakeGemini }, runner)
    const res: any = await t.execute({ task: 'question' })
    expect(res).toMatchObject({
      ok: true,
      agent: 'memory',
      output: 'the answer',
      toolCalls: 0,
      depth: 1,
    })
  })

  it('propagates context parameter into the user message', async () => {
    const runner = okRunner()
    const t = createDelegationTool(agent('memory'), { gemini: fakeGemini }, runner)
    await t.execute({ task: 'do X', context: 'background info' })
    const msg = (runner as any).mock.calls[0][2]
    expect(msg).toContain('do X')
    expect(msg).toContain('background info')
  })

  it('refuses delegation when parentDepth >= MAX_DELEGATION_DEPTH', async () => {
    const runner = okRunner()
    const t = createDelegationTool(
      agent('memory'),
      { gemini: fakeGemini, parentDepth: MAX_DELEGATION_DEPTH },
      runner,
    )
    const res: any = await t.execute({ task: 'deep' })
    expect(res).toEqual({
      error: 'delegation depth exceeded',
      maxDepth: MAX_DELEGATION_DEPTH,
    })
    expect(runner).not.toHaveBeenCalled()
  })

  it('allows delegation when parentDepth = 0 and increments depth', async () => {
    const runner = okRunner()
    const t = createDelegationTool(
      agent('memory'),
      { gemini: fakeGemini, parentDepth: 0 },
      runner,
    )
    const res: any = await t.execute({ task: 't' })
    expect(res.ok).toBe(true)
    expect(res.depth).toBe(1)
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('returns { error } when the inner runner throws, never throws itself', async () => {
    const boom: DelegationRunner = vi.fn(async () => {
      throw new Error('boom')
    })
    const t = createDelegationTool(agent('memory'), { gemini: fakeGemini }, boom)
    const res: any = await t.execute({ task: 't' })
    expect(res).toEqual({ error: 'boom' })
  })
})

describe('createAllDelegationTools', () => {
  it('returns [] for an empty registry', () => {
    const reg = new SubAgentRegistry()
    expect(createAllDelegationTools(reg, { gemini: fakeGemini }, okRunner())).toEqual([])
  })

  it('returns one delegate_to_* tool per registered sub-agent', () => {
    const reg = new SubAgentRegistry()
    reg.register(agent('memory'))
    reg.register(agent('research'))
    reg.register(agent('planner'))
    reg.register(agent('creative'))
    const tools = createAllDelegationTools(reg, { gemini: fakeGemini }, okRunner())
    expect(tools.map((t) => t.name)).toEqual([
      'delegate_to_memory',
      'delegate_to_research',
      'delegate_to_planner',
      'delegate_to_creative',
    ])
  })
})
