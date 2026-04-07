import { describe, it, expect } from 'vitest'
import { createLearnerTools } from '../../../src/multi/learner/learner-tools.js'

function makeRepo(overrides: any = {}): any {
  return {
    async listPending() {
      return [
        {
          id: 'c1',
          workspaceId: 'ws',
          name: 'morning_brief',
          description: 'утро',
          yaml: 'x',
          rationale: 'юзер часто',
          sourcePattern: null,
          status: 'pending',
          createdAt: new Date('2026-01-01'),
          decidedAt: null,
          expiresAt: new Date('2026-02-01'),
        },
      ]
    },
    async approve(_ws: string, id: string) {
      return { id, name: 'morning_brief', status: 'approved' }
    },
    async reject(_ws: string, id: string) {
      return { id, name: 'morning_brief', status: 'rejected' }
    },
    ...overrides,
  }
}

describe('createLearnerTools', () => {
  it('list_skill_candidates returns pending candidates in user-friendly shape', async () => {
    const tools = createLearnerTools({
      workspaceId: 'ws',
      candidatesRepo: makeRepo(),
    })
    const list = tools.find((t) => t.name === 'list_skill_candidates')!
    const out = (await list.execute({})) as any[]
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      id: 'c1',
      name: 'morning_brief',
      rationale: 'юзер часто',
    })
    // YAML is intentionally NOT exposed in list (user sees it on detail)
    expect(out[0].yaml).toBeUndefined()
  })

  it('approve_skill_candidate returns ok on success', async () => {
    const tools = createLearnerTools({
      workspaceId: 'ws',
      candidatesRepo: makeRepo(),
    })
    const approve = tools.find((t) => t.name === 'approve_skill_candidate')!
    const out = (await approve.execute({ id: 'c1' })) as any
    expect(out).toMatchObject({ ok: true, name: 'morning_brief' })
  })

  it('approve_skill_candidate returns {ok:false} on repo error', async () => {
    const tools = createLearnerTools({
      workspaceId: 'ws',
      candidatesRepo: makeRepo({
        async approve() {
          throw new Error('not pending')
        },
      }),
    })
    const approve = tools.find((t) => t.name === 'approve_skill_candidate')!
    const out = (await approve.execute({ id: 'c1' })) as any
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/not pending/)
  })

  it('reject_skill_candidate returns error for missing candidate', async () => {
    const tools = createLearnerTools({
      workspaceId: 'ws',
      candidatesRepo: makeRepo({
        async reject() {
          return null
        },
      }),
    })
    const reject = tools.find((t) => t.name === 'reject_skill_candidate')!
    const out = (await reject.execute({ id: 'x' })) as any
    expect(out.ok).toBe(false)
  })
})
