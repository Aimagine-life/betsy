import { describe, it, expect, vi } from 'vitest'
import {
  buildInboundFromTelegramCtx,
  TelegramAdapter,
} from '../../../src/multi/channels/telegram.js'

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

async function* makeTextStream(chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) {
    yield c
    // tiny await so the throttle has a chance to advance
    await new Promise((r) => setTimeout(r, 250))
  }
}

describe('TelegramAdapter.streamMessage', () => {
  it('streams via sendMessageDraft and finalizes via sendMessage', async () => {
    const adapter = new TelegramAdapter('fake-token')
    const sendMessageDraft = vi.fn().mockResolvedValue(true)
    const sendMessage = vi.fn().mockResolvedValue({})
    ;(adapter as any).bot = {
      api: {
        raw: { sendMessageDraft },
        sendMessage,
      },
    }

    await adapter.streamMessage({
      chatId: '12345',
      textStream: makeTextStream(['Hi', 'Hi there', 'Hi there!']),
    })

    expect(sendMessageDraft).toHaveBeenCalled()
    const calls = sendMessageDraft.mock.calls
    // accumulating text — last draft call should match last chunk
    expect(calls[calls.length - 1][0].text).toBe('Hi there!')
    expect(calls[calls.length - 1][0].chat_id).toBe(12345)
    expect(calls[calls.length - 1][0].parse_mode).toBe('HTML')
    expect(typeof calls[0][0].draft_id).toBe('number')
    expect(calls[0][0].draft_id).not.toBe(0)
    // final sendMessage with full text + parse_mode
    expect(sendMessage).toHaveBeenCalledWith(12345, 'Hi there!', { parse_mode: 'HTML' })
  })

  it('falls back to sendMessage when sendMessageDraft is unsupported', async () => {
    const adapter = new TelegramAdapter('fake-token')
    const sendMessageDraft = vi.fn().mockRejectedValue({
      error_code: 404,
      description: 'method not found',
    })
    const sendMessage = vi.fn().mockResolvedValue({})
    ;(adapter as any).bot = {
      api: {
        raw: { sendMessageDraft },
        sendMessage,
      },
    }

    await adapter.streamMessage({
      chatId: '99',
      textStream: makeTextStream(['part1', 'part1 part2']),
    })

    // After first failure, no further draft calls expected
    expect(sendMessageDraft).toHaveBeenCalledTimes(1)
    // Final fallback message goes through
    expect(sendMessage).toHaveBeenCalledWith(99, 'part1 part2', { parse_mode: 'HTML' })
  })
})
