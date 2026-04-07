/**
 * Tiny in-memory IP rate limiter for /start. Not a general-purpose
 * bucket — just good enough to stop a trivial abuser from hammering the
 * OAuth consent flow.
 */
export interface RateLimiterOptions {
  maxRequests: number
  windowMs: number
  now?: () => number
}

interface Bucket {
  count: number
  resetAt: number
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly maxRequests: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(opts: RateLimiterOptions) {
    this.maxRequests = opts.maxRequests
    this.windowMs = opts.windowMs
    this.now = opts.now ?? Date.now
  }

  /** Returns true if the request is allowed, false if it should be rejected. */
  check(key: string): boolean {
    const t = this.now()
    const b = this.buckets.get(key)
    if (!b || t >= b.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: t + this.windowMs })
      this.gc(t)
      return true
    }
    if (b.count >= this.maxRequests) return false
    b.count += 1
    return true
  }

  private gc(t: number): void {
    // Cheap periodic cleanup — only touches a handful of entries to avoid
    // O(n) pauses on hot paths.
    if (this.buckets.size < 512) return
    for (const [k, v] of this.buckets) {
      if (t >= v.resetAt) this.buckets.delete(k)
    }
  }
}
