/**
 * End-to-end simulation of the auth-relay. Starts:
 *  1) A fake upstream HTTP server that verifies the HMAC signature.
 *  2) The auth-relay itself, wired to a mocked code exchange (so no
 *     network call to Google is needed).
 *
 * Then drives a full flow:
 *  - GET /healthz
 *  - GET /start → follows the redirect and pretends to be Google
 *  - GET /callback → triggers exchange + upstream POST
 *
 * Exits 0 on success, non-zero on any assertion failure.
 *
 * Run: `npx tsx src/auth-relay/sim.ts`
 */
import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { URL } from 'node:url'
import { StateStore } from './state-store.js'
import { RateLimiter } from './rate-limit.js'
import { startServer, type ServerDeps, type ExchangeFn } from './server.js'
import type { ProviderConfig, UpstreamTokenPayload } from './types.js'
import type { RelayConfig } from './config.js'
import { postTokenToUpstream } from './upstream-client.js'

const WS = '22222222-2222-2222-2222-222222222222'
const SECRET = 'sim-hmac-secret'

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`[sim] FAIL: ${msg}`)
    process.exit(1)
  }
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, () => {
      const addr = s.address()
      if (typeof addr === 'object' && addr) {
        const p = addr.port
        s.close(() => resolve(p))
      } else {
        s.close(() => reject(new Error('no address')))
      }
    })
  })
}

async function main() {
  // 1. Fake upstream server
  let upstreamCalled = 0
  let upstreamOk = false
  const upstreamPort = await pickPort()
  const upstream = createServer(async (req, res) => {
    if (req.url === '/oauth/token' && req.method === 'POST') {
      upstreamCalled++
      const raw = await readBody(req)
      const ts = String(req.headers['x-relay-timestamp'] ?? '')
      const sig = String(req.headers['x-relay-signature'] ?? '')
      const expected = createHmac('sha256', SECRET).update(`${ts}.${raw}`).digest('hex')
      const a = Buffer.from(expected, 'hex')
      const b = Buffer.from(sig, 'hex')
      if (a.length === b.length && timingSafeEqual(a, b)) {
        const body = JSON.parse(raw) as UpstreamTokenPayload
        if (body.workspace_id === WS && body.access_token === 'sim-at') {
          upstreamOk = true
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"ok":true}')
          return
        }
      }
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"unauthorized"}')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => upstream.listen(upstreamPort, r))

  // 2. Start auth-relay with mocked exchange
  const relayPort = await pickPort()
  const config: RelayConfig = {
    port: relayPort,
    publicUrl: `http://127.0.0.1:${relayPort}`,
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    upstreamSecret: SECRET,
    allowedReturnTo: ['http://127.0.0.1:9999'],
  }
  const provider: ProviderConfig = {
    id: 'google',
    name: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: 'sim-cid',
    clientSecret: 'sim-secret',
    defaultScopes: ['openid', 'email'],
  }
  const exchange: ExchangeFn = async () => ({
    access_token: 'sim-at',
    refresh_token: 'sim-rt',
    expires_in: 3600,
    scope: 'openid email',
  })

  const deps: ServerDeps = {
    config,
    providers: { google: provider },
    stateStore: new StateStore(),
    rateLimiter: new RateLimiter({ maxRequests: 100, windowMs: 60_000 }),
    exchange,
    upstreamPost: (p) =>
      postTokenToUpstream(p, {
        upstreamUrl: config.upstreamUrl,
        secret: config.upstreamSecret,
      }),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  const relayServer = startServer(deps)
  await new Promise<void>((r) => setTimeout(r, 50))

  // 3. GET /healthz
  const hz = await fetch(`${config.publicUrl}/healthz`)
  assert(hz.status === 200, `healthz status ${hz.status}`)
  const hzBody = await hz.json() as any
  assert(hzBody.ok === true, 'healthz ok')
  assert(Array.isArray(hzBody.providers) && hzBody.providers.includes('google'), 'healthz providers')

  // 4. GET /start → expect 302 redirect to google authorize URL
  const startUrl =
    `${config.publicUrl}/start?provider=google&workspace_id=${WS}` +
    `&integration=gcal&scopes=openid%20email&return_to=${encodeURIComponent('http://127.0.0.1:9999/done')}`
  const startRes = await fetch(startUrl, { redirect: 'manual' })
  assert(startRes.status === 302, `start status ${startRes.status}`)
  const authLoc = startRes.headers.get('location')!
  assert(!!authLoc, 'start location header')
  const authU = new URL(authLoc)
  assert(authU.hostname === 'accounts.google.com', `authorize host: ${authU.hostname}`)
  const nonce = authU.searchParams.get('state')!
  assert(!!nonce && nonce.length >= 16, 'state nonce')
  assert(authU.searchParams.get('client_id') === 'sim-cid', 'client_id')
  assert(authU.searchParams.get('redirect_uri') === `${config.publicUrl}/callback`, 'redirect_uri')

  // 5. GET /callback → simulate Google redirecting back
  const cbUrl = `${config.publicUrl}/callback?code=sim-code&state=${nonce}`
  const cbRes = await fetch(cbUrl, { redirect: 'manual' })
  assert(cbRes.status === 302, `callback status ${cbRes.status}`)
  const retLoc = cbRes.headers.get('location')!
  const retU = new URL(retLoc)
  assert(retU.hostname === '127.0.0.1' && retU.pathname === '/done', `return_to host: ${retU.hostname}${retU.pathname}`)
  assert(retU.searchParams.get('status') === 'ok', `status=${retU.searchParams.get('status')}`)

  assert(upstreamCalled === 1, `upstream called ${upstreamCalled} times`)
  assert(upstreamOk, 'upstream HMAC + payload correct')

  // 6. Double-callback must fail
  const cb2 = await fetch(cbUrl, { redirect: 'manual' })
  assert(cb2.status === 400, `double callback status ${cb2.status}`)

  // Cleanup
  relayServer.close()
  upstream.close()
  console.log('[sim] OK — full auth-relay flow verified end-to-end')
}

main().catch((e) => {
  console.error(`[sim] crashed: ${(e as Error).stack ?? (e as Error).message}`)
  process.exit(1)
})
