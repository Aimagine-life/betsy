export type FactKind = 'preference' | 'fact' | 'task' | 'relationship' | 'event' | 'other'

export interface MemoryFact {
  id: string
  workspaceId: string
  kind: FactKind
  content: string
  meta: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface Conversation {
  id: string
  workspaceId: string
  channel: 'telegram' | 'max' | 'cabinet'
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls: unknown | null
  tokensUsed: number
  meta: Record<string, unknown>
  createdAt: Date
}
