import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runBetsy, runBetsyStream } from '../../../src/multi/agents/runner.js'
import type { CriticResult } from '../../../src/multi/critic/types.js'

function mockDeps(overrides: any = {}) {
  const workspace = {
    id: 'ws1',
    displayName: 'K',
    addressForm: 'ty',
    plan: 'personal',
    behaviorConfig: {},
  }
  const persona = {
    id: 'p1',
    workspaceId: 'ws1',
    name: 'Betsy',
    gender: 'female',
    voiceId: 'Aoede',
    personalityPrompt: 'warm friend',
    behaviorConfig: { voice: 'text_only', selfie: 'on_request', video: 'on_request' },
  }
  return {
    persona,
    wsRepo: { findById: vi.fn().mockResolvedValue(workspace) },
    personaRepo: { findByWorkspace: vi.fn().mockResolvedValue(persona) },
    factsRepo: {
      list: vi.fn().mockResolvedValue([]),
      listByKind: vi.fn().mockResolvedValue([]),
      listMissingEmbeddings: vi.fn().mockResolvedValue([]),
      searchByEmbedding: vi.fn().mockResolvedValue([]),
    },
    convRepo: {
      recent: vi.fn().mockResolvedValue([]),
      append: vi.fn().mockResolvedValue({ id: 'row1' }),
      searchByEmbedding: vi.fn().mockResolvedValue([]),
    },
    remindersRepo: {},
    s3: {},
    gemini: {},
    agentRunner: vi.fn().mockResolvedValue({
      text: 'original draft reply',
      toolCalls: [],
      tokensUsed: 10,
    }),
    ...overrides,
  }
}

function fakeCritic(result: Partial<CriticResult> | Error) {
  const review = vi.fn(async () => {
    if (result instanceof Error) throw result
    return {
      ok: false,
      issues: [],
      durationMs: 1,
      ...result,
    } as CriticResult
  })
  return { review } as any
}

describe('runBetsy + Critic integration', () => {
  const ORIGINAL_FLAG = process.env.BC_CRITIC_ENABLED
  beforeEach(() => {
    delete process.env.BC_CRITIC_ENABLED
  })
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.BC_CRITIC_ENABLED
    else process.env.BC_CRITIC_ENABLED = ORIGINAL_FLAG
  })

  it('does not invoke critic when BC_CRITIC_ENABLED is unset', async () => {
    const critic = fakeCritic({ ok: true })
    const deps = mockDeps({ critic })
    const res = await runBetsy({
      workspaceId: 'ws1',
      userMessage: 'hi',
      channel: 'telegram',
      currentChatId: 'c1',
      deps: deps as any,
    })
    expect(critic.review).not.toHaveBeenCalled()
    expect(res.text).toBe('original draft reply')
  })

  it('invokes critic when flag is on, keeps original on ok=true', async () => {
    process.env.BC_CRITIC_ENABLED = '1'
    const critic = fakeCritic({ ok: true })
    const deps = mockDeps({ critic })
    const res = await runBetsy({
      workspaceId: 'ws1',
      userMessage: 'hi',
      channel: 'telegram',
      currentChatId: 'c1',
      deps: deps as any,
    })
    expect(critic.review).toHaveBeenCalledTimes(1)
    expect(res.text).toBe('original draft reply')
  })

  it('applies suggestion when ok=false + valid suggested', async () => {
    process.env.BC_CRITIC_ENABLED = '1'
    const critic = fakeCritic({
      ok: false,
      issues: [{ kind: 'tone', detail: 'cold' }],
      suggested: 'a much warmer rewritten reply for you',
    })
    const deps = mockDeps({ critic })
    const res = await runBetsy({
      workspaceId: 'ws1',
      userMessage: 'hi',
      channel: 'telegram',
      currentChatId: 'c1',
      deps: deps as any,
    })
    expect(res.text).toBe('a much warmer rewritten reply for you')
    // The persisted assistant row must carry the replaced text, not the original.
    const appendCalls = deps.convRepo.append.mock.calls
    const assistantCall = appendCalls.find((c: any[]) => c[1]?.role === 'assistant')
    expect(assistantCall?.[1]?.content).toBe('a much warmer rewritten reply for you')
  })

  it('falls back to original when ok=false but no suggestion', async () => {
    process.env.BC_CRITIC_ENABLED = '1'
    const critic = fakeCritic({
      ok: false,
      issues: [{ kind: 'leak', detail: 'mentioned tool' }],
    })
    const deps = mockDeps({ critic })
    const res = await runBetsy({
      workspaceId: 'ws1',
      userMessage: 'hi',
      channel: 'telegram',
      currentChatId: 'c1',
      deps: deps as any,
    })
    expect(res.text).toBe('original draft reply')
  })

  it('falls back to original when critic throws', async () => {
    process.env.BC_CRITIC_ENABLED = '1'
    const critic = fakeCritic(new Error('critic boom'))
    const deps = mockDeps({ critic })
    const res = await runBetsy({
      workspaceId: 'ws1',
      userMessage: 'hi',
      channel: 'telegram',
      currentChatId: 'c1',
      deps: deps as any,
    })
    expect(res.text).toBe('original draft reply')
  })

  it('does not apply when suggested is identical to original', async () => {
    process.env.BC_CRITIC_ENABLED = '1'
    const critic = fakeCritic({
      ok: false,
      issues: [{ kind: 'tone', detail: 'x' }],
      suggested: 'original draft reply',
    })
    const deps = mockDeps({ critic })
    const res = await runBetsy({
      workspaceId: 'ws1',
      userMessage: 'hi',
      channel: 'telegram',
      currentChatId: 'c1',
      deps: deps as any,
    })
    expect(res.text).toBe('original draft reply')
  })

  it('runBetsyStream does NOT call critic even with flag on', async () => {
    process.env.BC_CRITIC_ENABLED = '1'
    const critic = fakeCritic({ ok: false, suggested: 'rewritten' })

    // Stream path uses runWithGeminiToolsStream — mock gemini minimally so
    // the path reaches the skip-critic log without exploding. We only care
    // that critic.review is never called; stream failure downstream is fine.
    const deps = mockDeps({
      critic,
      gemini: {
        models: {
          generateContentStream: vi.fn(async () => {
            throw new Error('stream not needed for this assertion')
          }),
          generateContent: vi.fn(async () => ({ text: '' })),
        },
      },
    })

    let stream: any
    try {
      stream = await runBetsyStream({
        workspaceId: 'ws1',
        userMessage: 'hi',
        channel: 'telegram',
        currentChatId: 'c1',
        deps: deps as any,
      })
    } catch {
      // stream wiring may throw; irrelevant — we assert on the critic below.
    }
    // Drain the exposed promises so we don't leak an unhandled rejection.
    if (stream) {
      await Promise.allSettled([stream.done, stream.replyToPromise, stream.assistantRowIdPromise])
      // Also drain the stream iterable
      try {
        for await (const _ of stream.textStream) {
          // noop
        }
      } catch {
        // expected
      }
    }
    expect(critic.review).not.toHaveBeenCalled()
  })
})
