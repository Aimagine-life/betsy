import { describe, it, expect, beforeAll } from 'vitest'
import { Pool } from 'pg'
import { CandidatesRepo } from '../../../src/multi/learner/candidates-repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const maybe = url ? describe : describe.skip

maybe('CandidatesRepo (RLS, integration)', () => {
  let pool: Pool
  let repo: CandidatesRepo
  const wsA = process.env.BC_TEST_WORKSPACE_A ?? '00000000-0000-0000-0000-00000000000a'
  const wsB = process.env.BC_TEST_WORKSPACE_B ?? '00000000-0000-0000-0000-00000000000b'

  const yaml = `name: cand_test
trigger:
  type: manual
steps:
  - kind: prompt
    prompt: hi
`

  beforeAll(() => {
    pool = new Pool({ connectionString: url })
    repo = new CandidatesRepo(pool)
  })

  it('inserts and lists per workspace', async () => {
    const c = await repo.insert(wsA, {
      name: 'cand_test',
      description: 'x',
      yaml,
      rationale: 'because',
      sourcePattern: { freq: 3 },
    })
    expect(c.name).toBe('cand_test')
    const pending = await repo.listPending(wsA)
    expect(pending.some((r) => r.id === c.id)).toBe(true)
  })

  it('RLS isolates workspace B from workspace A candidates', async () => {
    const fromB = await repo.getByName(wsB, 'cand_test')
    expect(fromB).toBeNull()
  })

  it('reject transitions pending -> rejected', async () => {
    const c = await repo.getByName(wsA, 'cand_test')
    if (!c) throw new Error('precondition: candidate missing')
    const r = await repo.reject(wsA, c.id, 'no thanks')
    expect(r?.status).toBe('rejected')
  })
})
