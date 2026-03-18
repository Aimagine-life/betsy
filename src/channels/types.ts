import type { IncomingMessage, OutgoingMessage, ProgressCallback } from "../core/types.js";

export type MessageHandler = (msg: IncomingMessage, onProgress?: ProgressCallback) => Promise<OutgoingMessage>;

export interface Channel {
  name: string
  requiredConfig: string[]
  start(config: Record<string, string>): Promise<void>
  stop(): Promise<void>
  send(userId: string, message: OutgoingMessage): Promise<void>
  onMessage(handler: MessageHandler): void
}
