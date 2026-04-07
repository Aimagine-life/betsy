import { describe, it, expect, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { postTokenToUpstream, UpstreamError } from '../../src/auth-relay/upstream-client.js'
import type { UpstreamTokenPayload } from '../../src/auth-relay/types.js'

const SECRET = 'shared-secret'
const WS = '11111111-1111-1111-1111-111111111111'

function payload(): UpstreamTokenPayload {
  return {
    workspace_id: WS,
    provider: 'google',
    access_token: 'at',
    refresh_token: 'rt',
    scopes: ['openid'],
    integration: 'gcal',
  }
}

describe('postTokenToUpstream', () => {
  it('signs the body with HMAC-SHA256 over `${ts}.${body}`', async () => {
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      const ts = init.headers['x-relay-timestamp']
      const sig = init.headers['x-relay-signature']
      const expected = createHmac('sha256', SECRET).update(`${ts}.${init.body}`).digest('hex')
      expect(sig).toBe(expected)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as any

    await postTokenToUpstream(payload(), {
      upstreamUrl: 'https://api.betsyai.io',
      secret: SECRET,
      fetchImpl,
      now: () => 1700000000000,
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.betsyai.io/oauth/token')
  })

  it('throws UpstreamError with status when upstream returns non-2xx', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    ) as any
    await expect(
      postTokenToUpstream(payload(), {
        upstreamUrl: 'https://api.betsyai.io',
        secret: SECRET,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ name: 'UpstreamError', status: 401 })
  })

  it('wraps network errors in UpstreamError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as any
    await expect(
      postTokenToUpstream(payload(), {
        upstreamUrl: 'https://api.betsyai.io',
        secret: SECRET,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(UpstreamError)
  })

  it('throws when secret is not configured', async () => {
    await expect(
      postTokenToUpstream(payload(), {
        upstreamUrl: 'https://api.betsyai.io',
        secret: '',
      }),
    ).rejects.toThrow(/secret/)
  })
})
