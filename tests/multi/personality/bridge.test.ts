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

describe('buildSystemPromptForPersona', () => {
  it('produces a non-empty prompt including persona name', () => {
    const out = buildSystemPromptForPersona({
      persona: basePersona,
      userDisplayName: 'Konstantin',
      addressForm: 'ty',
    })
    expect(out).toContain('Betsy')
    expect(out.length).toBeGreaterThan(200)
  })

  it('mentions the user by name when provided', () => {
    const out = buildSystemPromptForPersona({
      persona: basePersona,
      userDisplayName: 'Konstantin',
      addressForm: 'ty',
    })
    expect(out).toContain('Konstantin')
  })

  it('respects ty vs vy address form', () => {
    const ty = buildSystemPromptForPersona({
      persona: basePersona,
      userDisplayName: 'Konstantin',
      addressForm: 'ty',
    })
    const vy = buildSystemPromptForPersona({
      persona: basePersona,
      userDisplayName: 'Konstantin',
      addressForm: 'vy',
    })
    expect(ty).toMatch(/на ты/i)
    expect(vy).toMatch(/на вы/i)
  })

  it('uses custom personalityPrompt when provided', () => {
    const custom: Persona = {
      ...basePersona,
      personalityPrompt: 'Я саркастичная и колкая Betsy.',
    }
    const out = buildSystemPromptForPersona({
      persona: custom,
      userDisplayName: 'K',
      addressForm: 'ty',
    })
    expect(out).toContain('саркастичная')
  })

  it('uses biography when provided', () => {
    const withBio: Persona = {
      ...basePersona,
      biography: 'Betsy родилась в Санкт-Петербурге, любит кофе.',
    }
    const out = buildSystemPromptForPersona({
      persona: withBio,
      userDisplayName: 'K',
      addressForm: 'ty',
    })
    expect(out).toContain('Санкт-Петербурге')
  })
})
