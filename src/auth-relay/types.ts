/**
 * Shared types for the standalone auth-relay service.
 *
 * The auth-relay runs as a separate Node.js process (e.g. behind
 * auth.betsyai.io) and performs the interactive OAuth flow with
 * upstream providers on behalf of Betsy workspaces. It has NO database
 * access — it only talks to the OAuth provider and the multi-server
 * via an HMAC-signed POST to /oauth/token.
 */

export type ProviderId = 'google' | 'notion'

export interface ProviderConfig {
  id: ProviderId
  name: string
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  clientSecret: string
  /** Default scopes applied when the /start request doesn't specify any. */
  defaultScopes: string[]
}

export interface OAuthState {
  provider: ProviderId
  workspaceId: string
  integration: string
  scopes: string[]
  returnTo: string
  createdAt: number
  nonce: string
}

/**
 * Payload posted to the upstream multi-server /oauth/token endpoint.
 * MUST match the zod schema in src/multi/oauth/relay-callback.ts.
 */
export interface UpstreamTokenPayload {
  workspace_id: string
  provider: ProviderId
  account_label?: string
  access_token: string
  refresh_token?: string
  expires_at?: string
  scopes?: string[]
  metadata?: Record<string, unknown>
  integration?: string
}

export interface ExchangeResult {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  id_token?: string
  token_type?: string
  /** Extra fields we want to pass through to upstream metadata. */
  raw?: Record<string, unknown>
}
