/**
 * Wave 3c — end-to-end OAuth flow simulation (no Postgres, no network).
 *
 * Verifies that the full pipeline works in-process:
 *   1. relay callback HMAC verification and DB persist
 *   2. list_integrations reflects connected state
 *   3. OAuthResolver produces env vars
 *   4. McpRegistry merges env and constructs a stub client
 *   5. disconnect_integration wipes token + server
 *
 * Run with: npx tsx src/multi/sim/oauth-flow.ts
 */
import { createHmac, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OAuthRepo, OAuthTokenRecord, ListedToken, UpsertTokenInput } from '../oauth/repo.js'
import type { McpServersRepo } from '../agents/mcp/repo.js'
import type { McpServerConfig } from '../agents/mcp/types.js'
import { createRelayCallbackHandler } from '../oauth/relay-callback.js'
import { createOAuthTools } from '../oauth/oauth-tools.js'
import { OAuthResolver } from '../agents/mcp/oauth-resolver.js'
import { McpRegistry } from '../agents/mcp/registry.js'
import { getBuiltinMcpServer } from '../agents/mcp/builtin.js'

// --- Env bootstrap (in-memory only) -----------------------------------------
process.env.BC_OAUTH_ENC_KEY = randomBytes(32).toString('hex')
process.env.BC_OAUTH_RELAY_SECRET = 'sim-secret'

const WS = '22222222-2222-2222-2222-222222222222'

