import { describe, it, expect, beforeAll } from 'vitest'
import { Pool } from 'pg'
import { SkillsRepo } from '../../../src/multi/skills/repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const maybe = url ? describe : describe.skip

maybe('SkillsRepo (RLS, integration)', () => {
  let pool: Pool
  let repo: SkillsRepo
  // two known workspace ids would need to be created upstream by the harness
  const wsA = process.env.BC_TEST_WORKSPACE_A ?? '00000000-0000-0000-0000-00000000000a'
  const wsB = process.env.BC_TEST_WORKSPACE_B ?? '00000000-0000-0000-0000-00000000000b'

  beforeAll(() => {
    pool = new Pool({ connectionString: url })
    repo = new SkillsRepo(pool)
  })

  it('upserts and reads back per workspace', async () => {
    const row = await repo.upsert(wsA, {
      name: 'rls_test',
      yaml: 'name: rls_test\ntrigger:\n  type: manual\nsteps:\n  - kind: prompt\n    prompt: hi\n',
      triggerType: 'manual',
    })
    expect(row.name).toBe('rls_test')
    const fetched = await repo.getByName(wsA, 'rls_test')
    expect(fetched?.id).toBe(row.id)
  })

  it('workspace B cannot see workspace A skills (RLS)', async () => {
    const fromB = await repo.getByName(wsB, 'rls_test')
    expect(fromB).toBeNull()
  })
})
