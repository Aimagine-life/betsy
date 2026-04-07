import { describe, it, expect } from 'vitest'
import { buildSystemPromptForWorkspace } from '../../../src/multi/agents/prompt-builder.js'
import type { Workspace } from '../../../src/multi/workspaces/types.js'
import type { Persona } from '../../../src/multi/personas/types.js'

const ws: Workspace = {
  id: 'ws1',
  ownerTgId: 123,
  ownerMaxId: null,
  displayName: 'Konstantin',
  businessContext: 'Building AI agents',
  addressForm: 'ty',
  personaId: 'betsy',
  plan: 'personal',
  status: 'active',
  tokensUsedPeriod: 0,
  tokensLimitPeriod: 1_000_000,
  periodResetAt: null,
  balanceKopecks: 0,
  lastActiveChannel: 'telegram',
  notifyChannelPref: 'auto',
  tz: 'Europe/Moscow',
  createdAt: new Date(),
}

const persona: Persona = {
  id: 'p1',
  workspaceId: 'ws1',
  presetId: 'betsy',
  name: 'Betsy',
  gender: 'female',
  voiceId: 'Aoede',
  personalityPrompt: null,
  biography: null,
  avatarS3Key: null,
  referenceFrontS3Key: null,
  referenceThreeQS3Key: null,
  referenceProfileS3Key: null,
  behaviorConfig: { voice: 'auto', selfie: 'on_request', video: 'on_request' },
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe('buildSystemPromptForWorkspace', () => {
  it('includes persona name, owner name, and facts', () => {
    const out = buildSystemPromptForWorkspace({
      workspace: ws,
      persona,
      ownerFacts: ['Пьёт кофе без сахара', 'Любит котов'],
    })
    expect(out).toContain('Betsy')
    expect(out).toContain('Konstantin')
    expect(out).toContain('кофе без сахара')
    expect(out).toContain('котов')
  })
})
