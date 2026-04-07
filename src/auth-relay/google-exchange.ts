/**
 * Exchange an authorization code for an access/refresh token pair using
 * Google's OAuth 2.0 token endpoint. Standard form-encoded request.
 *
 * We keep this in its own module to make it trivial to mock in tests and
 * in the end-to-end simulation.
 */
import type { ExchangeResult, ProviderConfig } from './types.js'

export type FetchFn = typeof fetch

export interface ExchangeDeps {
  fetchImpl?: FetchFn
}

export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  provider: ProviderConfig,
  deps: ExchangeDeps = {},
): Promise<ExchangeResult> {
  if (provider.id !== 'google') {
    throw new Error(`google-exchange called with provider=${provider.id}`)
  }
  const f = deps.fetchImpl ?? fetch

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    redirect_uri: redirectUri,
  })

  let res: Response
  try {
    res = await f(provider.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
  } catch (e) {
    throw new Error(`google token endpoint network error: ${(e as Error).message}`)
  }

  if (!res.ok) {
    // Don't include the response body verbatim — it can leak the code.
    throw new Error(`google token endpoint returned ${res.status}`)
  }

  let json: any
  try {
    json = await res.json()
  } catch {
    throw new Error('google token endpoint returned non-JSON body')
  }

  if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new Error('google token response missing access_token')
  }

  return {
    access_token: json.access_token,
    refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    expires_in: typeof json.expires_in === 'number' ? json.expires_in : undefined,
    scope: typeof json.scope === 'string' ? json.scope : undefined,
    id_token: typeof json.id_token === 'string' ? json.id_token : undefined,
    token_type: typeof json.token_type === 'string' ? json.token_type : undefined,
  }
}
