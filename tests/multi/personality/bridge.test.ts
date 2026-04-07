import { describe, it, expect } from 'vitest'
import { buildSystemPromptForPersona } from '../../../src/multi/personality/bridge.js'
import type { Persona } from '../../../src/multi/personas/types.js'

const basePersona: Persona = {
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

describe('buildSystemPromptForPersona (delegates to core)', () => {
  it('includes persona name', () => {
    const out = buildSystemPromptForPersona({
      persona: basePersona,
      userDisplayName: 'Konstantin',
      addressForm: 'ty',
      ownerFacts: [],
    })
    expect(out).toContain('Betsy')
  })

  it('includes gender block when gender is female', () => {
    const out = buildSystemPromptForPersona({
      persona: basePersona,
      userDisplayName: 'K',
      addressForm: 'ty',
      ownerFacts: [],
    })
    expect(out).toMatch(/женщина/i)
  })

  it('includes owner name and address form', () => {
    const out = buildSystemPromptForPersona({
      persona: basePersona,
      userDisplayName: 'Konstantin',
      addressForm: 'ty',
      ownerFacts: [],
    })
    expect(out).toContain('Konstantin')
    expect(out).toMatch(/на ты/i)
  })

  it('includes owner facts in owner block', () => {
    const out = buildSystemPromptForPersona({
      persona: basePersona,
      userDisplayName: 'Konstantin',
      addressForm: 'ty',
      ownerFacts: ['Пьёт кофе без сахара', 'Работает в Wildbots'],
    })
    expect(out).toContain('кофе без сахара')
    expect(out).toContain('Wildbots')
  })

  it('uses personalityPrompt as customInstructions when set', () => {
    const out = buildSystemPromptForPersona({
      persona: { ...basePersona, personalityPrompt: 'Я люблю шоколад и котов.' },
      userDisplayName: 'K',
      addressForm: 'ty',
      ownerFacts: [],
    })
    expect(out).toContain('шоколад')
  })
})
