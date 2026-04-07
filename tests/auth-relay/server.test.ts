import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  routeRequest,
  type ServerDeps,
  type Logger,
  type ExchangeFn,
} from '../../src/auth-relay/server.js'
import { StateStore } from '../../src/auth-relay/state-store.js'
import { RateLimiter } from '../../src/auth-relay/rate-limit.js'
import type { ProviderConfig, UpstreamTokenPayload } from '../../src/auth-relay/types.js'
import type { RelayConfig } from '../../src/auth-relay/config.js'

const WS = '11111111-1111-1111-1111-111111111111'

const google: ProviderConfig = {
  id: 'google',
  name: 'Google',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  clientId: 'cid',
  clientSecret: 'csecret',
  defaultScopes: ['openid', 'email'],
}

function mkConfig(): RelayConfig {
  return {
    port: 3787,
    publicUrl: 'https://auth.betsyai.io',
    upstreamUrl: 'https://api.betsyai.io',
    upstreamSecret: 'hmac-secret',
    allowedReturnTo: ['https://app.betsyai.io', 'https://dash.betsyai.io'],
  }
}

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

function mkDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    config: mkConfig(),
    providers: { google },
    stateStore: new StateStore(),
    rateLimiter: new RateLimiter({ maxRequests: 100, windowMs: 10 * 60 * 1000 }),
    logger: silentLogger,
    ...overrides,
  }
}

interface MockRes {
  statusCode: number
  headers: Record<string, any>
  body: string
  headersSent: boolean
  writeHead(status: number, headers?: Record<string, any>): MockRes
  end(body?: string): void
}

function mkReq(url: string, ip = '1.2.3.4'): any {
  const req: any = new EventEmitter()
  req.method = 'GET'
  req.url = url
  req.headers = { 'x-forwarded-for': ip }
  req.socket = { remoteAddress: ip }
  return req
}

function mkRes(): MockRes {
  const res: any = {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status: number, headers: Record<string, any> = {}) {
      res.statusCode = status
      res.headers = { ...res.headers, ...headers }
      res.headersSent = true
      return res
    },
    end(body?: string) {
      if (body) res.body += body
    },
  }
  return res as MockRes
}

async function call(deps: ServerDeps, url: string, ip?: string): Promise<MockRes> {
  const req = mkReq(url, ip)
  const res = mkRes()
  await routeRequest(req, res as any, deps)
  return res
}

