import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'
import { PersonaRepo } from '../../../src/multi/personas/repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('PersonaRepo', () => {
  let pool: Pool
  let wsRepo: WorkspaceRepo
  let repo: PersonaRepo
  let workspaceId: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    wsRepo = new WorkspaceRepo(pool)
    repo = new PersonaRepo(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('truncate workspaces cascade')
    const ws = await wsRepo.upsertForTelegram(1)
    workspaceId = ws.id
  })

  it('create persona for workspace', async () => {
    const p = await repo.create(workspaceId, {
      presetId: 'betsy',
      name: 'Betsy',
      gender: 'female',
      voiceId: 'Aoede',
      personalityPrompt: 'You are Betsy, caring and knowledgeable.',
    })
    expect(p.name).toBe('Betsy')
    expect(p.voiceId).toBe('Aoede')
    expect(p.behaviorConfig.voice).toBe('auto')
  })

  it('findByWorkspace returns created persona', async () => {
    await repo.create(workspaceId, { presetId: 'betsy', name: 'Betsy' })
    const found = await repo.findByWorkspace(workspaceId)
    expect(found).not.toBeNull()
    expect(found!.name).toBe('Betsy')
  })

  it('update behavior config', async () => {
    const p = await repo.create(workspaceId, { presetId: 'betsy', name: 'Betsy' })
    await repo.updateBehavior(workspaceId, p.id, {
      voice: 'voice_always',
      selfie: 'auto',
      video: 'on_request',
    })
    const updated = await repo.findById(workspaceId, p.id)
    expect(updated!.behaviorConfig.voice).toBe('voice_always')
    expect(updated!.behaviorConfig.selfie).toBe('auto')
  })

  it('update avatar keys', async () => {
    const p = await repo.create(workspaceId, { presetId: 'betsy', name: 'Betsy' })
    await repo.updateAvatarKeys(workspaceId, p.id, {
      avatarS3Key: 'ws/x/avatar.png',
      referenceFrontS3Key: 'ws/x/front.png',
      referenceThreeQS3Key: 'ws/x/threeq.png',
      referenceProfileS3Key: 'ws/x/profile.png',
    })
    const updated = await repo.findById(workspaceId, p.id)
    expect(updated!.avatarS3Key).toBe('ws/x/avatar.png')
    expect(updated!.referenceFrontS3Key).toBe('ws/x/front.png')
  })

  it('RLS prevents seeing other workspace personas', async () => {
    const ws2 = await wsRepo.upsertForTelegram(2)
    await repo.create(workspaceId, { presetId: 'betsy', name: 'Betsy 1' })
    await repo.create(ws2.id, { presetId: 'alex', name: 'Alex 2' })

    const p1 = await repo.findByWorkspace(workspaceId)
    expect(p1!.name).toBe('Betsy 1')

    const p2 = await repo.findByWorkspace(ws2.id)
    expect(p2!.name).toBe('Alex 2')
  })
})
