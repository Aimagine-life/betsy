import { describe, it, expect, vi } from 'vitest'
import { BotRouter } from '../../../src/multi/bot-router/router.js'

function mockDeps(overrides: any = {}) {
  const onboardingWorkspace = {
    id: 'ws1',
    ownerTgId: 123,
    ownerMaxId: null,
    displayName: null,
    businessContext: null,
    addressForm: 'ty',
    personaId: 'betsy',
    plan: 'trial',
    status: 'onboarding',
    tokensUsedPeriod: 0,
    tokensLimitPeriod: 100000,
    periodResetAt: null,
    balanceKopecks: 0,
    lastActiveChannel: null,
    notifyChannelPref: 'auto',
    tz: 'Europe/Moscow',
    createdAt: new Date(),
  }
  const activeWorkspace = { ...onboardingWorkspace, displayName: 'Konstantin', businessContext: 'x', status: 'active' }

  return {
    workspace: activeWorkspace,
    wsRepo: {
      upsertForTelegram: vi.fn().mockResolvedValue(activeWorkspace),
      upsertForMax: vi.fn().mockResolvedValue(activeWorkspace),
      findById: vi.fn().mockResolvedValue(activeWorkspace),
      updateDisplayName: vi.fn(),
      updateBusinessContext: vi.fn(),
      updateStatus: vi.fn(),
      updateLastActiveChannel: vi.fn(),
      updateNotifyPref: vi.fn(),
    },
    personaRepo: {
      findByWorkspace: vi.fn().mockResolvedValue({
        id: 'p1',
        name: 'Betsy',
        gender: 'female',
        voiceId: 'Aoede',
        behaviorConfig: { voice: 'text_only', selfie: 'on_request', video: 'on_request' },
      }),
      create: vi.fn().mockResolvedValue({}),
    },
    factsRepo: { forgetAll: vi.fn() },
    linkingSvc: {
      generateCode: vi.fn().mockResolvedValue('123456'),
      verifyAndLink: vi.fn().mockResolvedValue({ success: false, reason: 'invalid_or_expired' }),
    },
    runBetsyFn: vi.fn().mockResolvedValue({
      text: 'Привет, Константин!',
      toolCalls: [],
      tokensUsed: 50,
    }),
    runBetsyDeps: {} as any,
    channels: {
      telegram: { sendMessage: vi.fn(), sendTyping: vi.fn(), name: 'telegram' } as any,
      max: { sendMessage: vi.fn(), sendTyping: vi.fn(), name: 'max' } as any,
    },
    ...overrides,
  }
}

describe('BotRouter', () => {
  it('resolves workspace and calls runBetsy for normal message', async () => {
    const deps = mockDeps()
    const router = new BotRouter(deps as any)
    await router.handleInbound({
      channel: 'telegram',
      chatId: '999',
      userId: '123',
      userDisplay: 'Konstantin',
      text: 'Привет',
      messageId: 'm1',
      timestamp: new Date(),
      isVoiceMessage: false,
      raw: null,
    })
    expect(deps.wsRepo.upsertForTelegram).toHaveBeenCalledWith(123)
    expect(deps.runBetsyFn).toHaveBeenCalled()
    expect(deps.channels.telegram.sendMessage).toHaveBeenCalled()
    expect(deps.channels.telegram.sendTyping).toHaveBeenCalled()
  })

  it('routes /start command through command handler', async () => {
    const deps = mockDeps()
    const router = new BotRouter(deps as any)
    await router.handleInbound({
      channel: 'telegram',
      chatId: '999',
      userId: '123',
      userDisplay: 'K',
      text: '/start',
      messageId: 'm1',
      timestamp: new Date(),
      isVoiceMessage: false,
      raw: null,
    })
    expect(deps.runBetsyFn).not.toHaveBeenCalled()
    expect(deps.channels.telegram.sendMessage).toHaveBeenCalled()
    const call = deps.channels.telegram.sendMessage.mock.calls[0][0]
    expect(call.text).toMatch(/betsy/i)
  })

  it('runs onboarding FSM when workspace status is onboarding', async () => {
    const deps = mockDeps()
    const onboardingWs = {
      ...deps.workspace,
      displayName: null,
      businessContext: null,
      status: 'onboarding',
    }
    deps.wsRepo.upsertForTelegram.mockResolvedValue(onboardingWs)
    deps.wsRepo.findById.mockResolvedValue(onboardingWs)
    const router = new BotRouter(deps as any)
    await router.handleInbound({
      channel: 'telegram',
      chatId: '999',
      userId: '123',
      userDisplay: 'K',
      text: 'Константин',
      messageId: 'm1',
      timestamp: new Date(),
      isVoiceMessage: false,
      raw: null,
    })
    expect(deps.wsRepo.updateDisplayName).toHaveBeenCalledWith('ws1', 'Константин')
    expect(deps.runBetsyFn).not.toHaveBeenCalled()
    expect(deps.channels.telegram.sendMessage).toHaveBeenCalled()
  })

  it('attempts link code verification on 6-digit input', async () => {
    const deps = mockDeps()
    deps.linkingSvc.verifyAndLink.mockResolvedValue({
      success: true,
      workspaceId: 'ws-other',
    })
    const router = new BotRouter(deps as any)
    await router.handleInbound({
      channel: 'max',
      chatId: '999',
      userId: '555',
      userDisplay: 'K',
      text: '123456',
      messageId: 'm1',
      timestamp: new Date(),
      isVoiceMessage: false,
      raw: null,
    })
    expect(deps.linkingSvc.verifyAndLink).toHaveBeenCalledWith('123456', {
      fromChannel: 'max',
      newChannelUserId: 555,
    })
    expect(deps.channels.max.sendMessage).toHaveBeenCalled()
  })

  it('updates last_active_channel on every message', async () => {
    const deps = mockDeps()
    const router = new BotRouter(deps as any)
    await router.handleInbound({
      channel: 'telegram',
      chatId: '999',
      userId: '123',
      userDisplay: 'K',
      text: 'Привет',
      messageId: 'm1',
      timestamp: new Date(),
      isVoiceMessage: false,
      raw: null,
    })
    expect(deps.wsRepo.updateLastActiveChannel).toHaveBeenCalledWith('ws1', 'telegram')
  })
})
