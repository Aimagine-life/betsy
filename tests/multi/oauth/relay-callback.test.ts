import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  createRelayCallbackHandler,
  verifyRelayHmac,
  MAX_RELAY_BODY_BYTES,
} from '../../../src/multi/oauth/relay-callback.js'
import type { OAuthRepo } from '../../../src/multi/oauth/repo.js'

const WS = '11111111-1111-1111-1111-111111111111'
const SECRET = 'test-secret'

function mkRepo() {
  return {
    upsertToken: vi.fn(async () => 'id'),
    getToken: vi.fn(async () => null),
    listTokens: vi.fn(async () => []),
    deleteToken: vi.fn(async () => true),
  } as unknown as OAuthRepo
}

function mkReq(headers: Record<string, string>, body: Buffer): any {
  const req: any = new EventEmitter()
  req.headers = headers
  req.method = 'POST'
  req.url = '/oauth/token'
  req.destroy = vi.fn()
  // emit after handler attaches listeners
  setImmediate(() => {
    req.emit('data', body)
    req.emit('end')
  })
  return req
}

function mkRes() {
  const chunks: Buffer[] = []
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    headersSent: false,
    writeHead(code: number, h: any) {
      this.statusCode = code
      this.headers = h
      this.headersSent = true
    },
    end(chunk?: any) {
      if (chunk) chunks.push(Buffer.from(chunk))
      this._done = true
    },
    _chunks: chunks,
  }
  return res
}

function sign(ts: number, rawBody: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')
}

async function runHandler(
  handlerOpts: { secret?: string; now?: () => number; repo?: OAuthRepo } = {},
  reqOpts: { headers?: Record<string, string>; body?: string } = {},
) {
  const repo = handlerOpts.repo ?? mkRepo()
  const handler = createRelayCallbackHandler({
    oauthRepo: repo,
    secret: handlerOpts.secret,
    now: handlerOpts.now,
  })
  const res = mkRes()
  const req = mkReq(reqOpts.headers ?? {}, Buffer.from(reqOpts.body ?? ''))
  await handler(req, res)
  return { res, repo }
}

describe('verifyRelayHmac', () => {
  it('rejects different-length signatures without throwing', () => {
    expect(verifyRelayHmac('body', '1000', 'abcd', 'secret', 1000)).toBe(false)
  })
})

describe('relay-callback handler', () => {
  const validBody = JSON.stringify({
    workspace_id: WS,
    provider: 'google',
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
  })

  it('503 when BC_OAUTH_RELAY_SECRET not configured', async () => {
    const { res } = await runHandler({ secret: undefined })
    expect(res.statusCode).toBe(503)
  })

  it('401 when headers missing', async () => {
    const { res } = await runHandler({ secret: SECRET }, { body: validBody })
    expect(res.statusCode).toBe(401)
  })

  it('401 when timestamp is not a number', async () => {
    const { res } = await runHandler(
      { secret: SECRET },
      {
        body: validBody,
        headers: {
          'x-relay-timestamp': 'notanumber',
          'x-relay-signature': 'deadbeef',
        },
      },
    )
    expect(res.statusCode).toBe(401)
  })

  it('401 when timestamp is outside skew (old)', async () => {
    const now = 2_000_000
    const ts = now - 1000 // 1000 sec old > 300
    const sig = sign(ts, validBody)
    const { res } = await runHandler(
      { secret: SECRET, now: () => now * 1000 },
      {
        body: validBody,
        headers: {
          'x-relay-timestamp': String(ts),
          'x-relay-signature': sig,
        },
      },
    )
    expect(res.statusCode).toBe(401)
  })

  it('401 when timestamp is far in the future', async () => {
    const now = 2_000_000
    const ts = now + 1000
    const sig = sign(ts, validBody)
    const { res } = await runHandler(
      { secret: SECRET, now: () => now * 1000 },
      {
        body: validBody,
        headers: {
          'x-relay-timestamp': String(ts),
          'x-relay-signature': sig,
        },
      },
    )
    expect(res.statusCode).toBe(401)
  })

  it('401 on forged signature', async () => {
    const now = 2_000_000
    const ts = now
    const { res } = await runHandler(
      { secret: SECRET, now: () => now * 1000 },
      {
        body: validBody,
        headers: {
          'x-relay-timestamp': String(ts),
          'x-relay-signature': 'ab'.repeat(32),
        },
      },
    )
    expect(res.statusCode).toBe(401)
  })

  it('400 on invalid JSON', async () => {
    const now = 2_000_000
    const ts = now
    const body = '{not-json'
    const sig = sign(ts, body)
    const { res } = await runHandler(
      { secret: SECRET, now: () => now * 1000 },
      {
        body,
        headers: {
          'x-relay-timestamp': String(ts),
          'x-relay-signature': sig,
        },
      },
    )
    expect(res.statusCode).toBe(400)
  })

  it('400 when workspace_id is missing', async () => {
    const now = 2_000_000
    const ts = now
    const body = JSON.stringify({ provider: 'google', access_token: 'x' })
    const sig = sign(ts, body)
    const { res } = await runHandler(
      { secret: SECRET, now: () => now * 1000 },
      {
        body,
        headers: {
          'x-relay-timestamp': String(ts),
          'x-relay-signature': sig,
        },
      },
    )
    expect(res.statusCode).toBe(400)
  })

  it('400 when workspace_id is not uuid', async () => {
    const now = 2_000_000
    const ts = now
    const body = JSON.stringify({
      workspace_id: 'not-a-uuid',
      provider: 'google',
      access_token: 'x',
    })
    const sig = sign(ts, body)
    const { res } = await runHandler(
      { secret: SECRET, now: () => now * 1000 },
      {
        body,
        headers: {
          'x-relay-timestamp': String(ts),
          'x-relay-signature': sig,
        },
      },
    )
    expect(res.statusCode).toBe(400)
  })

  it('413 on body larger than 64 KB', async () => {
    const now = 2_000_000
    const ts = now
    const huge = 'x'.repeat(MAX_RELAY_BODY_BYTES + 10)
    const sig = sign(ts, huge)
    const { res } = await runHandler(
      { secret: SECRET, now: () => now * 1000 },
      {
        body: huge,
        headers: {
          'x-relay-timestamp': String(ts),
          'x-relay-signature': sig,
        },
      },
    )
    expect(res.statusCode).toBe(413)
  })

  it('200 happy path persists token with correct args', async () => {
    const now = 2_000_000
    const ts = now
    const sig = sign(ts, validBody)
    const repo = mkRepo()
    const { res } = await runHandler(
      { secret: SECRET, now: () => now * 1000, repo },
      {
        body: validBody,
        headers: {
          'x-relay-timestamp': String(ts),
          'x-relay-signature': sig,
        },
      },
    )
    expect(res.statusCode).toBe(200)
    expect(repo.upsertToken).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({
        provider: 'google',
        accessToken: 'fake-access-1',
        refreshToken: 'fake-refresh-1',
      }),
    )
  })

  it('200 response body does NOT echo any token', async () => {
    const now = 2_000_000
    const ts = now
    const sig = sign(ts, validBody)
    const { res } = await runHandler(
      { secret: SECRET, now: () => now * 1000 },
      {
        body: validBody,
        headers: {
          'x-relay-timestamp': String(ts),
          'x-relay-signature': sig,
        },
      },
    )
    expect(res.statusCode).toBe(200)
    const body = Buffer.concat(res._chunks).toString('utf8')
    expect(body).not.toContain('fake-access-1')
    expect(body).not.toContain('fake-refresh-1')
    expect(JSON.parse(body)).toEqual({ ok: true })
  })
})
