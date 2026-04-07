import { describe, it, expect } from 'vitest'
import { createBetsyAgent } from '../../../src/multi/agents/betsy-factory.js'
import type { Workspace } from '../../../src/multi/workspaces/types.js'
import type { Persona } from '../../../src/multi/personas/types.js'

const ws: Workspace = {
  id: 'ws1',
  ownerTgId: 123,
  ownerMaxId: null,
  displayName: 'K',
  businessContext: null,
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

const noopTools = {
  memoryTools: [],
  reminderTools: [],
  selfieTool: {
    name: 'generate_selfie',
    description: 'x',
    parameters: {} as any,
    execute: async () => ({}),
  },
}

function getModel(agent: any): string {
  // ADK LlmAgent may store model as string or as BaseLlm instance
  const m = agent.model
  if (typeof m === 'string') return m
  if (m && typeof m === 'object') {
    return m.model ?? m.name ?? m.modelName ?? String(m)
  }
  return String(m)
}

describe('createBetsyAgent', () => {
  it('returns an agent with name and model', () => {
    const agent = createBetsyAgent({
      workspace: ws,
      persona,
      ownerFacts: [],
      tools: noopTools,
      currentChannel: 'telegram',
    })
    expect(agent.name).toMatch(/betsy/i)
    expect(getModel(agent)).toContain('gemini-2.5-flash')
  })

  it('uses Pro model when plan is pro', () => {
    const agent = createBetsyAgent({
      workspace: { ...ws, plan: 'pro' },
      persona,
      ownerFacts: [],
      tools: noopTools,
      currentChannel: 'telegram',
    })
    expect(getModel(agent)).toContain('gemini-2.5-pro')
  })

  it('uses Flash for trial and personal', () => {
    for (const plan of ['trial', 'personal'] as const) {
      const agent = createBetsyAgent({
        workspace: { ...ws, plan },
        persona,
        ownerFacts: [],
        tools: noopTools,
        currentChannel: 'telegram',
      })
      expect(getModel(agent)).toContain('gemini-2.5-flash')
    }
  })
})
