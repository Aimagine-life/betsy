import { describe, it, expect } from 'vitest'
import { buildInboundFromTelegramCtx } from '../../../src/multi/channels/telegram.js'

describe('buildInboundFromTelegramCtx', () => {
  it('maps text message to InboundEvent', () => {
    const ctx: any = {
      chat: { id: 12345 },
      from: { id: 7, first_name: 'Константин', last_name: 'P' },
      message: {
        message_id: 42,
        text: 'Привет',
        date: Math.floor(Date.now() / 1000),
      },
    }
    const ev = buildInboundFromTelegramCtx(ctx)
    expect(ev.channel).toBe('telegram')
    expect(ev.chatId).toBe('12345')
    expect(ev.userId).toBe('7')
    expect(ev.userDisplay).toBe('Константин')
    expect(ev.text).toBe('Привет')
    expect(ev.messageId).toBe('42')
    expect(ev.isVoiceMessage).toBe(false)
  })

  it('flags voice message', () => {
    const ctx: any = {
      chat: { id: 1 },
      from: { id: 2, first_name: 'K' },
      message: {
        message_id: 10,
        voice: { file_id: 'x', duration: 3 },
        date: Math.floor(Date.now() / 1000),
      },
    }
    const ev = buildInboundFromTelegramCtx(ctx)
    expect(ev.isVoiceMessage).toBe(true)
    expect(ev.text).toBe('')
  })

  it('uses username when first_name absent', () => {
    const ctx: any = {
      chat: { id: 1 },
      from: { id: 2, username: 'kostya' },
      message: { message_id: 10, text: 'hi', date: 0 },
    }
    expect(buildInboundFromTelegramCtx(ctx).userDisplay).toBe('kostya')
  })
})
