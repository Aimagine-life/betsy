export interface IncomingMessage {
  channelName: string
  userId: string
  text: string
  timestamp: number
  metadata?: Record<string, unknown>
}

export interface OutgoingMessage {
  text: string
  mode?: 'text' | 'voice' | 'video' | 'selfie'
  mediaUrl?: string
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Progress events emitted by the Engine during agentic loop. */
export type EngineProgressEvent =
  | { type: 'thinking' }
  | { type: 'tool_start'; tool: string; turn: number }
  | { type: 'tool_end'; tool: string; turn: number; success: boolean }
  | { type: 'turn_complete'; turn: number; totalTurns: number }
  | { type: 'text_chunk'; chunk: string }

export type ProgressCallback = (event: EngineProgressEvent) => void
