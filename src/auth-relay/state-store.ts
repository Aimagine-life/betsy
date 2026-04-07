/**
 * In-memory state store for OAuth CSRF-protection.
 *
 * When /start is called, we generate a nonce, stash the OAuthState under
 * that nonce, and use the nonce as the `state` query param in the authorize
 * URL. When the provider redirects back to /callback with that state, we
 * take() the stored value and validate it belongs to the same flow.
 *
 * Entries auto-expire after ttlMs. The store is a singleton per process —
 * if you run multiple replicas of auth-relay behind a load balancer, you
 * MUST configure sticky sessions OR replace this with a shared store
 * (Redis). For now we only support a single replica, which is the intended
 * deployment model for auth.betsyai.io.
 */
import { randomBytes } from 'node:crypto'
import type { OAuthState } from './types.js'

export const DEFAULT_TTL_MS = 10 * 60 * 1000

export interface StateStoreOptions {
  ttlMs?: number
  now?: () => number
}

export class StateStore {
  private readonly map = new Map<string, OAuthState>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(opts: StateStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.now = opts.now ?? Date.now
  }

  /** Store a state and return the nonce that will identify it. */
  put(state: Omit<OAuthState, 'createdAt' | 'nonce'>): string {
    this.evictExpired()
    const nonce = randomBytes(16).toString('hex')
    const full: OAuthState = { ...state, createdAt: this.now(), nonce }
    this.map.set(nonce, full)
    return nonce
  }

  /**
   * Atomically fetch and remove a state by nonce. Returns null if the
   * entry is absent or expired. A second call with the same nonce always
   * returns null — this is important: it guarantees a single OAuth code
   * can only be processed once even if the user refreshes the callback URL.
   */
  take(nonce: string): OAuthState | null {
    const entry = this.map.get(nonce)
    if (!entry) return null
    this.map.delete(nonce)
    if (this.now() - entry.createdAt > this.ttlMs) return null
    return entry
  }

  /** Number of live (possibly expired-but-not-yet-evicted) entries. */
  size(): number {
    return this.map.size
  }

  /** Remove entries older than ttlMs. Called opportunistically on put(). */
  evictExpired(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [nonce, entry] of this.map) {
      if (entry.createdAt < cutoff) this.map.delete(nonce)
    }
  }
}
