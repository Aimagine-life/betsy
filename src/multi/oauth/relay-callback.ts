/**
 * Wave 3c — HTTP handler for auth-relay token callback.
 *
 * The auth-relay (auth.betsyai.io) performs the interactive OAuth flow with
 * the upstream provider on behalf of a workspace and then POSTs the resulting
 * tokens to this endpoint. The request is authenticated with an HMAC-SHA256
 * signature over `${timestamp}.${rawBody}` using BC_OAUTH_RELAY_SECRET, plus
 * an anti-replay window of ±5 minutes.
 *
 * SECURITY:
 *  - Timing-safe signature comparison.
 *  - Max body size 64 KB.
 *  - Tokens never logged, never returned.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { OAuthRepo } from './repo.js'
import type { McpServersRepo } from '../agents/mcp/repo.js'
import { getBuiltinMcpServer } from '../agents/mcp/builtin.js'
import { log } from '../observability/logger.js'

export const MAX_RELAY_BODY_BYTES = 64 * 1024
export const MAX_RELAY_SKEW_SEC = 300

const RelayTokenSchema = z.object({
  workspace_id: z.string().uuid(),
  provider: z.enum(['google', 'notion', 'github']),
  account_label: z.string().optional(),
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_at: z.string().datetime().optional(),
  scopes: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  /** Optional: id of the builtin MCP integration to auto-enable after token arrives. */
  integration: z.string().optional(),
})

export interface RelayCallbackDeps {
  oauthRepo: OAuthRepo
  mcpServersRepo?: McpServersRepo
  /** Secret for HMAC verification. Usually process.env.BC_OAUTH_RELAY_SECRET. */
  secret?: string
  /** For testing clock skew. */
  now?: () => number
}

/**
 * Timing-safe HMAC-SHA256 verification.
 * Returns false on any malformed input instead of throwing.
 */
export function verifyRelayHmac(
  rawBody: string,
  timestamp: string,
  signature: string,
  secret: string,
  nowSec: number,
): boolean {
  if (!timestamp || !signature) return false
  const ts = parseInt(timestamp, 10)
  if (!Number.isFinite(ts)) return false
  if (Math.abs(nowSec - ts) > MAX_RELAY_SKEW_SEC) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  if (expected.length !== signature.length) return false
  let a: Buffer
  let b: Buffer
  try {
    a = Buffer.from(expected, 'hex')
    b = Buffer.from(signature, 'hex')
  } catch {
    return false
  }
  if (a.length !== b.length || a.length === 0) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readRawBody(req: IncomingMessage, max: number): Promise<Buffer | 'too_large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      size += chunk.length
      if (size > max) {
        aborted = true
        resolve('too_large')
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (aborted) return
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (e) => {
      if (!aborted) reject(e)
    })
  })
}

/**
 * Builds an HTTP handler for POST /oauth/token. Safe to mount into any
 * node:http server via `if (url === '/oauth/token' && method === 'POST') ...`.
 */
export function createRelayCallbackHandler(
  deps: RelayCallbackDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const logger = log()
  return async function handler(req, res) {
    const secret = deps.secret ?? process.env.BC_OAUTH_RELAY_SECRET
    if (!secret) {
      logger.info('oauth.token.disabled', { reason: 'no secret configured' })
      return sendJson(res, 503, { error: 'oauth relay disabled' })
    }

    const body = await readRawBody(req, MAX_RELAY_BODY_BYTES).catch(() => null)
    if (body === null) {
      return sendJson(res, 400, { error: 'body read failed' })
    }
    if (body === 'too_large') {
      return sendJson(res, 413, { error: 'payload too large' })
    }
    const rawBody = body.toString('utf8')

    const ts = String(req.headers['x-relay-timestamp'] ?? '')
    const sig = String(req.headers['x-relay-signature'] ?? '')
    if (!ts || !sig) {
      logger.warn('oauth.token.unauthorized', { reason: 'missing headers' })
      return sendJson(res, 401, { error: 'unauthorized' })
    }

    const nowSec = Math.floor((deps.now ? deps.now() : Date.now()) / 1000)
    if (!verifyRelayHmac(rawBody, ts, sig, secret, nowSec)) {
      logger.warn('oauth.token.unauthorized', {
        reason: 'bad signature or skew',
        sigPrefix: sig.slice(0, 4),
      })
      return sendJson(res, 401, { error: 'unauthorized' })
    }

    let json: unknown
    try {
      json = JSON.parse(rawBody)
    } catch {
      logger.warn('oauth.token.bad_json')
      return sendJson(res, 400, { error: 'invalid json' })
    }

    const parsed = RelayTokenSchema.safeParse(json)
    if (!parsed.success) {
      logger.warn('oauth.token.invalid', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
      })
      return sendJson(res, 400, { error: 'invalid payload' })
    }

    const data = parsed.data

    try {
      const expiresAt = data.expires_at ? new Date(data.expires_at) : undefined
      await deps.oauthRepo.upsertToken(data.workspace_id, {
        provider: data.provider,
        scopes: data.scopes,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
        accountLabel: data.account_label,
        metadata: data.metadata ?? {},
      })

      // Best-effort: auto-enable matching builtin MCP server row. Never fail
      // the callback if this step fails — token already persisted.
      if (data.integration && deps.mcpServersRepo) {
        const builtin = getBuiltinMcpServer(data.integration)
        if (builtin) {
          try {
            await deps.mcpServersRepo.upsertServer(data.workspace_id, {
              name: builtin.id,
              transport: builtin.transport,
              command: builtin.command,
              args: builtin.args ?? [],
              env: builtin.envTemplate ?? {},
              enabled: true,
            })
          } catch (e) {
            logger.warn('oauth.token.mcp_enable_failed', {
              workspaceId: data.workspace_id,
              integration: data.integration,
              error: e instanceof Error ? e.message : String(e),
            })
          }
        }
      }

      const expiresInSec = expiresAt
        ? Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
        : undefined
      logger.info('oauth.token.received', {
        provider: data.provider,
        workspaceId: data.workspace_id,
        hasRefresh: !!data.refresh_token,
        expiresInSec,
      })
      return sendJson(res, 200, { ok: true })
    } catch (e) {
      logger.error('oauth.token.upsert_failed', {
        workspaceId: data.workspace_id,
        provider: data.provider,
        error: e instanceof Error ? e.message : String(e),
      })
      return sendJson(res, 500, { error: 'internal error' })
    }
  }
}
