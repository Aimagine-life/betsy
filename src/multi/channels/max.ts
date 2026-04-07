import type { InboundEvent, OutboundMessage, ChannelAdapter, StreamableOutbound } from './base.js'

const MAX_BASE = 'https://botapi.max.ru'
type FetchFn = typeof fetch

export function buildInboundFromMaxUpdate(update: any): InboundEvent | null {
  if (update?.update_type !== 'message_created') return null
  const m = update.message ?? {}
  const body = m.body ?? {}
  const recipient = m.recipient ?? {}
  const sender = m.sender ?? {}

  const chatId = recipient.chat_id ?? sender.user_id
  if (!chatId) return null

  return {
    channel: 'max',
    chatId: String(chatId),
    userId: String(sender.user_id ?? ''),
    userDisplay: sender.name ?? String(sender.user_id ?? ''),
    text: body.text ?? '',
    messageId: String(body.mid ?? ''),
    timestamp: new Date(update.timestamp ?? Date.now()),
    isVoiceMessage: false,
    raw: update,
  }
}

export class MaxAdapter implements ChannelAdapter {
  readonly name = 'max' as const
  private token: string
  private fetchFn: FetchFn
  private handler?: (ev: InboundEvent) => Promise<void>
  private marker: number | null = null
  private stopping = false
  private pollPromise: Promise<void> | null = null

  constructor(token: string, fetchFn: FetchFn = fetch) {
    this.token = token
    this.fetchFn = fetchFn
  }

  async start(): Promise<void> {
    this.stopping = false
    this.pollPromise = this.pollLoop()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.pollPromise) {
      await this.pollPromise.catch(() => {})
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const url = new URL(`${MAX_BASE}/updates`)
        url.searchParams.set('timeout', '30')
        url.searchParams.set('limit', '100')
        if (this.marker !== null) url.searchParams.set('marker', String(this.marker))
        const res = await this.fetchFn(url.toString(), {
          headers: { Authorization: this.token },
        })
        if (!res.ok) {
          await new Promise((r) => setTimeout(r, 2000))
          continue
        }
        const data = (await res.json()) as any
        const updates = data.updates ?? []
        for (const update of updates) {
          const ev = buildInboundFromMaxUpdate(update)
          if (ev && this.handler) {
            try {
              await this.handler(ev)
            } catch (e) {
              console.error('[max] handler failed:', e)
            }
          }
        }
        if (data.marker !== undefined) this.marker = data.marker
      } catch (e) {
        if (!this.stopping) {
          console.error('[max] poll error:', e)
          await new Promise((r) => setTimeout(r, 3000))
        }
      }
    }
  }

  async sendMessage(msg: OutboundMessage): Promise<void> {
    const url = new URL(`${MAX_BASE}/messages`)
    url.searchParams.set('chat_id', msg.chatId)
    const body: any = { text: msg.text }
    const res = await this.fetchFn(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: this.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`MAX sendMessage failed: ${res.status}`)
    }
  }

  onMessage(handler: (ev: InboundEvent) => Promise<void>): void {
    this.handler = handler
  }

  async sendTyping(_chatId: string): Promise<void> {
    // MAX API: not implemented yet, noop
  }

  /**
   * MAX has no native streaming endpoint. Drain the stream, then send a single
   * normal message with the final text.
   */
  async streamMessage(msg: StreamableOutbound): Promise<void> {
    let lastText = ''
    for await (const accumulated of msg.textStream) {
      if (accumulated) lastText = accumulated
    }
    if (lastText) {
      await this.sendMessage({ chatId: msg.chatId, text: lastText })
    }
  }
}
