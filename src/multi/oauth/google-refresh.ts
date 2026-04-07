/**
 * Google OAuth token refresh middleware.
 *
 * Exchanges a refresh_token for a fresh access_token via Google's OAuth2
 * endpoint. Uses DI for `fetchImpl` / `clientId` / `clientSecret` to keep
 * it unit-testable without env pollution.
 *
 * SECURITY: never log full tokens or full response bodies. Only short
 * snippets / status codes are surfaced to logs.
 */
import { log } from '../observability/logger.js'

export class GoogleRefreshError extends Error {
  constructor(
    msg: string,
    public readonly code: 'NO_CLIENT_CREDS' | 'HTTP' | 'PARSE' | 'INVALID_GRANT',
  ) {
    super(msg)
    this.name = 'GoogleRefreshError'
  }
}

export interface GoogleRefreshResult {
  accessToken: string
  expiresAt: Date
  /** Sometimes Google rotates the refresh token; surface it so caller can persist it. */
  refreshToken?: string
}

export interface GoogleRefreshDeps {
  fetchImpl?: typeof fetch
  clientId?: string
  clientSecret?: string
}

export async function refreshGoogleToken(
  refreshToken: string,
  deps: GoogleRefreshDeps = {},
): Promise<GoogleRefreshResult> {
  const clientId = deps.clientId ?? process.env.BC_GOOGLE_CLIENT_ID
  const clientSecret = deps.clientSecret ?? process.env.BC_GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new GoogleRefreshError(
      'BC_GOOGLE_CLIENT_ID/BC_GOOGLE_CLIENT_SECRET not set',
      'NO_CLIENT_CREDS',
    )
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const fetchFn = deps.fetchImpl ?? fetch
  let res: Response
  try {
    res = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    })
  } catch (e) {
    throw new GoogleRefreshError(`network error: ${(e as Error).message}`, 'HTTP')
  }
  if (!res.ok) {
    let bodyText = ''
    try {
      bodyText = await res.text()
    } catch {
      // ignore
    }
    // Never log bodyText in full — it may contain sensitive data in rare cases.
    log().warn('google-refresh: non-2xx', {
      status: res.status,
      snippet: bodyText.slice(0, 80),
    })
    if (res.status === 400 && bodyText.includes('invalid_grant')) {
      throw new GoogleRefreshError('refresh token invalid or revoked', 'INVALID_GRANT')
    }
    throw new GoogleRefreshError(`http ${res.status}`, 'HTTP')
  }
  let data: any
  try {
    data = await res.json()
  } catch {
    throw new GoogleRefreshError('failed to parse response json', 'PARSE')
  }
  if (typeof data?.access_token !== 'string' || typeof data?.expires_in !== 'number') {
    throw new GoogleRefreshError('response missing access_token/expires_in', 'PARSE')
  }
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
  }
}
