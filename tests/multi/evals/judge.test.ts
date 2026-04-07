import { describe, it, expect } from 'vitest'
import { makeJudge } from '../../../src/multi/evals/judge.js'

function fakeClient(payload: { satisfied: string[]; violated: string[] }) {
  return {
    models: {
      generateContent: async () => ({
        candidates: [
          { content: { parts: [{ text: JSON.stringify(payload) }] } },
        ],
      }),
    },
  }
}

describe('makeJudge', () => {
  it('returns full score when all properties are satisfied', async () => {
    const j = makeJudge(fakeClient({ satisfied: ['a', 'b'], violated: [] }))
    const r = await j('hi', ['a', 'b'])
    expect(r.score).toBe(1)
    expect(r.perProperty).toEqual({ a: true, b: true })
  })

  it('marks violated properties false', async () => {
    const j = makeJudge(fakeClient({ satisfied: ['a'], violated: ['b'] }))
    const r = await j('hi', ['a', 'b'])
    expect(r.score).toBe(0.5)
    expect(r.perProperty).toEqual({ a: true, b: false })
  })

  it('returns score 1 when properties list is empty', async () => {
    const j = makeJudge(fakeClient({ satisfied: [], violated: [] }))
    const r = await j('hi', [])
    expect(r.score).toBe(1)
  })

  it('throws on invalid JSON output', async () => {
    const client = {
      models: {
        generateContent: async () => ({
          candidates: [{ content: { parts: [{ text: 'not json' }] } }],
        }),
      },
    }
    const j = makeJudge(client)
    await expect(j('hi', ['a'])).rejects.toThrow(/invalid JSON/)
  })
})
