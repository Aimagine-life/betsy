import { randomBytes } from 'node:crypto'

/** Data associated with an outgoing assistant message, used by the feedback
 *  callback handler to resolve a refId back to its workspace/chat/text.
 *
 *  Stored in-memory only (process-local). On restart refs evaporate and
 *  stale clicks answer "устарело". This is intentional — feedback is a
 *  best-effort signal, not a system of record. */
export interface FeedbackRefData {
  workspaceId: string
  channel: 'telegram' | 'max'
  chatId: string
  rawText?: string
  userMessage?: string
  conversationId?: string
  /** Native channel message id; filled in AFTER send() returns it. */
  messageId?: string
}

/** Simple FIFO-eviction LRU-ish store keyed by short refId.
 *
 *  Uses Map insertion order for O(1) eviction of the oldest entry. "Touching"
 *  an entry on get() is deliberately NOT implemented — a click is terminal
 *  so there's no reason to prolong its lifetime. */
export class FeedbackRefStore {
  private readonly map = new Map<string, FeedbackRefData>()
  constructor(private readonly maxSize: number = 10_000) {}

  /** Generate a fresh 12-hex-char refId (6 bytes entropy). Guaranteed to fit
   *  well within Telegram's 64-byte callback_data limit even with the
   *  "fb:up:" prefix (6 + 12 = 18 bytes). */
  static newRefId(): string {
    return randomBytes(6).toString('hex')
  }

  /** Insert a new ref. Evicts the oldest entry if the store is at capacity. */
  set(refId: string, data: FeedbackRefData): void {
    if (this.map.has(refId)) {
      this.map.delete(refId)
    } else if (this.map.size >= this.maxSize) {
      // Map iteration is insertion-order; first key is the oldest.
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(refId, data)
  }

  get(refId: string): FeedbackRefData | undefined {
    return this.map.get(refId)
  }

  /** Merge partial data into an existing ref (e.g. to backfill messageId
   *  once the send() call returns). No-op if the ref has been evicted. */
  update(refId: string, patch: Partial<FeedbackRefData>): void {
    const existing = this.map.get(refId)
    if (!existing) return
    this.map.set(refId, { ...existing, ...patch })
  }

  delete(refId: string): void {
    this.map.delete(refId)
  }

  /** Number of refs currently held — primarily for tests/metrics. */
  get size(): number {
    return this.map.size
  }
}

/** Process-wide singleton. Router writes, telegram adapter reads (to backfill
 *  messageId), feedback callback handler reads+deletes. */
let singleton: FeedbackRefStore | null = null
export function getFeedbackRefStore(): FeedbackRefStore {
  if (!singleton) singleton = new FeedbackRefStore()
  return singleton
}

/** Test helper — reset the singleton. Only used in vitest. */
export function __resetFeedbackRefStoreForTests(): void {
  singleton = null
}
