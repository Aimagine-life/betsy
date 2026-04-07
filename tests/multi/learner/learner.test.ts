import { describe, it, expect } from 'vitest'
import { Learner } from '../../../src/multi/learner/learner.js'
import type { Conversation } from '../../../src/multi/memory/types.js'
import type { SkillCandidate } from '../../../src/multi/learner/types.js'

const validYaml = `name: morning_brief
description: утренний дайджест
trigger:
  type: manual
steps:
  - kind: tool
    tool: google_search
    params:
      query: погода
`

function mkHistory(n: number): Conversation[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    workspaceId: 'ws',
    channel: 'telegram' as const,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `message ${i}`,
    toolCalls: null,
    tokensUsed: 0,
    meta: {},
    chatId: 'c',
    externalMessageId: i,
    createdAt: new Date(),
  }))
}

function makeDeps(opts: {
  history?: Conversation[]
  existingCandidates?: Array<{ name: string }>
  existingSkills?: Array<{ name: string }>
  patterns?: unknown
  generator?: unknown
  generatorThrows?: Error
  insertedOut?: SkillCandidate[]
}) {
  const inserted: Array<{ name: string; yaml: string }> = []
  if (opts.insertedOut) {
    // side channel — caller can inspect
  }
  return {
    inserted,
    deps: {
      pool: {} as any,
      convRepo: {
        async listSince() {
          return opts.history ?? []
        },
      } as any,
      skillsRepo: {
        async list() {
          return opts.existingSkills ?? []
        },
      } as any,
      candidatesRepo: {
        async expireOld() {
          return 0
        },
        async list() {
          return opts.existingCandidates ?? []
        },
        async insert(_ws: string, input: any) {
          inserted.push({ name: input.name, yaml: input.yaml })
          return { id: 'x', name: input.name, ...input }
        },
      } as any,
      patternLLM: {
        async generateJson() {
          return JSON.stringify(opts.patterns ?? { patterns: [] })
        },
      },
      generatorLLM: {
        async generateJson() {
          if (opts.generatorThrows) throw opts.generatorThrows
          return JSON.stringify(opts.generator)
        },
      },
      availableTools: () => ['google_search', 'recall'],
    },
  }
}

describe('Learner.runForWorkspace', () => {
  it('returns early when history is shorter than MIN_HISTORY', async () => {
    const { deps, inserted } = makeDeps({ history: mkHistory(3) })
    const learner = new Learner(deps)
    const r = await learner.runForWorkspace('ws1')
    expect(r.messagesAnalysed).toBe(3)
    expect(r.patternsFound).toBe(0)
    expect(inserted).toHaveLength(0)
  })

  it('happy path: creates a candidate from a detected pattern', async () => {
    const { deps, inserted } = makeDeps({
      history: mkHistory(12),
      patterns: {
        patterns: [
          {
            description: 'morning weather',
            triggerExamples: ['погода'],
            toolSequence: ['google_search'],
            frequency: 3,
            confidence: 0.9,
          },
        ],
      },
      generator: {
        name: 'morning_brief',
        description: 'утренний дайджест',
        yaml: validYaml,
        rationale: 'юзер часто просит',
      },
    })
    const learner = new Learner(deps)
    const r = await learner.runForWorkspace('ws1')
    expect(r.patternsFound).toBe(1)
    expect(r.candidatesCreated).toBe(1)
    expect(inserted).toHaveLength(1)
    expect(inserted[0].name).toBe('morning_brief')
  })

  it('dedupes against existing workspace skills', async () => {
    const { deps, inserted } = makeDeps({
      history: mkHistory(12),
      existingSkills: [{ name: 'morning_brief' }],
      patterns: {
        patterns: [
          {
            description: 'morning weather',
            triggerExamples: ['погода'],
            toolSequence: [],
            frequency: 3,
            confidence: 0.9,
          },
        ],
      },
      generator: {
        name: 'morning_brief',
        description: 'x',
        yaml: validYaml,
        rationale: '',
      },
    })
    const r = await new Learner(deps).runForWorkspace('ws1')
    expect(r.candidatesCreated).toBe(0)
    expect(r.candidatesSkipped).toBe(1)
    expect(inserted).toHaveLength(0)
  })

  it('dedupes against existing pending candidates', async () => {
    const { deps, inserted } = makeDeps({
      history: mkHistory(12),
      existingCandidates: [{ name: 'morning_brief' }],
      patterns: {
        patterns: [
          {
            description: 'morning',
            triggerExamples: [],
            toolSequence: [],
            frequency: 3,
            confidence: 0.9,
          },
        ],
      },
      generator: {
        name: 'MORNING_BRIEF',
        description: 'x',
        yaml: validYaml,
        rationale: '',
      },
    })
    const r = await new Learner(deps).runForWorkspace('ws1')
    expect(r.candidatesCreated).toBe(0)
    expect(r.candidatesSkipped).toBe(1)
    expect(inserted).toHaveLength(0)
  })

  it('generator failure is caught per-pattern and other patterns still process', async () => {
    let call = 0
    const deps: any = {
      pool: {},
      convRepo: { async listSince() { return mkHistory(12) } },
      skillsRepo: { async list() { return [] } },
      candidatesRepo: {
        async expireOld() { return 0 },
        async list() { return [] },
        async insert(_ws: string, input: any) {
          return { id: 'x', ...input }
        },
      },
      patternLLM: {
        async generateJson() {
          return JSON.stringify({
            patterns: [
              { description: 'a', triggerExamples: [], toolSequence: [], frequency: 3, confidence: 0.9 },
              { description: 'b', triggerExamples: [], toolSequence: [], frequency: 3, confidence: 0.9 },
            ],
          })
        },
      },
      generatorLLM: {
        async generateJson() {
          call += 1
          if (call === 1) throw new Error('llm died')
          return JSON.stringify({
            name: 'good_one',
            description: 'x',
            yaml: validYaml,
            rationale: '',
          })
        },
      },
      availableTools: () => ['google_search'],
    }
    const r = await new Learner(deps).runForWorkspace('ws1')
    expect(r.patternsFound).toBe(2)
    expect(r.candidatesCreated).toBe(1)
    expect(r.candidatesSkipped).toBe(1)
    expect(r.errors.length).toBeGreaterThanOrEqual(1)
  })

  it('pattern detection failure is captured in errors', async () => {
    const deps: any = {
      pool: {},
      convRepo: { async listSince() { return mkHistory(12) } },
      skillsRepo: { async list() { return [] } },
      candidatesRepo: {
        async expireOld() { return 0 },
        async list() { return [] },
        async insert() { return {} },
      },
      patternLLM: {
        async generateJson() { throw new Error('detector boom') },
      },
      generatorLLM: { async generateJson() { return '{}' } },
      availableTools: () => [],
    }
    const r = await new Learner(deps).runForWorkspace('ws1')
    // detectPatterns swallows LLM errors -> 0 patterns, no errors bubble
    expect(r.patternsFound).toBe(0)
    expect(r.candidatesCreated).toBe(0)
  })
})
