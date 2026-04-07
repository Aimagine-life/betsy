import { describe, it, expect, vi } from 'vitest'
import { exchangeGoogleCode } from '../../src/auth-relay/google-exchange.js'
import type { ProviderConfig } from '../../src/auth-relay/types.js'

const provider: ProviderConfig = {
  id: 'google',
  name: 'Google',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  clientId: 'cid',
  clientSecret: 'csecret',
  defaultScopes: ['openid'],
}

describe('exchangeGoogleCode', () => {
  it('returns parsed fields on success', async () => {
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      const body = String(init.body)
      expect(body).toContain('grant_type=authorization_code')
      expect(body).toContain('code=abc')
      expect(body).toContain('client_id=cid')
      return new Response(
        JSON.stringify({
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          scope: 'openid email',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as any

    const r = await exchangeGoogleCode('abc', 'https://auth/callback', provider, { fetchImpl })
    expect(r.access_token).toBe('at')
    expect(r.refresh_token).toBe('rt')
    expect(r.expires_in).toBe(3600)
    expect(r.scope).toBe('openid email')
  })

  it('throws with status when token endpoint returns 400', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    ) as any
    await expect(
      exchangeGoogleCode('bad', 'https://auth/callback', provider, { fetchImpl }),
    ).rejects.toThrow(/400/)
  })

  it('wraps network errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND')
    }) as any
    await expect(
      exchangeGoogleCode('abc', 'https://auth/callback', provider, { fetchImpl }),
    ).rejects.toThrow(/network/)
  })

  it('throws if access_token is missing', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ refresh_token: 'rt' }), { status: 200 }),
    ) as any
    await expect(
      exchangeGoogleCode('abc', 'https://auth/callback', provider, { fetchImpl }),
    ).rejects.toThrow(/access_token/)
  })
})
