import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  refreshGoogleToken,
  GoogleRefreshError,
} from '../../../src/multi/oauth/google-refresh.js'

function mkResponse(status: number, body: any, opts: { json?: boolean } = { json: true }): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (opts.json === false) throw new Error('not json')
      return JSON.parse(text)
    },
    async text() {
      return text
    },
  } as unknown as Response
}

const DEPS = { clientId: 'cid', clientSecret: 'csec' }

describe('refreshGoogleToken', () => {
  beforeEach(() => {
    vi.stubEnv('BC_GOOGLE_CLIENT_ID', '')
    vi.stubEnv('BC_GOOGLE_CLIENT_SECRET', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns access token and expiresAt on success', async () => {
    const fetchImpl = vi.fn(async () =>
      mkResponse(200, { access_token: 'A1', expires_in: 3600 }),
    )
    const before = Date.now()
    const res = await refreshGoogleToken('RT', { ...DEPS, fetchImpl })
    expect(res.accessToken).toBe('A1')
    expect(res.refreshToken).toBeUndefined()
    expect(res.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600_000 - 50)
    expect(res.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 3600_000 + 50)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('surfaces rotated refresh_token', async () => {
    const fetchImpl = vi.fn(async () =>
      mkResponse(200, { access_token: 'A2', expires_in: 60, refresh_token: 'RT2' }),
    )
    const res = await refreshGoogleToken('RT', { ...DEPS, fetchImpl })
    expect(res.refreshToken).toBe('RT2')
  })

  it('throws NO_CLIENT_CREDS when env/deps missing', async () => {
    await expect(refreshGoogleToken('RT')).rejects.toMatchObject({
      name: 'GoogleRefreshError',
      code: 'NO_CLIENT_CREDS',
    })
  })

  it('throws INVALID_GRANT on 400 invalid_grant', async () => {
    const fetchImpl = vi.fn(async () =>
      mkResponse(400, { error: 'invalid_grant', error_description: 'bad' }),
    )
    await expect(
      refreshGoogleToken('RT', { ...DEPS, fetchImpl }),
    ).rejects.toMatchObject({ code: 'INVALID_GRANT' })
  })

  it('throws HTTP on 500', async () => {
    const fetchImpl = vi.fn(async () => mkResponse(500, 'boom'))
    await expect(
      refreshGoogleToken('RT', { ...DEPS, fetchImpl }),
    ).rejects.toMatchObject({ code: 'HTTP' })
  })

  it('throws HTTP on network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    await expect(
      refreshGoogleToken('RT', { ...DEPS, fetchImpl: fetchImpl as any }),
    ).rejects.toMatchObject({ code: 'HTTP' })
  })

  it('throws PARSE on invalid JSON', async () => {
    const fetchImpl = vi.fn(async () => mkResponse(200, 'not-json', { json: false }))
    await expect(
      refreshGoogleToken('RT', { ...DEPS, fetchImpl }),
    ).rejects.toMatchObject({ code: 'PARSE' })
  })

  it('throws PARSE when access_token missing', async () => {
    const fetchImpl = vi.fn(async () => mkResponse(200, { expires_in: 60 }))
    await expect(
      refreshGoogleToken('RT', { ...DEPS, fetchImpl }),
    ).rejects.toMatchObject({ code: 'PARSE' })
  })

  it('GoogleRefreshError is an Error', () => {
    const e = new GoogleRefreshError('x', 'HTTP')
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('HTTP')
  })
})
