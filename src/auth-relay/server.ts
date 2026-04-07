/**
 * Standalone auth-relay HTTP server.
 *
 * This is a SEPARATE binary — it does not share a process or a database
 * with the multi-server. It runs on auth.betsyai.io, performs the
 * interactive OAuth consent flow with providers (Google, Notion), then
 * POSTs the resulting tokens to the multi-server via an HMAC-signed
 * request.
 *
 * Entrypoint: `tsx src/auth-relay/server.ts` (dev) or
 * `node dist/auth-relay/server.cjs` (prod after tsup build).
 *
 * SECURITY NOTES
 *  - `state` param protects against CSRF on /callback.
 *  - `return_to` is validated against an operator-provided allowlist to
 *    block open-redirect abuse (javascript:, data:, etc).
 *  - Tokens and authorization codes are NEVER logged.
 *  - Per-IP rate limit on /start blocks trivial abusers.
 *  - HTTPS is enforced only via publicUrl — TLS termination lives upstream
 *    in nginx/caddy in the real deployment.
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { URL } from 'node:url'
import type { ProviderConfig, ProviderId, UpstreamTokenPayload, ExchangeResult } from './types.js'
import { loadProviders, isKnownProvider } from './providers.js'
import { StateStore } from './state-store.js'
import { RateLimiter } from './rate-limit.js'
import { exchangeGoogleCode } from './google-exchange.js'
import { exchangeNotionCode } from './notion-exchange.js'
import { postTokenToUpstream, UpstreamError } from './upstream-client.js'
import { isAllowedReturnTo, loadRelayConfig, type RelayConfig } from './config.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ExchangeFn = (
  provider: ProviderConfig,
  code: string,
  redirectUri: string,
) => Promise<ExchangeResult>

export interface ServerDeps {
  config: RelayConfig
  providers: Record<string, ProviderConfig>
  stateStore: StateStore
  rateLimiter: RateLimiter
  exchange?: ExchangeFn
  upstreamPost?: (payload: UpstreamTokenPayload) => Promise<void>
  /** Simple structured logger; defaults to safe console-based impl. */
  logger?: Logger
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

const defaultLogger: Logger = {
  info: (e, f) => console.log(JSON.stringify({ level: 'info', event: e, ...f })),
  warn: (e, f) => console.warn(JSON.stringify({ level: 'warn', event: e, ...f })),
  error: (e, f) => console.error(JSON.stringify({ level: 'error', event: e, ...f })),
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location })
  res.end()
}

function getClientIp(req: IncomingMessage): string {
  const xf = req.headers['x-forwarded-for']
  if (typeof xf === 'string' && xf.length > 0) return xf.split(',')[0]!.trim()
  return req.socket.remoteAddress ?? 'unknown'
}

function redirectWithStatus(
  res: ServerResponse,
  returnTo: string,
  status: 'ok' | 'error',
  errorCode?: string,
): void {
  try {
    const u = new URL(returnTo)
    u.searchParams.set('status', status)
    if (errorCode) u.searchParams.set('error', errorCode)
    redirect(res, u.toString())
  } catch {
    sendText(res, status === 'ok' ? 200 : 400, status)
  }
}

function defaultExchange(
  provider: ProviderConfig,
  code: string,
  redirectUri: string,
): Promise<ExchangeResult> {
  if (provider.id === 'google') return exchangeGoogleCode(code, redirectUri, provider)
  if (provider.id === 'notion') return exchangeNotionCode(code, redirectUri, provider)
  return Promise.reject(new Error(`no exchange for provider ${provider.id}`))
}

// ---------- handlers ---------------------------------------------------

export async function handleHealthz(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  sendJson(res, 200, {
    ok: true,
    providers: Object.keys(deps.providers).sort(),
  })
}

