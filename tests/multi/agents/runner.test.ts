import { describe, it, expect, vi } from 'vitest'
import { runBetsy } from '../../../src/multi/agents/runner.js'

function mockDeps(overrides: any = {}) {
  const workspace = {
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
  const persona = {
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
    behaviorConfig: { voice: 'text_only', selfie: 'on_request', video: 'on_request' },
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  return {
    workspace,
    persona,
    wsRepo: { findById: vi.fn().mockResolvedValue(workspace) },
    personaRepo: { findByWorkspace: vi.fn().mockResolvedValue(persona) },
    factsRepo: { list: vi.fn().mockResolvedValue([]) },
    convRepo: {
      recent: vi.fn().mockResolvedValue([]),
      append: vi.fn().mockResolvedValue({}),
    },
    remindersRepo: {},
    s3: {},
    gemini: {},
    agentRunner: vi.fn().mockResolvedValue({
      text: 'Привет, Константин!',
      toolCalls: [],
      tokensUsed: 50,
    }),
    ttsSpeak: vi.fn().mockResolvedValue({ audioBase64: 'fake', mimeType: 'audio/pcm' }),
    ...overrides,
  }
}

describe('runBetsy', () => {
  it('returns text response and stores conversation', async () => {
    const deps = mockDeps()
    const result = await runBetsy({
      workspaceId: 'ws1',
      userMessage: 'Привет',
      channel: 'telegram',
      deps: deps as any,
    })
    expect(result.text).toBe('Привет, Константин!')
    expect(result.audio).toBeUndefined()
    expect(deps.convRepo.append).toHaveBeenCalledTimes(2)
  })

  it('speaks reply when persona behavior voice=voice_always', async () => {
    const deps = mockDeps()
    deps.persona.behaviorConfig.voice = 'voice_always'
    const result = await runBetsy({
      workspaceId: 'ws1',
      userMessage: 'Привет',
      channel: 'telegram',
      deps: deps as any,
    })
    expect(result.audio).toBeDefined()
    expect(deps.ttsSpeak).toHaveBeenCalled()
  })

  it('does not speak when voice=text_only', async () => {
    const deps = mockDeps()
    deps.persona.behaviorConfig.voice = 'text_only'
    const result = await runBetsy({
      workspaceId: 'ws1',
      userMessage: 'Hi',
      channel: 'telegram',
      deps: deps as any,
    })
    expect(result.audio).toBeUndefined()
    expect(deps.ttsSpeak).not.toHaveBeenCalled()
  })

  it('throws when workspace not found', async () => {
    const deps = mockDeps()
    deps.wsRepo.findById.mockResolvedValue(null)
    await expect(
      runBetsy({
        workspaceId: 'ws1',
        userMessage: 'Hi',
        channel: 'telegram',
        deps: deps as any,
      }),
    ).rejects.toThrow(/workspace/i)
  })
})
