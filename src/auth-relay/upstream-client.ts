/**
 * HMAC-signed client for posting OAuth tokens to the upstream multi-server.
 *
 * The signature contract MUST match src/multi/oauth/relay-callback.ts:
 *  - HMAC-SHA256 over `${timestamp}.${rawBody}` using BC_OAUTH_RELAY_SECRET
 *  - hex-encoded digest
 *  - sent as X-Relay-Signature header
 *  - timestamp is unix seconds, sent as X-Relay-Timestamp header
 *  - must be within ±300s of upstream clock
 *
 * Tokens are NEVER logged from here — the caller logs only non-sensitive
 * metadata (provider, workspaceId, status).
 */
import { createHmac } from 'node:crypto'
import type { FetchFn } from './google-exchange.js'
import type { UpstreamTokenPayload } from './types.js'

export interface UpstreamClientDeps {
  upstreamUrl: string
  secret: string
  fetchImpl?: FetchFn
  now?: () => number
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'UpstreamError'
  }
}

export async function postTokenToUpstream(
  payload: UpstreamTokenPayload,
  deps: UpstreamClientDeps,
): Promise<void> {
  if (!deps.secret) {
    throw new UpstreamError('upstream secret not configured')
  }
  const f = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now

  const rawBody = JSON.stringify(payload)
  const ts = String(Math.floor(now() / 1000))
  const signature = createHmac('sha256', deps.secret).update(`${ts}.${rawBody}`).digest('hex')

  const url = deps.upstreamUrl.replace(/\/+$/, '') + '/oauth/token'

  let res: Response
  try {
    res = await f(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-relay-timestamp': ts,
        'x-relay-signature': signature,
      },
      body: rawBody,
    })
  } catch (e) {
    throw new UpstreamError(`upstream network error: ${(e as Error).message}`)
  }

  if (!res.ok) {
    throw new UpstreamError(`upstream returned ${res.status}`, res.status)
  }
}
