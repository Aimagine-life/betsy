import { Bot, type Context, InputFile } from 'grammy'
import type { InboundEvent, OutboundMessage, ChannelAdapter } from './base.js'

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
}
