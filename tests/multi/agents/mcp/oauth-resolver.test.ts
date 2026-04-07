import { describe, it, expect, vi } from 'vitest'
import { OAuthResolver } from '../../../../src/multi/agents/mcp/oauth-resolver.js'
import type { BuiltinMcpOAuth } from '../../../../src/multi/agents/mcp/builtin.js'
import { GoogleRefreshError } from '../../../../src/multi/oauth/google-refresh.js'
import type { OAuthRepo, OAuthTokenRecord } from '../../../../src/multi/oauth/repo.js'

function mkToken(overrides: Partial<OAuthTokenRecord> = {}): OAuthTokenRecord {
  const now = new Date()
  return {
    id: 'tok-1',
    workspaceId: 'ws-1',
    provider: 'google',
    scopes: ['s1'],
    accessToken: 'AT-old',
    refreshToken: 'RT-old',
    expiresAt: new Date(Date.now() + 3600_000),
    accountLabel: undefined,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function mkRepo(overrides: Partial<OAuthRepo> = {}): OAuthRepo {
  return {
    getToken: vi.fn(async () => null),
    upsertToken: vi.fn(async () => 'id'),
    listTokens: vi.fn(async () => []),
    deleteToken: vi.fn(async () => true),
    ...overrides,
  } as unknown as OAuthRepo
}

const GOOGLE_OAUTH: BuiltinMcpOAuth = {
  provider: 'google',
  scopes: ['s1'],
  envMap: {
    ACCESS: 'access_token',
    REFRESH: 'refresh_token',
  },
}

const NOTION_OAUTH: BuiltinMcpOAuth = {
  provider: 'notion',
  scopes: [],
  envMap: { NOTION_API_KEY: 'access_token' },
}

describe('OAuthResolver', () => {
  it('no_token when repo returns null', async () => {
    const repo = mkRepo({ getToken: vi.fn(async () => null) } as any)
    const r = new OAuthResolver({ oauthRepo: repo })
    const res = await r.resolve({ workspaceId: 'ws-1', oauth: GOOGLE_OAUTH })
    expect(res).toEqual({ ok: false, reason: 'no_token' })
  })

  it('notion happy path without expiresAt maps access_token to NOTION_API_KEY', async () => {
    const tok = mkToken({ provider: 'notion', accessToken: 'NK', refreshToken: undefined, expiresAt: undefined })
    const repo = mkRepo({ getToken: vi.fn(async () => tok) } as any)
    const r = new OAuthResolver({ oauthRepo: repo })
    const res = await r.resolve({ workspaceId: 'ws-1', oauth: NOTION_OAUTH })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.env).toEqual({ NOTION_API_KEY: 'NK' })
  })

  it('google valid token: does not refresh, maps access+refresh', async () => {
    const tok = mkToken()
    const repo = mkRepo({ getToken: vi.fn(async () => tok) } as any)
    const refreshImpl = vi.fn()
    const r = new OAuthResolver({ oauthRepo: repo, refreshGoogleImpl: refreshImpl as any })
    const res = await r.resolve({ workspaceId: 'ws-1', oauth: GOOGLE_OAUTH })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.env).toEqual({ ACCESS: 'AT-old', REFRESH: 'RT-old' })
    expect(refreshImpl).not.toHaveBeenCalled()
  })

  it('google expired token: refreshes and maps new access', async () => {
    const tok = mkToken({ expiresAt: new Date(Date.now() - 1000) })
    const repo = mkRepo({ getToken: vi.fn(async () => tok) } as any)
    const refreshImpl = vi.fn(async () => ({
      accessToken: 'AT-new',
      expiresAt: new Date(Date.now() + 3600_000),
    }))
    const r = new OAuthResolver({ oauthRepo: repo, refreshGoogleImpl: refreshImpl as any })
    const res = await r.resolve({ workspaceId: 'ws-1', oauth: GOOGLE_OAUTH })
    expect(refreshImpl).toHaveBeenCalledOnce()
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.env.ACCESS).toBe('AT-new')
  })

  it('google near-expiry within skew: triggers refresh', async () => {
    const tok = mkToken({ expiresAt: new Date(Date.now() + 10_000) }) // 10s left, skew 60s
    const repo = mkRepo({ getToken: vi.fn(async () => tok) } as any)
    const refreshImpl = vi.fn(async () => ({
      accessToken: 'AT-fresh',
      expiresAt: new Date(Date.now() + 3600_000),
    }))
    const r = new OAuthResolver({ oauthRepo: repo, refreshGoogleImpl: refreshImpl as any })
    const res = await r.resolve({ workspaceId: 'ws-1', oauth: GOOGLE_OAUTH })
    expect(refreshImpl).toHaveBeenCalled()
    if (res.ok) expect(res.env.ACCESS).toBe('AT-fresh')
  })

  it('google expired without refresh_token: expired_no_refresh', async () => {
    const tok = mkToken({ expiresAt: new Date(Date.now() - 1000), refreshToken: undefined })
    const repo = mkRepo({ getToken: vi.fn(async () => tok) } as any)
    const r = new OAuthResolver({ oauthRepo: repo })
    const res = await r.resolve({ workspaceId: 'ws-1', oauth: GOOGLE_OAUTH })
    expect(res).toEqual({ ok: false, reason: 'expired_no_refresh' })
  })

  it('notion expired: expired_no_refresh (only google can refresh)', async () => {
    const tok = mkToken({ provider: 'notion', expiresAt: new Date(Date.now() - 1000) })
    const repo = mkRepo({ getToken: vi.fn(async () => tok) } as any)
    const r = new OAuthResolver({ oauthRepo: repo })
    const res = await r.resolve({ workspaceId: 'ws-1', oauth: NOTION_OAUTH })
    expect(res).toEqual({ ok: false, reason: 'expired_no_refresh' })
  })

  it('refresh throws INVALID_GRANT: reason=refresh_failed', async () => {
    const tok = mkToken({ expiresAt: new Date(Date.now() - 1000) })
    const repo = mkRepo({ getToken: vi.fn(async () => tok) } as any)
    const refreshImpl = vi.fn(async () => {
      throw new GoogleRefreshError('bad', 'INVALID_GRANT')
    })
    const r = new OAuthResolver({ oauthRepo: repo, refreshGoogleImpl: refreshImpl as any })
    const res = await r.resolve({ workspaceId: 'ws-1', oauth: GOOGLE_OAUTH })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('refresh_failed')
  })

  it('after refresh, upsertToken called with new access token', async () => {
    const tok = mkToken({ expiresAt: new Date(Date.now() - 1000) })
    const upsert = vi.fn(async () => 'id')
    const repo = mkRepo({
      getToken: vi.fn(async () => tok),
      upsertToken: upsert,
    } as any)
    const refreshImpl = vi.fn(async () => ({
      accessToken: 'AT-new',
      expiresAt: new Date(Date.now() + 3600_000),
      refreshToken: 'RT-new',
    }))
    const r = new OAuthResolver({ oauthRepo: repo, refreshGoogleImpl: refreshImpl as any })
    await r.resolve({ workspaceId: 'ws-1', oauth: GOOGLE_OAUTH })
    expect(upsert).toHaveBeenCalledOnce()
    expect(upsert.mock.calls[0][1]).toMatchObject({
      provider: 'google',
      accessToken: 'AT-new',
      refreshToken: 'RT-new',
    })
  })

  it('account_label envMap: absent label → env var not set', async () => {
    const tok = mkToken({
      provider: 'notion',
      accessToken: 'NK',
      expiresAt: undefined,
      accountLabel: undefined,
    })
    const repo = mkRepo({ getToken: vi.fn(async () => tok) } as any)
    const oauth: BuiltinMcpOAuth = {
      provider: 'notion',
      scopes: [],
      envMap: { NOTION_API_KEY: 'access_token', ACCOUNT: 'account_label' },
    }
    const r = new OAuthResolver({ oauthRepo: repo })
    const res = await r.resolve({ workspaceId: 'ws-1', oauth })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.env).toEqual({ NOTION_API_KEY: 'NK' })
      expect('ACCOUNT' in res.env).toBe(false)
    }
  })

  it('account_label envMap: present label → env var set', async () => {
    const tok = mkToken({
      provider: 'notion',
      accessToken: 'NK',
      expiresAt: undefined,
      accountLabel: 'work',
    })
    const repo = mkRepo({ getToken: vi.fn(async () => tok) } as any)
    const oauth: BuiltinMcpOAuth = {
      provider: 'notion',
      scopes: [],
      envMap: { NOTION_API_KEY: 'access_token', ACCOUNT: 'account_label' },
    }
    const r = new OAuthResolver({ oauthRepo: repo })
    const res = await r.resolve({ workspaceId: 'ws-1', oauth, accountLabel: 'work' })
    if (res.ok) expect(res.env.ACCOUNT).toBe('work')
  })

  it('upsertToken throws: still returns ok with refreshed token (best-effort persistence)', async () => {
    const tok = mkToken({ expiresAt: new Date(Date.now() - 1000) })
    const repo = mkRepo({
      getToken: vi.fn(async () => tok),
      upsertToken: vi.fn(async () => {
        throw new Error('db down')
      }),
    } as any)
    const refreshImpl = vi.fn(async () => ({
      accessToken: 'AT-new',
      expiresAt: new Date(Date.now() + 3600_000),
    }))
    const r = new OAuthResolver({ oauthRepo: repo, refreshGoogleImpl: refreshImpl as any })
    const res = await r.resolve({ workspaceId: 'ws-1', oauth: GOOGLE_OAUTH })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.env.ACCESS).toBe('AT-new')
  })

  it('getToken throws: reason=crypto_error', async () => {
    const repo = mkRepo({
      getToken: vi.fn(async () => {
        throw new Error('decrypt fail')
      }),
    } as any)
    const r = new OAuthResolver({ oauthRepo: repo })
    const res = await r.resolve({ workspaceId: 'ws-1', oauth: GOOGLE_OAUTH })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('crypto_error')
  })
})
