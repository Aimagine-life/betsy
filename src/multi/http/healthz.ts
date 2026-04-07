import http from 'node:http'
import type { Pool } from 'pg'

export type ExtraRoute = {
  method: string
  path: string
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void
}

export interface HealthzDeps {
  dbCheck: () => Promise<boolean>
}

export interface HealthzResponse {
  status: number
  body: string
}

export async function handleHealthz(deps: HealthzDeps): Promise<HealthzResponse> {
  try {
    const ok = await deps.dbCheck()
    if (ok) return { status: 200, body: '{"status":"ok"}' }
    return { status: 503, body: '{"status":"error"}' }
  } catch {
    return { status: 503, body: '{"status":"error"}' }
  }
}

export function startHealthzServer(
  port: number,
  pool: Pool,
  extraRoutes: ExtraRoute[] = [],
): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const result = await handleHealthz({
        dbCheck: async () => {
          const r = await pool.query('select 1')
          return r.rows.length > 0
        },
      })
      res.writeHead(result.status, { 'content-type': 'application/json' })
      res.end(result.body)
      return
    }
    for (const route of extraRoutes) {
      if (req.method === route.method && req.url === route.path) {
        try {
          await route.handler(req, res)
        } catch (e) {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'internal error' }))
          }
        }
        return
      }
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(port)
  return server
}
