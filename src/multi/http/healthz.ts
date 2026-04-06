import http from 'node:http'
import type { Pool } from 'pg'

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

export function startHealthzServer(port: number, pool: Pool): http.Server {
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
    res.writeHead(404)
    res.end()
  })
  server.listen(port)
  return server
}
