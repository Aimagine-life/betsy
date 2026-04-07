/**
 * OAuth provider registry for the auth-relay.
 *
 * Loaded from env vars at startup. A provider is only enabled if both
 * client_id and client_secret are present.
 */
import type { ProviderConfig, ProviderId } from './types.js'

export function loadProviders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = {}

  if (env.BC_GOOGLE_CLIENT_ID && env.BC_GOOGLE_CLIENT_SECRET) {
    providers.google = {
      id: 'google',
      name: 'Google',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientId: env.BC_GOOGLE_CLIENT_ID,
      clientSecret: env.BC_GOOGLE_CLIENT_SECRET,
      defaultScopes: ['openid', 'email'],
    }
  }

  if (env.BC_NOTION_CLIENT_ID && env.BC_NOTION_CLIENT_SECRET) {
    providers.notion = {
      id: 'notion',
      name: 'Notion',
      authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
      tokenUrl: 'https://api.notion.com/v1/oauth/token',
      clientId: env.BC_NOTION_CLIENT_ID,
      clientSecret: env.BC_NOTION_CLIENT_SECRET,
      defaultScopes: [],
    }
  }

  return providers
}

export function isKnownProvider(id: string): id is ProviderId {
  return id === 'google' || id === 'notion'
}
