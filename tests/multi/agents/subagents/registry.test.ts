import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { SubAgentRegistry } from '../../../../src/multi/agents/subagents/registry.js'
import type { SubAgent } from '../../../../src/multi/agents/subagents/types.js'

function makeAgent(name: string): SubAgent {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: 'sp',
    tools: [
      {
        name: 'noop',
        description: 'noop',
        parameters: z.object({}),
        async execute() {
          return { ok: true }
        },
      },
    ],
  }
}

describe('SubAgentRegistry', () => {
  it('registers and retrieves an agent', () => {
    const r = new SubAgentRegistry()
    r.register(makeAgent('memory'))
    expect(r.has('memory')).toBe(true)
    expect(r.get('memory')?.name).toBe('memory')
    expect(r.size).toBe(1)
  })

  it('list() returns agents in insertion order', () => {
    const r = new SubAgentRegistry()
    r.register(makeAgent('a'))
    r.register(makeAgent('b'))
    r.register(makeAgent('c'))
    expect(r.list().map((a) => a.name)).toEqual(['a', 'b', 'c'])
  })

  it('throws on duplicate registration', () => {
    const r = new SubAgentRegistry()
    r.register(makeAgent('memory'))
    expect(() => r.register(makeAgent('memory'))).toThrow(/duplicate/)
  })

  it('returns undefined for unknown agent', () => {
    const r = new SubAgentRegistry()
    expect(r.get('nope')).toBeUndefined()
    expect(r.has('nope')).toBe(false)
  })
})
