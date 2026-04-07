import type { InboundEvent } from '../channels/base.js'
import { log } from '../observability/logger.js'

/**
 * Per-user inbound coalescer.
 *
 * Why: people often send messages in bursts ("привет\nкак дела\nчто делаешь")
 * and a real human would wait for the burst to finish before answering. Plus
 * processing each message in parallel breaks conversation order in DB and
 * lets the LLM see incomplete history. The coalescer solves both:
 *
 *   - Buffers incoming messages from the same user channel
 *   - Waits `debounceMs` of silence before flushing the batch
 *   - Forces flush after `maxWaitMs` even if the user keeps typing
 *   - Forces flush at `maxBatchSize` messages
 *   - Serializes processing per-user: while one batch is being processed,
 *     new messages just join the next batch (no parallel turns per user)
 *
 * Keying is by `channel:userId` because that's stable and known immediately,
 * before workspace resolution. Two channels of the same person resolve to
 * one workspace anyway, but they're separate physical chats — coalescing
 * across channels would deliver one chat's burst into another chat.
 */

export interface CoalescerOptions {
  /** Base debounce window when there are no signals to adapt from. */
  debounceMs: number
  /** Lower clamp for the dynamic debounce. */
  minDebounceMs: number
  /** Upper clamp for the dynamic debounce. */
  maxDebounceMs: number
  maxWaitMs: number
  maxBatchSize: number
}

interface BucketState {
  events: InboundEvent[]
  /** Arrival timestamps parallel to events[] — used for gap analysis. */
  arrivalsAt: number[]
  /** When the first message in the current batch arrived */
  firstArrivedAt: number
  /** Active debounce timer, cleared on new message or flush */
  timer: NodeJS.Timeout | null
  /** True while processBatch is running for this bucket */
  processing: boolean
}

/**
 * Compute a debounce window using ADDITIVE signals on top of a zero base.
 *
 * Philosophy: by default react instantly (base = 0). Only add waiting time
 * when there are concrete signals that more messages are coming. Signals
 * accumulate, then the result is clamped to [min, max].
 *
 * Signals (each ADDS milliseconds):
 *  - No terminal punctuation in last msg          : +5s (mid-thought)
 *  - Trailing `,:-—`                              : +8s (clearly continuing)
 *  - Last msg length < 10 chars                   : +5s ("ага", "ок")
 *  - Last msg length < 4 chars                    : +3s additional
 *  - Average gap between recent msgs < 3s         : +5s (active burst)
 *  - First msg in batch, very short, no punct     : +3s extra (likely opener)
 *
 * Trailing `?.!…` adds nothing — sentence is complete, fire immediately.
 */
function computeDynamicDebounce(
  bucket: BucketState,
  base: number,
  min: number,
  max: number,
): number {
  const n = bucket.events.length
  if (n === 0) return base

  let ms = base
  const lastText = (bucket.events[n - 1].text ?? '').trim()
  const lastChar = lastText.slice(-1)
  const hasTerminal = /[?.!…]/.test(lastChar)
  const hasContinuation = /[,:\-—]/.test(lastChar)

  // Punctuation signals
  if (hasContinuation) {
    ms += 8000
  } else if (!hasTerminal && lastText.length > 0) {
    ms += 5000
  }
  // Short message signals
  if (lastText.length > 0 && lastText.length < 10) {
    ms += 5000
    if (lastText.length < 4) ms += 3000
  }
  // Burst rhythm signal
  if (n >= 2) {
    const gaps: number[] = []
    for (let i = 1; i < n; i++) gaps.push(bucket.arrivalsAt[i] - bucket.arrivalsAt[i - 1])
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length
    if (avgGap < 3000) ms += 5000
  }
  // First message + short + no terminal — likely a greeting/opener with more coming
  if (n === 1 && !hasTerminal && lastText.length < 15) {
    ms += 3000
  }

  return Math.max(min, Math.min(max, Math.round(ms)))
}

export type ProcessBatchFn = (events: InboundEvent[]) => Promise<void>

export class InboundCoalescer {
  private buckets = new Map<string, BucketState>()
  constructor(
    private opts: CoalescerOptions,
    private processBatch: ProcessBatchFn,
  ) {}

  /**
   * Should be called by the channel adapter for every incoming message.
   * Returns immediately — actual processing happens later via processBatch.
   */
  push(ev: InboundEvent): void {
    // Voice messages bypass coalescing — they're heavyweight and usually
    // standalone, the user expects an immediate reply.
    if (ev.isVoiceMessage) {
      void this.processBatch([ev]).catch((e) =>
        log().error('coalescer: voice direct-process failed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      )
      return
    }

    const key = `${ev.channel}:${ev.userId}`
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = {
        events: [],
        arrivalsAt: [],
        firstArrivedAt: Date.now(),
        timer: null,
        processing: false,
      }
      this.buckets.set(key, bucket)
    }

    bucket.events.push(ev)
    bucket.arrivalsAt.push(Date.now())

    // Force flush if we hit batch size cap
    if (bucket.events.length >= this.opts.maxBatchSize) {
      log().info('coalescer: push (force max-batch)', { key, bucketSize: bucket.events.length })
      this.scheduleFlush(key, 0, 'max-batch-size')
      return
    }

    // Force flush if we've been waiting too long since the first message
    const elapsed = Date.now() - bucket.firstArrivedAt
    if (elapsed >= this.opts.maxWaitMs) {
      log().info('coalescer: push (force max-wait)', { key, elapsed })
      this.scheduleFlush(key, 0, 'max-wait')
      return
    }

    // Dynamic debounce based on rhythm and last message shape
    const dynamicMs = computeDynamicDebounce(
      bucket,
      this.opts.debounceMs,
      this.opts.minDebounceMs,
      this.opts.maxDebounceMs,
    )

    log().info('coalescer: push', {
      key,
      bucketSize: bucket.events.length,
      processing: bucket.processing,
      dynamicMs,
    })

    this.scheduleFlush(key, dynamicMs, 'debounce')
  }

  private scheduleFlush(key: string, delayMs: number, reason: string): void {
    const bucket = this.buckets.get(key)
    if (!bucket) return
    if (bucket.timer) {
      clearTimeout(bucket.timer)
      bucket.timer = null
    }
    bucket.timer = setTimeout(() => {
      void this.flush(key, reason)
    }, delayMs)
  }

  private async flush(key: string, reason: string): Promise<void> {
    const bucket = this.buckets.get(key)
    if (!bucket) return
    bucket.timer = null

    // If a previous batch is still processing, do nothing — we'll re-flush
    // when it completes (see the finally block below).
    if (bucket.processing) {
      log().info('coalescer: flush deferred (still processing)', { key })
      return
    }
    if (bucket.events.length === 0) return

    const batch = bucket.events.splice(0)
    bucket.arrivalsAt.splice(0)
    bucket.firstArrivedAt = Date.now() // reset for whatever comes next
    bucket.processing = true

    log().info('coalescer: flush', {
      key,
      reason,
      batchSize: batch.length,
    })

    try {
      await this.processBatch(batch)
    } catch (e) {
      log().error('coalescer: processBatch failed', {
        key,
        error: e instanceof Error ? e.message : String(e),
      })
    } finally {
      bucket.processing = false
      // If new messages arrived during processing, run another debounce window.
      if (bucket.events.length > 0) {
        log().info('coalescer: re-scheduling after processing', {
          key,
          pending: bucket.events.length,
        })
        this.scheduleFlush(key, this.opts.debounceMs, 'post-process')
      } else {
        // Empty bucket — clean up so the map doesn't grow unbounded
        this.buckets.delete(key)
      }
    }
  }
}
