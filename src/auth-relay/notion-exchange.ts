/**
 * Exchange an authorization code for an access token using Notion's
 * OAuth 2.0 token endpoint.
 *
 * Notion differs from Google: the client credentials are sent via
 * HTTP Basic Auth and the request body is JSON (not form-encoded).
 * See https://developers.notion.com/docs/authorization
 */
import type { ExchangeResult, ProviderConfig } from './types.js'
import type { ExchangeDeps } from './google-exchange.js'

export async function exchangeNotionCode(
  code: string,
  redirectUri: string,
  provider: ProviderConfig,
  deps: ExchangeDeps = {},
): Promise<ExchangeResult> {
  if (provider.id !== 'notion') {
    throw new Error(`notion-exchange called with provider=${provider.id}`)
  }
  const f = deps.fetchImpl ?? fetch

  const basic = Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString('base64')

  let res: Response
  try {
    res = await f(provider.tokenUrl, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    })
  } catch (e) {
    throw new Error(`notion token endpoint network error: ${(e as Error).message}`)
  }

  if (!res.ok) {
    throw new Error(`notion token endpoint returned ${res.status}`)
  }

  let json: any
  try {
    json = await res.json()
  } catch {
    throw new Error('notion token endpoint returned non-JSON body')
  }

  if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new Error('notion token response missing access_token')
  }

  // Notion returns workspace_id/bot_id/workspace_name — stash them in raw
  // so the server can forward useful metadata to upstream.
  const raw: Record<string, unknown> = {}
  for (const key of ['workspace_id', 'workspace_name', 'workspace_icon', 'bot_id', 'owner']) {
    if (json[key] !== undefined) raw[key] = json[key]
  }

  return {
    access_token: json.access_token,
    token_type: typeof json.token_type === 'string' ? json.token_type : undefined,
    raw,
  }
}