// --- In-memory OAuthRepo ----------------------------------------------------
class MemOAuthRepo implements Pick<OAuthRepo, 'upsertToken' | 'getToken' | 'listTokens' | 'deleteToken'> {
  private map = new Map<string, OAuthTokenRecord>()
  key(ws: string, prov: string, label?: string) {
    return `${ws}::${prov}::${label ?? ''}`
  }
  async upsertToken(workspaceId: string, input: UpsertTokenInput): Promise<string> {
    const k = this.key(workspaceId, input.provider, input.accountLabel)
    const rec: OAuthTokenRecord = {
      id: k,
      workspaceId,
      provider: input.provider,
      scopes: input.scopes ?? [],
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt,
      accountLabel: input.accountLabel,
      metadata: input.metadata ?? {},
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    this.map.set(k, rec)
    return k
  }
  async getToken(workspaceId: string, provider: string, accountLabel?: string) {
    return this.map.get(this.key(workspaceId, provider, accountLabel)) ?? null
  }
  async listTokens(workspaceId: string): Promise<ListedToken[]> {
    const now = Date.now()
    return Array.from(this.map.values())
      .filter((r) => r.workspaceId === workspaceId)
      .map((r) => ({
        id: r.id,
        provider: r.provider,
        scopes: r.scopes,
        expiresAt: r.expiresAt,
        accountLabel: r.accountLabel,
        expired: r.expiresAt ? r.expiresAt.getTime() < now : false,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }))
  }
  async deleteToken(workspaceId: string, provider: string, accountLabel?: string) {
    return this.map.delete(this.key(workspaceId, provider, accountLabel))
  }
}

// --- In-memory McpServersRepo ----------------------------------------------
class MemMcpServersRepo {
  rows: McpServerConfig[] = []
  async listEnabled(_ws: string) {
    return this.rows.filter((r) => r.enabled)
  }
  async listServers(_ws: string) {
    return this.rows.slice()
  }
  async upsertServer(_ws: string, cfg: Omit<McpServerConfig, 'id'>) {
    const existing = this.rows.find((r) => r.name === cfg.name)
    if (existing) Object.assign(existing, cfg)
    else this.rows.push({ ...cfg, id: `mem-${cfg.name}` })
    return this.rows.find((r) => r.name === cfg.name)!
  }
  async deleteServer(_ws: string, name: string) {
    const i = this.rows.findIndex((r) => r.name === name)
    if (i >= 0) {
      this.rows.splice(i, 1)
      return true
    }
    return false
  }
  async setEnabled(_ws: string, name: string, enabled: boolean) {
    const r = this.rows.find((x) => x.name === name)
    if (r) {
      r.enabled = enabled
      return true
    }
    return false
  }
}

// --- Fake http request/response --------------------------------------------
function mkReq(headers: Record<string, string>, body: string): IncomingMessage {
  const req: any = new EventEmitter()
  req.headers = headers
  req.method = 'POST'
  req.url = '/oauth/token'
  req.destroy = () => {}
  setImmediate(() => {
    req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req as IncomingMessage
}

function mkRes(): ServerResponse & { _status: number; _body: string } {
  const res: any = {
    _status: 0,
    _body: '',
    headersSent: false,
    writeHead(code: number) {
      this._status = code
      this.headersSent = true
    },
    end(chunk?: any) {
      if (chunk) this._body += chunk.toString()
    },
  }
  return res
}

function assert(cond: any, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  console.log('  ok —', msg)
}

async function main() {
  console.log('sim: oauth flow e2e')

  const oauthRepo = new MemOAuthRepo() as unknown as OAuthRepo
  const mcpServersRepo = new MemMcpServersRepo() as unknown as McpServersRepo

  // Step 1: simulate relay callback posting a google token for gcal.
  const handler = createRelayCallbackHandler({ oauthRepo, mcpServersRepo })
  const bodyObj = {
    workspace_id: WS,
    provider: 'google',
    access_token: 'fake-access-' + randomBytes(8).toString('hex'),
    refresh_token: 'fake-refresh-' + randomBytes(8).toString('hex'),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    scopes: ['https://www.googleapis.com/auth/calendar'],
    integration: 'gcal',
  }
  const body = JSON.stringify(bodyObj)
  const ts = Math.floor(Date.now() / 1000)
  const sig = createHmac('sha256', 'sim-secret').update(`${ts}.${body}`).digest('hex')
  const req = mkReq(
    {
      'x-relay-timestamp': String(ts),
      'x-relay-signature': sig,
    },
    body,
  )
  const res = mkRes()
  await handler(req, res)
  assert(res._status === 200, 'callback returns 200')
  assert(res._body.includes('"ok":true'), 'callback body ok:true')

  // Step 2: oauthRepo now contains the token.
  const stored = await (oauthRepo as any).getToken(WS, 'google')
  assert(stored && stored.accessToken === bodyObj.access_token, 'token persisted')

  // Also builtin auto-enabled mcp row.
  const rows = await (mcpServersRepo as any).listServers(WS)
  assert(
    rows.some((r: McpServerConfig) => r.name === 'gcal' && r.enabled),
    'gcal mcp server row auto-enabled',
  )

  // Step 3: list_integrations shows gcal as connected.
  const tools = createOAuthTools({
    workspaceId: WS,
    oauthRepo,
    mcpServersRepo,
  })
  const listTool = tools.find((t) => t.name === 'list_integrations')!
  const listed: any = await listTool.execute({})
  const gcal = listed.integrations.find((i: any) => i.id === 'gcal')
  assert(gcal && gcal.status === 'connected', 'list_integrations: gcal connected')

  // Step 4: OAuthResolver yields env vars.
  const resolver = new OAuthResolver({ oauthRepo })
  const gcalBuiltin = getBuiltinMcpServer('gcal')!
  const resolved = await resolver.resolve({
    workspaceId: WS,
    oauth: gcalBuiltin.oauth!,
  })
  assert(resolved.ok, 'resolver ok=true')
  if (resolved.ok) {
    assert(
      resolved.env.GOOGLE_OAUTH_ACCESS_TOKEN === bodyObj.access_token,
      'resolver env has access token',
    )
  }

  // Step 5: McpRegistry with stub client factory honours merged env.
  let capturedCfg: McpServerConfig | null = null
  const reg = new McpRegistry({
    pool: {} as any,
    repo: mcpServersRepo,
    oauthResolver: resolver,
    clientFactory: (cfg) => {
      capturedCfg = cfg
      return {
        name: cfg.name,
        listTools: async () => [
          { name: 'noop', inputSchema: { type: 'object', properties: {} } },
        ],
        callTool: async () => ({ text: '', isError: false }),
        close: async () => {},
      } as any
    },
  })
  const loaded = await reg.loadForWorkspace(WS)
  assert(capturedCfg !== null, 'registry built client for gcal')
  assert(
    (capturedCfg as any)?.env?.GOOGLE_OAUTH_ACCESS_TOKEN === bodyObj.access_token,
    'merged env contains oauth access token',
  )
  assert(loaded.getTools().length === 1, 'one bridged tool from stub')
  await loaded.closeAll()

  // Step 6: disconnect_integration wipes token + server row.
  const disconnectTool = tools.find((t) => t.name === 'disconnect_integration')!
  const dres: any = await disconnectTool.execute({ id: 'gcal' })
  assert(dres.ok === true, 'disconnect ok')
  assert(dres.removed.includes('oauth_token'), 'removed oauth_token')
  assert(dres.removed.includes('mcp_server'), 'removed mcp_server')
  const remaining = await (oauthRepo as any).listTokens(WS)
  assert(remaining.length === 0, 'oauthRepo empty after disconnect')
  const remainingRows = await (mcpServersRepo as any).listServers(WS)
  assert(remainingRows.length === 0, 'mcpServersRepo empty after disconnect')

  console.log('sim: oauth flow e2e — OK')
}

main().catch((e) => {
  console.error('sim failed', e)
  process.exit(1)
})
