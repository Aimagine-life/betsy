import { Pool } from 'pg'

let instance: Pool | null = null

export function buildPool(connectionString: string): Pool {
  if (instance) return instance
  instance = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
  return instance
}

export function getPool(): Pool {
  if (!instance) {
    throw new Error('Postgres pool not initialized — call buildPool first')
  }
  return instance
}

export async function closePool(): Promise<void> {
  if (instance) {
    await instance.end()
    instance = null
  }
}