export async function handleStart(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const logger = deps.logger ?? defaultLogger
  const ip = getClientIp(req)
  if (!deps.rateLimiter.check(ip)) {
    logger.warn('auth_relay.start.rate_limited', { ip })
    return sendText(res, 429, 'rate limited')
  }

  let url: URL
  try {
    url = new URL(req.url ?? '/', deps.config.publicUrl)
  } catch {
    return sendText(res, 400, 'bad url')
  }
  const q = url.searchParams
  const providerId = q.get('provider') ?? ''
  const workspaceId = q.get('workspace_id') ?? ''
  const integration = q.get('integration') ?? ''
  const scopesRaw = q.get('scopes') ?? ''
  const returnTo = q.get('return_to') ?? ''

  if (!isKnownProvider(providerId)) {
    return sendText(res, 400, 'unknown provider')
  }
  const provider = deps.providers[providerId]
  if (!provider) {
    return sendText(res, 400, 'provider not configured')
  }
  if (!UUID_RE.test(workspaceId)) {
    return sendText(res, 400, 'bad workspace_id')
  }
  if (!integration || integration.length > 64 || !/^[a-z0-9._-]+$/i.test(integration)) {
    return sendText(res, 400, 'bad integration')
  }
  if (!isAllowedReturnTo(returnTo, deps.config.allowedReturnTo)) {
    return sendText(res, 400, 'return_to not allowed')
  }

  const scopes = scopesRaw.length > 0
    ? scopesRaw.split(/[\s,]+/).filter((s) => s.length > 0)
    : [...provider.defaultScopes]

  const nonce = deps.stateStore.put({
    provider: providerId as ProviderId,
    workspaceId,
    integration,
    scopes,
    returnTo,
  })

  const redirectUri = `${deps.config.publicUrl}/callback`

  const authorize = new URL(provider.authorizeUrl)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('client_id', provider.clientId)
  authorize.searchParams.set('redirect_uri', redirectUri)
  authorize.searchParams.set('state', nonce)
  if (scopes.length > 0) authorize.searchParams.set('scope', scopes.join(' '))
  if (provider.id === 'google') {
    authorize.searchParams.set('access_type', 'offline')
    authorize.searchParams.set('prompt', 'consent')
    authorize.searchParams.set('include_granted_scopes', 'true')
  } else if (provider.id === 'notion') {
    authorize.searchParams.set('owner', 'user')
  }

  logger.info('auth_relay.start', {
    provider: providerId,
    workspaceId,
    integration,
    noncePrefix: nonce.slice(0, 6),
  })
  return redirect(res, authorize.toString())
}

