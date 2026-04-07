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
    factsRepo: {
      list: vi.fn().mockResolvedValue([]),
      listByKind: vi.fn().mockResolvedValue([]),
      listMissingEmbeddings: vi.fn().mockResolvedValue([]),
      searchByEmbedding: vi.fn().mockResolvedValue([]),
    },
    convRepo: {
      recent: vi.fn().mockResolvedValue([]),
      append: vi.fn().mockResolvedValue({ id: 'row-default' }),
      searchByEmbedding: vi.fn().mockResolvedValue([]),
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
      currentChatId: 'chat1',
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
      currentChatId: 'chat1',
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
      currentChatId: 'chat1',
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
        currentChatId: 'chat1',
        deps: deps as any,
      }),
    ).rejects.toThrow(/workspace/i)
  })

  it('runBetsy propagates runContext.replyTarget into BetsyResponse.replyTo', async () => {
    // The agentRunner stub finds the set_reply_target tool on the agent and
    // invokes it before returning, simulating Betsy calling the tool mid-loop.
    const agentRunner = vi.fn(async (agent: any) => {
      const tools = (agent as any).tools ?? []
      const setReplyTool = tools.find((t: any) => t.name === 'set_reply_target')
      if (setReplyTool) {
        await setReplyTool.execute({ externalMessageId: 777 })
      }
      return { text: 'вот это ты говорил', toolCalls: [], tokensUsed: 0 }
    })

    const convRepo = {
      append: vi.fn().mockResolvedValue({ id: 'row1' }),
      recent: vi.fn().mockResolvedValue([]),
      listMissingEmbeddings: vi.fn().mockResolvedValue([]),
      searchByEmbedding: vi.fn().mockResolvedValue([]),
    }
    const factsRepo = {
      list: vi.fn().mockResolvedValue([]),
      listByKind: vi.fn().mockResolvedValue([]),
      searchByEmbedding: vi.fn().mockResolvedValue([]),
      listMissingEmbeddings: vi.fn().mockResolvedValue([]),
      remember: vi.fn(),
    }
    const response = await runBetsy({
      workspaceId: 'ws1',
      userMessage: 'что я говорил про чай',
      channel: 'telegram',
      currentChatId: '100',
      deps: {
        wsRepo: {
          findById: vi.fn().mockResolvedValue({
            id: 'ws1',
            plan: 'trial',
            displayName: 'X',
            addressForm: 'ty',
          }),
        } as any,
        personaRepo: {
          findByWorkspace: vi.fn().mockResolvedValue({
            name: 'B',
            gender: 'female',
            voiceId: 'v',
            behaviorConfig: {},
            personalityPrompt: '',
          }),
        } as any,
        factsRepo: factsRepo as any,
        convRepo: convRepo as any,
        remindersRepo: {} as any,
        s3: {} as any,
        gemini: {
          models: { embedContent: vi.fn().mockRejectedValue(new Error('no-op')) },
        } as any,
        agentRunner: agentRunner as any,
      },
    })

    expect(response.replyTo).toBe(777)
    expect(response.assistantRowId).toBe('row1')
  })
})
