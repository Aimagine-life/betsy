/**
 * OAuth resolver: takes a BuiltinMcpOAuth spec + workspaceId and produces
 * a map of env vars ready to be passed to an MCP server process.
 *
 * - Reads the persisted token from OAuthRepo.
 * - Proactively refreshes Google tokens near expiry (skew configurable).
 * - Persists rotated tokens best-effort: if upsertToken fails we still
 *   return the in-memory refreshed token so the current startup succeeds,
 *   but log a warning so operators notice the DB issue.
 */
import type { OAuthRepo } from '../../oauth/repo.js'
import { refreshGoogleToken, GoogleRefreshError } from '../../oauth/google-refresh.js'
import { log } from '../../observability/logger.js'
import type { BuiltinMcpOAuth } from './builtin.js'

export interface ResolveOAuthEnvInput {
  workspaceId: string
  oauth: BuiltinMcpOAuth
  accountLabel?: string
}

export type ResolveOAuthEnvResult =
  | { ok: true; env: Record<string, string> }
  | {
      ok: false
      reason: 'no_token' | 'expired_no_refresh' | 'refresh_failed' | 'crypto_error'
      detail?: string
    }

export interface OAuthResolverDeps {
  oauthRepo: OAuthRepo
  /** Skew before expires_at when we proactively refresh, in seconds. Default 60. */
  refreshSkewSeconds?: number
  /** Override Google refresh function for testing. */
  refreshGoogleImpl?: typeof refreshGoogleToken
}

export class OAuthResolver {
  constructor(private readonly deps: OAuthResolverDeps) {}

  async resolve(input: ResolveOAuthEnvInput): Promise<ResolveOAuthEnvResult> {
    const { workspaceId, oauth, accountLabel } = input
    let token
    try {
      token = await this.deps.oauthRepo.getToken(workspaceId, oauth.provider, accountLabel)
    } catch (e) {
      log().warn('oauth-resolver: getToken failed', {
        provider: oauth.provider,
        workspaceId,
        error: (e as Error).message,
      })
      return { ok: false, reason: 'crypto_error', detail: (e as Error).message }
    }
    if (!token) return { ok: false, reason: 'no_token' }

    // Refresh if expired or close to expiring.
    const skewMs = (this.deps.refreshSkewSeconds ?? 60) * 1000
    const needsRefresh =
      !!token.expiresAt && token.expiresAt.getTime() - Date.now() < skewMs
    if (needsRefresh) {
      if (oauth.provider !== 'google') {
        return { ok: false, reason: 'expired_no_refresh' }
      }
      if (!token.refreshToken) {
        return { ok: false, reason: 'expired_no_refresh' }
      }
      try {
        const refreshFn = this.deps.refreshGoogleImpl ?? refreshGoogleToken
        const refreshed = await refreshFn(token.refreshToken)
        const newRefresh = refreshed.refreshToken ?? token.refreshToken
        // Best-effort persistence: if DB write fails we still return the
        // refreshed in-memory token so this startup can proceed.
        try {
          await this.deps.oauthRepo.upsertToken(workspaceId, {
            provider: oauth.provider,
            scopes: token.scopes,
            accessToken: refreshed.accessToken,
            refreshToken: newRefresh,
            expiresAt: refreshed.expiresAt,
            accountLabel: token.accountLabel,
            metadata: token.metadata,
          })
        } catch (persistErr) {
          log().warn('oauth-resolver: failed to persist refreshed token', {
            provider: oauth.provider,
            workspaceId,
            error: (persistErr as Error).message,
          })
        }
        token = {
          ...token,
          accessToken: refreshed.accessToken,
          refreshToken: newRefresh,
          expiresAt: refreshed.expiresAt,
        }
        log().info('oauth-resolver: refreshed token', {
          provider: oauth.provider,
          workspaceId,
          rotated: !!refreshed.refreshToken,
        })
      } catch (e) {
        log().warn('oauth-resolver: refresh failed', {
          provider: oauth.provider,
          workspaceId,
          code: e instanceof GoogleRefreshError ? e.code : 'unknown',
        })
        return { ok: false, reason: 'refresh_failed', detail: (e as Error).message }
      }
    }

    // Map token fields to env vars.
    const env: Record<string, string> = {}
    for (const [envKey, fieldKey] of Object.entries(oauth.envMap)) {
      let value: string | undefined
      switch (fieldKey) {
        case 'access_token':
          value = token.accessToken
          break
        case 'refresh_token':
          value = token.refreshToken
          break
        case 'expires_at':
          value = token.expiresAt?.toISOString()
          break
        case 'account_label':
          value = token.accountLabel
          break
      }
      if (value !== undefined) env[envKey] = value
    }
    return { ok: true, env }
  }
}
