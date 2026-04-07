import { describe, it, expect } from 'vitest'
import {
  detectHeuristicPatterns,
  detectPatterns,
  type PatternDetectorLLM,
} from '../../../src/multi/learner/pattern-detector.js'
import type { Conversation } from '../../../src/multi/memory/types.js'

function mkMsg(
  i: number,
  role: 'user' | 'assistant',
  content: string,
  toolCalls: unknown = null,
  daysAgo = 0,
): Conversation {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - daysAgo)
  d.setUTCHours(10, i, 0, 0)
  return {
    id: `m${i}-${daysAgo}`,
    workspaceId: 'ws',
    channel: 'telegram',
    role,
    content,
    toolCalls,
    tokensUsed: 0,
    meta: {},
    chatId: 'c',
    externalMessageId: i,
    createdAt: d,
  }
}

function fakeLLM(payload: unknown): PatternDetectorLLM {
  return {
    async generateJson() {
      return JSON.stringify(payload)
    },
  }
}

describe('detectHeuristicPatterns', () => {
  it('finds tool sequences that repeat across multiple days', () => {
    const history: Conversation[] = [
      mkMsg(1, 'user', 'погода'),
      mkMsg(2, 'assistant', 'ок', [{ name: 'recall' }, { name: 'google_search' }], 2),
      mkMsg(3, 'user', 'погода'),
      mkMsg(4, 'assistant', 'ок', [{ name: 'recall' }, { name: 'google_search' }], 1),
      mkMsg(5, 'user', 'погода'),
      mkMsg(6, 'assistant', 'ок', [{ name: 'recall' }, { name: 'google_search' }], 0),
    ]
    const hints = detectHeuristicPatterns(history)
    expect(hints.length).toBeGreaterThan(0)
    const seqs = hints.map((h) => h.sequence.join('>'))
    expect(seqs).toContain('recall>google_search')
  })

  it('returns empty when nothing repeats across days', () => {
    const history: Conversation[] = [
      mkMsg(1, 'assistant', 'ok', [{ name: 'recall' }], 0),
    ]
    expect(detectHeuristicPatterns(history)).toHaveLength(0)
  })
})

describe('detectPatterns', () => {
  const baseHistory: Conversation[] = Array.from({ length: 12 }, (_, i) =>
    mkMsg(i, i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`, null, i % 3),
  )

  it('returns empty for short history without calling LLM', async () => {
    const short = baseHistory.slice(0, 5)
    let called = false
    const llm: PatternDetectorLLM = {
      async generateJson() {
        called = true
        return '{"patterns":[]}'
      },
    }
    const out = await detectPatterns(short, llm)
    expect(out).toEqual([])
    expect(called).toBe(false)
  })

  it('filters by confidence and frequency thresholds', async () => {
    const llm = fakeLLM({
      patterns: [
        {
          description: 'high quality',
          triggerExamples: ['a'],
          toolSequence: ['recall'],
          frequency: 3,
          confidence: 0.9,
        },
        {
          description: 'too low confidence',
          triggerExamples: ['b'],
          toolSequence: ['recall'],
          frequency: 5,
          confidence: 0.4,
        },
        {
          description: 'too rare',
          triggerExamples: ['c'],
          toolSequence: ['recall'],
          frequency: 1,
          confidence: 0.95,
        },
      ],
    })
    const out = await detectPatterns(baseHistory, llm)
    expect(out).toHaveLength(1)
    expect(out[0].description).toBe('high quality')
  })

  it('dedupes patterns by description (case-insensitive)', async () => {
    const llm = fakeLLM({
      patterns: [
        {
          description: 'Morning brief',
          triggerExamples: [],
          toolSequence: [],
          frequency: 3,
          confidence: 0.8,
        },
        {
          description: 'morning brief',
          triggerExamples: [],
          toolSequence: [],
          frequency: 4,
          confidence: 0.9,
        },
      ],
    })
    const out = await detectPatterns(baseHistory, llm)
    expect(out).toHaveLength(1)
  })

  it('degrades gracefully on llm throw', async () => {
    const llm: PatternDetectorLLM = {
      async generateJson() {
        throw new Error('boom')
      },
    }
    const out = await detectPatterns(baseHistory, llm)
    expect(out).toEqual([])
  })

  it('degrades gracefully on malformed json', async () => {
    const llm: PatternDetectorLLM = {
      async generateJson() {
        return 'not json at all'
      },
    }
    const out = await detectPatterns(baseHistory, llm)
    expect(out).toEqual([])
  })
})
