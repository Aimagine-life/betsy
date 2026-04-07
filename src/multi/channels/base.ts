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

export interface ChannelAdapter {
  readonly name: ChannelName
  start(): Promise<void>
  stop(): Promise<void>
  sendMessage(msg: OutboundMessage): Promise<void>
  onMessage(handler: (ev: InboundEvent) => Promise<void>): void
  sendTyping?(chatId: string): Promise<void>
}
