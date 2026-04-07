import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  createMemoryAgent,
  createResearchAgent,
  createPlannerAgent,
  createCreativeAgent,
  buildDefaultRegistry,
} from '../../../../src/multi/agents/subagents/index.js'
import type { MemoryTool } from '../../../../src/multi/agents/tools/memory-tools.js'

function tool(name: string): MemoryTool {
  return {
    name,
    description: `${name} desc`,
    parameters: z.object({}),
    async execute() {
      return { ok: true }
    },
  }
}

describe('sub-agent factories', () => {
  it('memory agent filters to memory tool names', () => {
    const tools = [
      tool('remember'),
      tool('forget_fact'),
      tool('forget_all'),
      tool('forget_recent_messages'),
      tool('google_search'), // should be filtered out
    ]
    const agent = createMemoryAgent({ memory: tools })
    expect(agent.name).toBe('memory')
    expect(agent.tools.map((t) => t.name).sort()).toEqual([
      'forget_all',
      'forget_fact',
      'forget_recent_messages',
      'remember',
    ])
  })

  it('research agent gets exactly the search + fetch_url tools', () => {
    const search = tool('google_search')
    const fetchUrl = tool('fetch_url')
    const agent = createResearchAgent({ search, fetchUrl })
    expect(agent.name).toBe('research')
    expect(agent.tools.map((t) => t.name)).toEqual(['google_search', 'fetch_url'])
  })

  it('planner agent filters to reminder tool names', () => {
    const tools = [
      tool('set_reminder'),
      tool('list_reminders'),
      tool('cancel_reminder'),
      tool('remember'), // unrelated
    ]
    const agent = createPlannerAgent({ reminders: tools })
    expect(agent.tools.map((t) => t.name).sort()).toEqual([
      'cancel_reminder',
      'list_reminders',
      'set_reminder',
    ])
  })

  it('creative agent wraps the selfie tool', () => {
    const selfie = tool('generate_selfie')
    const agent = createCreativeAgent({ selfie })
    expect(agent.tools).toEqual([selfie])
  })
})

describe('buildDefaultRegistry', () => {
  it('builds all four sub-agents when every tool is present', () => {
    const allTools = [
      tool('remember'),
      tool('forget_fact'),
      tool('forget_recent_messages'),
      tool('forget_all'),
      tool('google_search'),
      tool('fetch_url'),
      tool('set_reminder'),
      tool('list_reminders'),
      tool('cancel_reminder'),
      tool('generate_selfie'),
    ]
    const reg = buildDefaultRegistry(allTools)
    expect(reg.list().map((a) => a.name).sort()).toEqual([
      'creative',
      'memory',
      'planner',
      'research',
    ])
  })

  it('skips sub-agents whose tools are missing and warns', () => {
    // Only memory tools — research/planner/creative should be skipped silently.
    const allTools = [tool('remember'), tool('forget_fact')]
    const reg = buildDefaultRegistry(allTools)
    expect(reg.list().map((a) => a.name)).toEqual(['memory'])
  })

  it('skips research when fetch_url is missing even if search is present', () => {
    const allTools = [tool('google_search')]
    const reg = buildDefaultRegistry(allTools)
    expect(reg.has('research')).toBe(false)
  })

  it('returns an empty registry for an empty tool pool', () => {
    const reg = buildDefaultRegistry([])
    expect(reg.size).toBe(0)
  })
})