describe('auth-relay server', () => {
  it('GET /healthz returns 200 with provider list', async () => {
    const res = await call(mkDeps(), '/healthz')
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.providers).toEqual(['google'])
  })

  it('GET /start without provider → 400', async () => {
    const res = await call(mkDeps(), '/start')
    expect(res.statusCode).toBe(400)
  })

  it('GET /start with unknown provider → 400', async () => {
    const res = await call(
      mkDeps(),
      `/start?provider=facebook&workspace_id=${WS}&integration=x&return_to=https://app.betsyai.io/i`,
    )
    expect(res.statusCode).toBe(400)
  })

  it('GET /start with non-uuid workspace_id → 400', async () => {
    const res = await call(
      mkDeps(),
      `/start?provider=google&workspace_id=notauuid&integration=gcal&return_to=https://app.betsyai.io/i`,
    )
    expect(res.statusCode).toBe(400)
  })

  it('GET /start with return_to outside allowlist → 400', async () => {
    const res = await call(
      mkDeps(),
      `/start?provider=google&workspace_id=${WS}&integration=gcal&return_to=https://evil.example.com/x`,
    )
    expect(res.statusCode).toBe(400)
  })

  it('GET /start rejects javascript: return_to', async () => {
    const res = await call(
      mkDeps(),
      `/start?provider=google&workspace_id=${WS}&integration=gcal&return_to=javascript:alert(1)`,
    )
    expect(res.statusCode).toBe(400)
  })

  it('GET /start happy path → 302 with correct authorize URL', async () => {
    const deps = mkDeps()
    const res = await call(
      deps,
      `/start?provider=google&workspace_id=${WS}&integration=gcal&scopes=openid%20email&return_to=https://app.betsyai.io/ok`,
    )
    expect(res.statusCode).toBe(302)
    const loc = new URL(res.headers.location)
    expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(loc.searchParams.get('client_id')).toBe('cid')
    expect(loc.searchParams.get('redirect_uri')).toBe('https://auth.betsyai.io/callback')
    expect(loc.searchParams.get('response_type')).toBe('code')
    expect(loc.searchParams.get('scope')).toBe('openid email')
    expect(loc.searchParams.get('access_type')).toBe('offline')
    expect(loc.searchParams.get('prompt')).toBe('consent')
    const state = loc.searchParams.get('state')
    expect(state).toBeTruthy()
    expect(deps.stateStore.size()).toBe(1)
  })

  it('GET /callback without state → 400', async () => {
    const res = await call(mkDeps(), '/callback?code=abc')
    expect(res.statusCode).toBe(400)
  })

  it('GET /callback with unknown state → 400', async () => {
    const res = await call(mkDeps(), '/callback?code=abc&state=deadbeef')
    expect(res.statusCode).toBe(400)
  })

  it('GET /callback happy path: exchanges code, posts upstream, redirects ?status=ok', async () => {
    const exchange: ExchangeFn = vi.fn(async () => ({
      access_token: 'at-google',
      refresh_token: 'rt-google',
      expires_in: 3600,
      scope: 'openid email',
    }))
    const upstreamPost = vi.fn(async (_p: UpstreamTokenPayload) => {})
    const deps = mkDeps({ exchange, upstreamPost })

    // First call /start to seed the state store
    const startRes = await call(
      deps,
      `/start?provider=google&workspace_id=${WS}&integration=gcal&return_to=https://app.betsyai.io/done`,
    )
    const loc = new URL(startRes.headers.location)
    const nonce = loc.searchParams.get('state')!

    const cbRes = await call(deps, `/callback?code=authcode123&state=${nonce}`)
    expect(cbRes.statusCode).toBe(302)
    const returnLoc = new URL(cbRes.headers.location)
    expect(returnLoc.origin + returnLoc.pathname).toBe('https://app.betsyai.io/done')
    expect(returnLoc.searchParams.get('status')).toBe('ok')

    expect(exchange).toHaveBeenCalledOnce()
    expect(upstreamPost).toHaveBeenCalledOnce()
    const payload = (upstreamPost as any).mock.calls[0][0] as UpstreamTokenPayload
    expect(payload.workspace_id).toBe(WS)
    expect(payload.provider).toBe('google')
    expect(payload.access_token).toBe('at-google')
    expect(payload.refresh_token).toBe('rt-google')
    expect(payload.integration).toBe('gcal')
    expect(payload.expires_at).toBeTruthy()
  })

  it('GET /callback: second use of same state → 400 (code replay blocked)', async () => {
    const exchange: ExchangeFn = vi.fn(async () => ({ access_token: 'at' }))
    const upstreamPost = vi.fn(async () => {})
    const deps = mkDeps({ exchange, upstreamPost })
    const startRes = await call(
      deps,
      `/start?provider=google&workspace_id=${WS}&integration=gcal&return_to=https://app.betsyai.io/done`,
    )
    const nonce = new URL(startRes.headers.location).searchParams.get('state')!
    await call(deps, `/callback?code=code1&state=${nonce}`)
    const second = await call(deps, `/callback?code=code1&state=${nonce}`)
    expect(second.statusCode).toBe(400)
  })

  it('GET /callback: exchange throws → redirect with status=error', async () => {
    const exchange: ExchangeFn = vi.fn(async () => {
      throw new Error('invalid_grant')
    })
    const upstreamPost = vi.fn(async () => {})
    const deps = mkDeps({ exchange, upstreamPost })
    const startRes = await call(
      deps,
      `/start?provider=google&workspace_id=${WS}&integration=gcal&return_to=https://app.betsyai.io/done`,
    )
    const nonce = new URL(startRes.headers.location).searchParams.get('state')!
    const cb = await call(deps, `/callback?code=xyz&state=${nonce}`)
    expect(cb.statusCode).toBe(302)
    const u = new URL(cb.headers.location)
    expect(u.searchParams.get('status')).toBe('error')
    expect(u.searchParams.get('error')).toBe('exchange_failed')
    expect(upstreamPost).not.toHaveBeenCalled()
  })

  it('GET /callback: upstream 401 → redirect error, not ok', async () => {
    const exchange: ExchangeFn = vi.fn(async () => ({ access_token: 'at' }))
    const upstreamPost = vi.fn(async () => {
      const e: any = new Error('upstream returned 401')
      e.name = 'UpstreamError'
      e.status = 401
      throw e
    })
    const deps = mkDeps({ exchange, upstreamPost })
    const startRes = await call(
      deps,
      `/start?provider=google&workspace_id=${WS}&integration=gcal&return_to=https://app.betsyai.io/done`,
    )
    const nonce = new URL(startRes.headers.location).searchParams.get('state')!
    const cb = await call(deps, `/callback?code=abc&state=${nonce}`)
    const u = new URL(cb.headers.location)
    expect(u.searchParams.get('status')).toBe('error')
    expect(u.searchParams.get('error')).toBe('upstream_failed')
  })

  it('GET /callback: very long code is rejected', async () => {
    const deps = mkDeps({ exchange: vi.fn() as any })
    const startRes = await call(
      deps,
      `/start?provider=google&workspace_id=${WS}&integration=gcal&return_to=https://app.betsyai.io/done`,
    )
    const nonce = new URL(startRes.headers.location).searchParams.get('state')!
    const longCode = 'A'.repeat(5000)
    const cb = await call(deps, `/callback?code=${longCode}&state=${nonce}`)
    const u = new URL(cb.headers.location)
    expect(u.searchParams.get('status')).toBe('error')
  })

  it('rate limit: 101st /start from same IP → 429', async () => {
    const deps = mkDeps({
      rateLimiter: new RateLimiter({ maxRequests: 3, windowMs: 60_000 }),
    })
    const url = `/start?provider=google&workspace_id=${WS}&integration=gcal&return_to=https://app.betsyai.io/x`
    for (let i = 0; i < 3; i++) {
      const r = await call(deps, url, '9.9.9.9')
      expect(r.statusCode).toBe(302)
    }
    const limited = await call(deps, url, '9.9.9.9')
    expect(limited.statusCode).toBe(429)
  })

  it('rate limit resets after window', async () => {
    let t = 1000
    const deps = mkDeps({
      rateLimiter: new RateLimiter({ maxRequests: 1, windowMs: 500, now: () => t }),
    })
    const url = `/start?provider=google&workspace_id=${WS}&integration=gcal&return_to=https://app.betsyai.io/x`
    expect((await call(deps, url, '2.2.2.2')).statusCode).toBe(302)
    expect((await call(deps, url, '2.2.2.2')).statusCode).toBe(429)
    t = 2000
    expect((await call(deps, url, '2.2.2.2')).statusCode).toBe(302)
  })

  it('unknown path → 404', async () => {
    const res = await call(mkDeps(), '/whatever')
    expect(res.statusCode).toBe(404)
  })

  it('GET /callback: expired state → 400', async () => {
    let t = 0
    const deps = mkDeps({ stateStore: new StateStore({ ttlMs: 100, now: () => t }) })
    const startRes = await call(
      deps,
      `/start?provider=google&workspace_id=${WS}&integration=gcal&return_to=https://app.betsyai.io/done`,
    )
    const nonce = new URL(startRes.headers.location).searchParams.get('state')!
    t = 1000
    const cb = await call(deps, `/callback?code=abc&state=${nonce}`)
    expect(cb.statusCode).toBe(400)
  })
})
