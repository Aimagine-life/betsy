import { describe, it, expect, vi } from 'vitest'
import { Critic, shouldApplySuggestion } from '../../../src/multi/critic/critic.js'
import type { CriticInput } from '../../../src/multi/critic/types.js'

function baseInput(overrides: Partial<CriticInput> = {}): CriticInput {
  return {
    draftResponse: 'Привет, солнышко! Как ты сегодня? 🙈',
    userMessage: 'Привет',
    personaPrompt: 'Ты Betsy, тёплая подруга, обращение на ты.',
    ownerFacts: ['зовут Костя', 'любит чай'],
    channel: 'telegram',
    ...overrides,
  }
}

function mockGemini(script: { text?: string; error?: Error; delayMs?: number }) {
  return {
    models: {
      generateContent: vi.fn(async (_req: any) => {
        if (script.delayMs) {
          await new Promise((r) => setTimeout(r, script.delayMs))
        }
        if (script.error) throw script.error
        return { text: script.text ?? '' }
      }),
    },
  } as any
}

describe('Critic.review', () => {
  it('returns ok when Gemini says ok', async () => {
    const gemini = mockGemini({ text: JSON.stringify({ ok: true, issues: [] }) })
    const critic = new Critic({ gemini })
    const res = await critic.review(baseInput())
    expect(res.ok).toBe(true)
    expect(res.issues).toEqual([])
    expect(res.suggested).toBeUndefined()
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('returns issues + suggested when Gemini flags the draft', async () => {
    const gemini = mockGemini({
      text: JSON.stringify({
        ok: false,
        issues: [
          { kind: 'tone', detail: 'Слишком формально' },
          { kind: 'leak', detail: 'Упомянут function_call' },
        ],
        suggested: 'Переписанный тёплый ответ',
      }),
    })
    const critic = new Critic({ gemini })
    const res = await critic.review(baseInput())
    expect(res.ok).toBe(false)
    expect(res.issues).toHaveLength(2)
    expect(res.issues[0]!.kind).toBe('tone')
    expect(res.suggested).toBe('Переписанный тёплый ответ')
  })

  it('fail-opens when Gemini throws', async () => {
    const gemini = mockGemini({ error: new Error('boom') })
    const critic = new Critic({ gemini })
    const res = await critic.review(baseInput())
    expect(res.ok).toBe(true)
    expect(res.issues).toEqual([])
  })

  it('fail-opens on timeout (AbortController)', async () => {
    const gemini: any = {
      models: {
        generateContent: vi.fn((req: any) => {
          return new Promise((_, reject) => {
            const sig = req?.config?.abortSignal as AbortSignal | undefined
            sig?.addEventListener('abort', () => reject(new Error('aborted')))
          })
        }),
      },
    }
    const critic = new Critic({ gemini, timeoutMs: 20 })
    const res = await critic.review(baseInput())
    expect(res.ok).toBe(true)
  })

  it('fail-opens on invalid JSON', async () => {
    const gemini = mockGemini({ text: 'not json at all <<<' })
    const critic = new Critic({ gemini })
    const res = await critic.review(baseInput())
    expect(res.ok).toBe(true)
    expect(res.issues).toEqual([])
  })

  it('fail-opens on shape mismatch (no ok field)', async () => {
    const gemini = mockGemini({ text: JSON.stringify({ foo: 'bar' }) })
    const critic = new Critic({ gemini })
    const res = await critic.review(baseInput())
    expect(res.ok).toBe(true)
  })

  it('drops issues with unknown kind', async () => {
    const gemini = mockGemini({
      text: JSON.stringify({
        ok: false,
        issues: [
          { kind: 'made_up_kind', detail: 'x' },
          { kind: 'length', detail: 'too long' },
        ],
      }),
    })
    const critic = new Critic({ gemini })
    const res = await critic.review(baseInput())
    expect(res.ok).toBe(false)
    expect(res.issues).toHaveLength(1)
    expect(res.issues[0]!.kind).toBe('length')
  })

  it('handles very short drafts without crashing', async () => {
    const gemini = mockGemini({ text: JSON.stringify({ ok: true, issues: [] }) })
    const critic = new Critic({ gemini })
    const res = await critic.review(baseInput({ draftResponse: 'ок' }))
    expect(res.ok).toBe(true)
  })

  it('handles empty ownerFacts', async () => {
    const gemini = mockGemini({ text: JSON.stringify({ ok: true, issues: [] }) })
    const critic = new Critic({ gemini })
    const res = await critic.review(baseInput({ ownerFacts: [] }))
    expect(res.ok).toBe(true)
  })

  it('handles markdown/emoji in drafts', async () => {
    const gemini = mockGemini({ text: JSON.stringify({ ok: true, issues: [] }) })
    const critic = new Critic({ gemini })
    const res = await critic.review(
      baseInput({ draftResponse: '**Привет** 🌸 _как дела_? 🙈\n- один\n- два' }),
    )
    expect(res.ok).toBe(true)
  })
})

describe('shouldApplySuggestion', () => {
  const base = { durationMs: 0, issues: [] as any }

  it('does not apply when ok=true', () => {
    expect(
      shouldApplySuggestion('orig', { ...base, ok: true }).apply,
    ).toBe(false)
  })

  it('does not apply when no suggestion', () => {
    expect(
      shouldApplySuggestion('orig text here', { ...base, ok: false }).apply,
    ).toBe(false)
  })

  it('does not apply when suggestion is identical', () => {
    expect(
      shouldApplySuggestion('identical text', {
        ...base,
        ok: false,
        suggested: 'identical text',
      }).apply,
    ).toBe(false)
  })

  it('does not apply when suggestion too short', () => {
    expect(
      shouldApplySuggestion('orig', { ...base, ok: false, suggested: 'ok' }).apply,
    ).toBe(false)
  })

  it('does not apply when suggestion too long', () => {
    const long = 'x'.repeat(6000)
    expect(
      shouldApplySuggestion('orig', { ...base, ok: false, suggested: long }).apply,
    ).toBe(false)
  })

  it('applies a valid distinct suggestion', () => {
    const res = shouldApplySuggestion('original draft text', {
      ...base,
      ok: false,
      suggested: 'a much better version of the reply',
    })
    expect(res.apply).toBe(true)
  })
})
