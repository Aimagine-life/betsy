export type ChannelName = 'telegram' | 'max'

export interface InboundEvent {
  channel: ChannelName
  chatId: string
  userId: string
  userDisplay: string
  text: string
  messageId: string
  timestamp: Date
  isVoiceMessage: boolean
  /** Raw platform-specific event, useful for diagnostics; never persist */
  raw: unknown
}

export interface OutboundMessage {
  chatId: string
  text: string
  audio?: { base64: string; mimeType: string }
  image?: { url: string } | { base64: string; mimeType: string }
  replyToMessageId?: string
}

export interface SendResult {
  /** Platform-native outgoing message id (Telegram message_id). Undefined if the
   *  platform does not return one or the adapter could not capture it. */
  externalMessageId?: number
}

export interface StreamableOutbound {
  chatId: string
  /** Async iterable that yields incrementally growing text. Each yield is the
   *  full accumulated text so far (NOT just the delta). */
  textStream: AsyncIterable<string>
  /** Optional explicit final text; if absent the last yielded value is used. */
  finalText?: string
  /** Resolves (just before final send) with an optional Telegram message id
   *  the final outgoing message should quote as a reply. Used by recall_messages
   *  + set_reply_target flow. Returning undefined = no reply-quote. */
  replyToPromise?: Promise<number | undefined>
}

export interface ChannelAdapter {
  readonly name: ChannelName
  start(): Promise<void>
  stop(): Promise<void>
  sendMessage(msg: OutboundMessage): Promise<SendResult>
  onMessage(handler: (ev: InboundEvent) => Promise<void>): void
  sendTyping?(chatId: string, action?: string): Promise<void>
  /** Stream a message via native channel streaming API if supported. */
  streamMessage?(msg: StreamableOutbound): Promise<SendResult>
}
