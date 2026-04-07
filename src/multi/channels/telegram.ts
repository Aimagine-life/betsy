import { Bot, type Context, InputFile } from 'grammy'
import type { InboundEvent, OutboundMessage, ChannelAdapter, StreamableOutbound } from './base.js'

export function buildInboundFromTelegramCtx(ctx: Context): InboundEvent {
  const msg = ctx.message!
  const from = ctx.from!
  const chat = ctx.chat!
  const display =
    from.first_name?.trim() ||
    from.username ||
    String(from.id)
  const isVoice = (msg as any).voice !== undefined
  return {
    channel: 'telegram',
    chatId: String(chat.id),
    userId: String(from.id),
    userDisplay: display,
    text: (msg as any).text ?? '',
    messageId: String(msg.message_id),
    timestamp: new Date((msg.date ?? 0) * 1000),
    isVoiceMessage: isVoice,
    raw: ctx,
  }
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram' as const
  private bot: Bot
  private handler?: (ev: InboundEvent) => Promise<void>

  constructor(token: string) {
    this.bot = new Bot(token)
  }

  async start(): Promise<void> {
    this.bot.on('message', async (ctx) => {
      if (!ctx.message || !ctx.from || !ctx.chat) return
      if (!this.handler) return
      const ev = buildInboundFromTelegramCtx(ctx)
      try {
        await this.handler(ev)
      } catch (e) {
        console.error('[telegram] handler failed:', e)
      }
    })
    // Fire-and-forget bot start; long polling runs in background
    void this.bot.start()
  }

  async stop(): Promise<void> {
    await this.bot.stop()
  }

  async sendMessage(msg: OutboundMessage): Promise<void> {
    const chatId = Number(msg.chatId)

    // If image present — send as photo with caption
    if (msg.image) {
      if ('url' in msg.image) {
        await this.bot.api.sendPhoto(chatId, msg.image.url, {
          caption: msg.text,
        })
      } else {
        const buf = Buffer.from(msg.image.base64, 'base64')
        await this.bot.api.sendPhoto(chatId, new InputFile(buf, 'image.png'), {
          caption: msg.text,
        })
      }
      return
    }

    // Text always
    if (msg.text && msg.text.length > 0) {
      await this.bot.api.sendMessage(chatId, msg.text)
    }

    // Audio as voice message
    if (msg.audio) {
      const buf = Buffer.from(msg.audio.base64, 'base64')
      await this.bot.api.sendVoice(chatId, new InputFile(buf, 'voice.ogg'))
    }
  }

  onMessage(handler: (ev: InboundEvent) => Promise<void>): void {
    this.handler = handler
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.bot.api.sendChatAction(Number(chatId), 'typing')
    } catch (e) {
      // not fatal — just no indicator
    }
  }

  /**
   * Stream a message live via Bot API 9.5 sendMessageDraft. Each chunk replaces
   * the previously-shown draft text. When the stream ends, the draft is
   * finalized as a real message via sendMessage.
   *
   * Falls back gracefully to a single sendMessage if sendMessageDraft is not
   * supported on the current Bot API version (older deployments) or fails.
   */
  async streamMessage(msg: StreamableOutbound): Promise<void> {
    const chatIdNum = Number(msg.chatId)
    // draft_id must be a non-zero Integer per Bot API spec
    const draftId =
      ((Date.now() & 0x7fffffff) ^ Math.floor(Math.random() * 0x7fffffff)) || 1
    let lastText = ''
    let draftSupported = true
    let throttleUntil = 0

    try {
      for await (const accumulated of msg.textStream) {
        if (!accumulated || accumulated === lastText) continue
        lastText = accumulated

        if (!draftSupported) continue

        // Light client-side throttle: at most ~5 draft updates/sec.
        // Telegram says no rate limit on drafts, but we still avoid hammering.
        const now = Date.now()
        if (now < throttleUntil) continue
        throttleUntil = now + 200

        // Telegram limits text to 4096 chars; truncate for streaming preview.
        const chunkText = accumulated.length > 4096 ? accumulated.slice(0, 4096) : accumulated

        try {
          await (this.bot.api.raw as any).sendMessageDraft({
            chat_id: chatIdNum,
            draft_id: draftId,
            text: chunkText,
          })
        } catch (e: any) {
          const desc: string = e?.description ?? e?.message ?? ''
          // Method not present (old Bot API): code 404 or "method not found"
          if (
            e?.error_code === 404 ||
            /method not found|not implemented|unknown method/i.test(desc)
          ) {
            draftSupported = false
          } else {
            // Any other error — stop streaming, will send final via sendMessage below
            draftSupported = false
          }
        }
      }
    } finally {
      // Finalize: send the actual message regardless. This becomes the persisted
      // message in the chat history. If draft streaming worked, Telegram replaces
      // the animated draft with this real message.
      if (lastText && lastText.length > 0) {
        const finalText = lastText.length > 4096 ? lastText.slice(0, 4096) : lastText
        try {
          await this.bot.api.sendMessage(chatIdNum, finalText)
        } catch {
          // best-effort
        }
      }
    }
  }
}
