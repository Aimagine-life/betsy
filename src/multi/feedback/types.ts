/** Feedback rating — thumbs up (+1) or thumbs down (-1). */
export type Rating = -1 | 1

/** Persisted feedback entry. Mirrors bc_feedback schema. */
export interface FeedbackEntry {
  id: string
  workspaceId: string
  conversationId?: string
  channel: 'telegram' | 'max'
  chatId: string
  messageId: string
  rating: Rating
  reason?: string
  rawText?: string
  userMessage?: string
  createdAt: Date
}

/** Input to FeedbackService.submit / FeedbackRepo.record. */
export interface RecordFeedbackInput {
  workspaceId: string
  conversationId?: string
  channel: 'telegram' | 'max'
  chatId: string
  messageId: string
  rating: Rating
  reason?: string
  rawText?: string
  userMessage?: string
}

/** Aggregate stats over a rolling window. */
export interface FeedbackSummary {
  thumbsUp: number
  thumbsDown: number
  total: number
  /** thumbsUp / total, or 0 when total === 0. */
  ratio: number
}
