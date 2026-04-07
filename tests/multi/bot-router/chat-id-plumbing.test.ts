import { describe, it, expect, vi } from 'vitest'
import { BotRouter } from '../../../src/multi/bot-router/router.js'
import type { InboundEvent } from '../../../src/multi/channels/base.js'

describe('BotRouter chat_id plumbing', () => {
  it('passes chatId and numeric externalMessageId to convRepo.append for user messages', async () => {
    const appendSpy = vi.fn().mockResolvedValue({ id: 'row1' })
    const fakeChannel = {
      name: 'telegram' as const,
      start: async () => {},
      stop: async () => {},
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      onMessage: () => {},
    }
    const router = new BotRouter({
      wsRepo: {
        upsertForTelegram: vi.fn().mockResolvedValue({
          id: 'ws1',
          status: 'active',
          displayName: 'X',
          addressForm: 'ty',
        }),
        upsertForMax: vi.fn(),
        updateLastActiveChannel: vi.fn(),
      } as any,
      personaRepo: {
        findByWorkspace: vi.fn().mockResolvedValue({ behaviorConfig: {}, voiceId: 'v' }),
      } as any,
      factsRepo: {} as any,
      convRepo: { append: appendSpy } as any,
      linkingSvc: { verifyAndLink: vi.fn() } as any,
      channels: { telegram: fakeChannel as any },
      runBetsyFn: vi.fn().mockResolvedValue({ text: 'hi', toolCalls: [], tokensUsed: 0 }),
      runBetsyDeps: {} as any,
    })

    const ev: InboundEvent = {
      channel: 'telegram',
      chatId: '99',
      userId: '1',
      userDisplay: 'u',
      text: 'привет',
      messageId: '42',
      timestamp: new Date(),
      isVoiceMessage: false,
      raw: null,
    }
    await router.handleInbound(ev)

    expect(appendSpy).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({
        chatId: '99',
        externalMessageId: 42,
      }),
    )
  })
})
