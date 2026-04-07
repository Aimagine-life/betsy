import { describe, it, expect, vi } from 'vitest'
import { executeSkill } from '../../../src/multi/skills/executor.js'
import type { ExecuteSkillContext, SkillLLM, SkillLogger } from '../../../src/multi/skills/executor.js'
import type { MemoryTool } from '../../../src/multi/agents/tools/memory-tools.js'
import type { WorkspaceSkill } from '../../../src/multi/skills/types.js'
import { z } from 'zod'

const silentLogger: SkillLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

function makeLLM(text = 'reply'): SkillLLM {
  return { generateText: vi.fn(async () => text) as any }
}

function makeTool(name: string, impl: (params: any) => any = () => ({ ok: true })): MemoryTool {
  return {
    name,
    description: 't',
    parameters: z.any() as any,
    execute: vi.fn(async (params: any) => impl(params)) as any,
  }
}

function ctx(over: Partial<ExecuteSkillContext>): ExecuteSkillContext {
  return {
    workspaceId: 'ws-1',
    availableTools: [],
    llm: makeLLM(),
    logger: silentLogger,
    ...over,
  }
}

describe('executeSkill', () => {
  it('runs a tool step and stores result', async () => {
    const t = makeTool('echo', (p) => ({ got: p.x }))
    const skill: WorkspaceSkill = {
      name: 't',
      trigger: { type: 'manual' },
      steps: [{ kind: 'tool', tool: 'echo', params: { x: 'hi' }, saveAs: 'r' }],
    }
    const result = await executeSkill(skill, ctx({ availableTools: [t] }))
    expect(result.success).toBe(true)
    expect(result.stepsExecuted).toBe(1)
    expect((result.output as any).r).toEqual({ got: 'hi' })
  })

  it('renders templates in tool params', async () => {
    const t = makeTool('echo', (p) => p)
    const skill: WorkspaceSkill = {
      name: 't',
      trigger: { type: 'manual' },
      steps: [{ kind: 'tool', tool: 'echo', params: { msg: 'hello {{vars.name}}' }, saveAs: 'r' }],
    }
    const result = await executeSkill(
      skill,
      ctx({ availableTools: [t], vars: { name: 'Bob' } }),
    )
    expect((result.output as any).r).toEqual({ msg: 'hello Bob' })
  })

  it('runs a prompt step via llm', async () => {
    const llm = makeLLM('llm-out')
    const skill: WorkspaceSkill = {
      name: 't',
      trigger: { type: 'manual' },
      steps: [{ kind: 'prompt', prompt: 'q', saveAs: 'r' }],
    }
    const result = await executeSkill(skill, ctx({ llm }))
    expect((result.output as any).r).toBe('llm-out')
  })

  it('condition true branch', async () => {
    const t = makeTool('mark', () => 'yes')
    const skill: WorkspaceSkill = {
      name: 't',
      trigger: { type: 'manual' },
      steps: [
        {
          kind: 'condition',
          if: 'vars.x == 1',
          then: [{ kind: 'tool', tool: 'mark', params: {}, saveAs: 'r' }],
          else: [{ kind: 'tool', tool: 'mark', params: {}, saveAs: 'r2' }],
        },
      ],
    }
    const result = await executeSkill(skill, ctx({ availableTools: [t], vars: { x: 1 } }))
    expect((result.output as any).r).toBe('yes')
    expect((result.output as any).r2).toBeUndefined()
  })

  it('condition false branch', async () => {
    const t = makeTool('mark', () => 'no')
    const skill: WorkspaceSkill = {
      name: 't',
      trigger: { type: 'manual' },
      steps: [
        {
          kind: 'condition',
          if: 'vars.x == 1',
          then: [{ kind: 'tool', tool: 'mark', params: {}, saveAs: 'r' }],
          else: [{ kind: 'tool', tool: 'mark', params: {}, saveAs: 'r2' }],
        },
      ],
    }
    const result = await executeSkill(skill, ctx({ availableTools: [t], vars: { x: 0 } }))
    expect((result.output as any).r).toBeUndefined()
    expect((result.output as any).r2).toBe('no')
  })

  it('loop iterates over array', async () => {
    const seen: any[] = []
    const t = makeTool('eat', (p) => {
      seen.push(p.item)
      return null
    })
    const skill: WorkspaceSkill = {
      name: 't',
      trigger: { type: 'manual' },
      steps: [
        {
          kind: 'loop',
          over: 'items',
          as: 'item',
          do: [{ kind: 'tool', tool: 'eat', params: { item: '{{item}}' } }],
        },
      ],
    }
    await executeSkill(
      skill,
      ctx({ availableTools: [t], vars: { items: ['a', 'b', 'c'] } }),
    )
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('step limit fails on the 51st step', async () => {
    const t = makeTool('noop')
    const steps = Array.from({ length: 101 }, () => ({
      kind: 'tool' as const,
      tool: 'noop',
      params: {},
    }))
    const skill: WorkspaceSkill = {
      name: 't',
      trigger: { type: 'manual' },
      steps,
    }
    const result = await executeSkill(skill, ctx({ availableTools: [t] }))
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/step limit/)
    // limit is 50; the executor checks BEFORE incrementing, so 50 successful then throws on 51st
    expect(result.stepsExecuted).toBe(50)
  })

  it('llm call limit fails on the 6th prompt', async () => {
    const llm = makeLLM('x')
    const skill: WorkspaceSkill = {
      name: 't',
      trigger: { type: 'manual' },
      steps: Array.from({ length: 6 }, () => ({ kind: 'prompt' as const, prompt: 'q' })),
    }
    const result = await executeSkill(skill, ctx({ llm }))
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/LLM call limit/)
  })

  it('missing tool gives a clear error', async () => {
    const skill: WorkspaceSkill = {
      name: 't',
      trigger: { type: 'manual' },
      steps: [{ kind: 'tool', tool: 'nope', params: {} }],
    }
    const result = await executeSkill(skill, ctx({}))
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/tool not found: nope/)
  })

  it('loop.over not an array → error', async () => {
    const skill: WorkspaceSkill = {
      name: 't',
      trigger: { type: 'manual' },
      steps: [
        { kind: 'loop', over: 'x', as: 'i', do: [{ kind: 'prompt', prompt: 'q' }] },
      ],
    }
    const result = await executeSkill(skill, ctx({ vars: { x: 'not-array' } }))
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/did not resolve to an array/)
  })
})
