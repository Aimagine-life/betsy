import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  TelegramAdapter,
  buildFeedbackKeyboard,
  handleFeedbackCallback,
} from '../../../src/multi/channels/telegram.js'
import {
  getFeedbackRefStore,
  __resetFeedbackRefStoreForTests,
  FeedbackRefStore,
} from '../../../src/multi/feedback/ref-store.js'
import type { FeedbackService } from '../../../src/multi/feedback/service.js'

function makeMockApi() {
  const sendMessage = vi.fn(async (_chat: number, _text: string, _opts: any) => ({
    message_id: 777,
  }))
  const sendPhoto = vi.fn(async () => ({ message_id: 778 }))
  const sendVoice = vi.fn(async () => ({ message_id: 0 }))
  const sendChatAction = vi.fn(async () => {})
  return { sendMessage, sendPhoto, sendVoice, sendChatAction }
}

function adapterWithMockApi(api: ReturnType<typeof makeMockApi>) {
  const adapter = new TelegramAdapter('fake-token')
  // replace the internal bot.api — the adapter only touches bot.api for sends
  ;(adapter as any).bot = { api }
  return adapter
}

describe('telegram feedback integration', () => {
  beforeEach(() => {
    __resetFeedbackRefStoreForTests()
    delete process.env.BC_FEEDBACK_ENABLED
  })
  afterEach(() => {
    delete process.env.BC_FEEDBACK_ENABLED
  })

  it('buildFeedbackKeyboard encodes refId in callback_data', () => {
    const kb = buildFeedbackKeyboard('abc123')
    // InlineKeyboard exposes .inline_keyboard as a 2d array
    const rows = (kb as any).inline_keyboard as any[][]
    expect(rows[0][0].text).toBe('👍')
    expect(rows[0][0].callback_data).toBe('fb:up:abc123')
    expect(rows[0][1].text).toBe('👎')
    expect(rows[0][1].callback_data).toBe('fb:down:abc123')
  })

  it('sendMessage attaches reply_markup when flag enabled and refId present', async () => {
    process.env.BC_FEEDBACK_ENABLED = '1'
    const api = makeMockApi()
    const adapter = adapterWithMockApi(api)

    await adapter.sendMessage({
      chatId: '12345',
      text: 'Hello',
      feedbackRefId: 'deadbeef0011',
    })

    expect(api.sendMessage).toHaveBeenCalledOnce()
    const opts = api.sendMessage.mock.calls[0][2] as any
    expect(opts.reply_markup).toBeDefined()
    const kb = opts.reply_markup.inline_keyboard
    expect(kb[0][0].callback_data).toBe('fb:up:deadbeef0011')
  })

  it('sendMessage omits keyboard when flag disabled', async () => {
    const api = makeMockApi()
    const adapter = adapterWithMockApi(api)

    await adapter.sendMessage({
      chatId: '12345',
      text: 'Hello',
      feedbackRefId: 'deadbeef0011',
    })

    const opts = api.sendMessage.mock.calls[0][2] as any
    expect(opts.reply_markup).toBeUndefined()
  })

  it('sendMessage omits keyboard when flag enabled but no refId', async () => {
    process.env.BC_FEEDBACK_ENABLED = '1'
    const api = makeMockApi()
    const adapter = adapterWithMockApi(api)

    await adapter.sendMessage({ chatId: '12345', text: 'Hello' })

    const opts = api.sendMessage.mock.calls[0][2] as any
    expect(opts.reply_markup).toBeUndefined()
  })

  it('sendMessage backfills messageId into ref store after successful send', async () => {
    process.env.BC_FEEDBACK_ENABLED = '1'
    const store = getFeedbackRefStore()
    store.set('deadbeef0011', {
      workspaceId: 'ws1',
      channel: 'telegram',
      chatId: '12345',
      rawText: 'Hello',
    })

    const api = makeMockApi()
    const adapter = adapterWithMockApi(api)

    await adapter.sendMessage({
      chatId: '12345',
      text: 'Hello',
      feedbackRefId: 'deadbeef0011',
    })

    expect(store.get('deadbeef0011')?.messageId).toBe('777')
  })

  it('callback handler with valid refId submits feedback and clears ref', async () => {
    const store = getFeedbackRefStore()
    store.set('abc123deadb', {
      workspaceId: 'ws1',
      channel: 'telegram',
      chatId: '12345',
      rawText: 'Hello',
      userMessage: 'Hi',
      messageId: '777',
    })

    const submit = vi.fn(async () => ({} as any))
    const feedbackService = { submit } as unknown as FeedbackService

    const ctx: any = {
      callbackQuery: {
        data: 'fb:up:abc123deadb',
        message: { message_id: 777 },
      },
      answerCallbackQuery: vi.fn(async () => {}),
      editMessageReplyMarkup: vi.fn(async () => {}),
    }

    await handleFeedbackCallback(ctx, feedbackService)

    expect(submit).toHaveBeenCalledOnce()
    const payload = submit.mock.calls[0][0] as any
    expect(payload.workspaceId).toBe('ws1')
    expect(payload.rating).toBe(1)
    expect(payload.messageId).toBe('777')
    expect(payload.rawText).toBe('Hello')
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Спасибо за 👍' })
    // Ref consumed
    expect(store.get('abc123deadb')).toBeUndefined()
  })

  it('callback handler with thumbs-down reports -1', async () => {
    const store = getFeedbackRefStore()
    store.set('ffffffffffff', {
      workspaceId: 'ws1',
      channel: 'telegram',
      chatId: '1',
      messageId: '100',
    })
    const submit = vi.fn(async () => ({} as any))
    const ctx: any = {
      callbackQuery: { data: 'fb:down:ffffffffffff', message: { message_id: 100 } },
      answerCallbackQuery: vi.fn(async () => {}),
      editMessageReplyMarkup: vi.fn(async () => {}),
    }
    await handleFeedbackCallback(ctx, { submit } as any)
    expect(submit.mock.calls[0][0].rating).toBe(-1)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Спасибо, учту 👎' })
  })

  it('callback handler with stale refId answers "устарело" and skips submit', async () => {
    const submit = vi.fn(async () => ({} as any))
    const ctx: any = {
      callbackQuery: { data: 'fb:up:ab12cd34ef56', message: { message_id: 1 } },
      answerCallbackQuery: vi.fn(async () => {}),
      editMessageReplyMarkup: vi.fn(async () => {}),
    }
    await handleFeedbackCallback(ctx, { submit } as any)
    expect(submit).not.toHaveBeenCalled()
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Эта оценка устарела' })
  })

  it('callback handler tolerates missing feedback service', async () => {
    const store = getFeedbackRefStore()
    store.set('123456789abc', {
      workspaceId: 'ws1',
      channel: 'telegram',
      chatId: '1',
      messageId: '1',
    })
    const ctx: any = {
      callbackQuery: { data: 'fb:up:123456789abc', message: { message_id: 1 } },
      answerCallbackQuery: vi.fn(async () => {}),
      editMessageReplyMarkup: vi.fn(async () => {}),
    }
    await handleFeedbackCallback(ctx, undefined)
    expect(ctx.answerCallbackQuery).toHaveBeenCalled()
    // Ref still consumed
    expect(store.get('123456789abc')).toBeUndefined()
  })

  it('refId stays under telegram 64-byte callback_data limit', () => {
    const refId = FeedbackRefStore.newRefId()
    expect(Buffer.byteLength(`fb:down:${refId}`)).toBeLessThanOrEqual(64)
  })
})