export async function handleCallback(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const logger = deps.logger ?? defaultLogger
  let url: URL
  try {
    url = new URL(req.url ?? '/', deps.config.publicUrl)
  } catch {
    return sendText(res, 400, 'bad url')
  }
  const q = url.searchParams
  const code = q.get('code') ?? ''
  const nonce = q.get('state') ?? ''
  const providerError = q.get('error')

  if (!nonce) {
    return sendText(res, 400, 'missing state')
  }
  const state = deps.stateStore.take(nonce)
  if (!state) {
    logger.warn('auth_relay.callback.state_missing_or_expired', {
      noncePrefix: nonce.slice(0, 6),
    })
    return sendText(res, 400, 'invalid or expired state')
  }

  if (providerError) {
    logger.warn('auth_relay.callback.provider_error', {
      provider: state.provider,
      providerError,
    })
    return redirectWithStatus(res, state.returnTo, 'error', 'provider_denied')
  }

  if (!code || code.length === 0) {
    logger.warn('auth_relay.callback.missing_code', { provider: state.provider })
    return redirectWithStatus(res, state.returnTo, 'error', 'missing_code')
  }
  // Protect log lines — codes can be absurdly long; also never log them.
  if (code.length > 4096) {
    logger.warn('auth_relay.callback.code_too_long', { provider: state.provider })
    return redirectWithStatus(res, state.returnTo, 'error', 'bad_code')
  }

  const provider = deps.providers[state.provider]
  if (!provider) {
    logger.error('auth_relay.callback.provider_vanished', { provider: state.provider })
    return redirectWithStatus(res, state.returnTo, 'error', 'provider_missing')
  }

  const redirectUri = `${deps.config.publicUrl}/callback`
  const exchange = deps.exchange ?? defaultExchange

  let result: ExchangeResult
  try {
    result = await exchange(provider, code, redirectUri)
  } catch (e) {
    logger.error('auth_relay.callback.exchange_failed', {
      provider: state.provider,
      error: (e as Error).message,
    })
    return redirectWithStatus(res, state.returnTo, 'error', 'exchange_failed')
  }

  const expiresAt = result.expires_in
    ? new Date(Date.now() + result.expires_in * 1000).toISOString()
    : undefined

  const payload: UpstreamTokenPayload = {
    workspace_id: state.workspaceId,
    provider: state.provider,
    access_token: result.access_token,
    refresh_token: result.refresh_token,
    expires_at: expiresAt,
    scopes: result.scope ? result.scope.split(/\s+/) : state.scopes,
    integration: state.integration,
    metadata: result.raw,
  }

  const poster = deps.upstreamPost ??
    ((p: UpstreamTokenPayload) =>
      postTokenToUpstream(p, {
        upstreamUrl: deps.config.upstreamUrl,
        secret: deps.config.upstreamSecret,
      }))

  try {
    await poster(payload)
  } catch (e) {
    const status = e instanceof UpstreamError ? e.status : undefined
    logger.error('auth_relay.callback.upstream_failed', {
      provider: state.provider,
      workspaceId: state.workspaceId,
      status,
      error: (e as Error).message,
    })
    return redirectWithStatus(res, state.returnTo, 'error', 'upstream_failed')
  }

  logger.info('auth_relay.callback.ok', {
    provider: state.provider,
    workspaceId: state.workspaceId,
    integration: state.integration,
    hasRefresh: !!result.refresh_token,
  })
  return redirectWithStatus(res, state.returnTo, 'ok')
}

// ---------- router -----------------------------------------------------

export async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const method = req.method ?? 'GET'
  const path = (req.url ?? '/').split('?')[0] ?? '/'

  if (method === 'GET' && path === '/healthz') return handleHealthz(req, res, deps)
  if (method === 'GET' && path === '/start') return handleStart(req, res, deps)
  if (method === 'GET' && path === '/callback') return handleCallback(req, res, deps)
  return sendText(res, 404, 'not found')
}

// ---------- bootstrap --------------------------------------------------

export function createServerDeps(configOverride?: Partial<RelayConfig>): ServerDeps {
  const config = { ...loadRelayConfig(), ...configOverride } as RelayConfig
  const providers = loadProviders()
  if (Object.keys(providers).length === 0) {
    throw new Error('no OAuth providers configured (set BC_GOOGLE_CLIENT_ID or BC_NOTION_CLIENT_ID)')
  }
  return {
    config,
    providers,
    stateStore: new StateStore(),
    rateLimiter: new RateLimiter({ maxRequests: 100, windowMs: 10 * 60 * 1000 }),
  }
}

export function startServer(deps: ServerDeps): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    routeRequest(req, res, deps).catch((e) => {
      ;(deps.logger ?? defaultLogger).error('auth_relay.unhandled', { error: (e as Error).message })
      if (!res.headersSent) sendText(res, 500, 'internal error')
    })
  })
  server.listen(deps.config.port, () => {
    const logger = deps.logger ?? defaultLogger
    logger.info('auth_relay.listening', {
      port: deps.config.port,
      publicUrl: deps.config.publicUrl,
      providers: Object.keys(deps.providers).sort(),
    })
    if (!deps.config.publicUrl.startsWith('https://')) {
      logger.warn('auth_relay.insecure_public_url', { publicUrl: deps.config.publicUrl })
    }
  })
  return server
}

// ESM entry guard — works when run directly via tsx/node.
const isMain = (() => {
  try {
    const url = import.meta.url
    const arg = process.argv[1] ? new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href : ''
    return url === arg
  } catch {
    return false
  }
})()

if (isMain) {
  try {
    const deps = createServerDeps()
    startServer(deps)
  } catch (e) {
    console.error(`[auth-relay] fatal: ${(e as Error).message}`)
    process.exit(1)
  }
}
