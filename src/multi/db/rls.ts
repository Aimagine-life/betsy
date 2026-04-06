import type { Pool, PoolClient } from 'pg'

/**
 * Execute a function within a workspace-scoped transaction.
 * All queries inside see only data where workspace_id matches.
 * RLS policies enforce this at the Postgres level.
 */
export async function withWorkspace<T>(
  pool: Pool,
  workspaceId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query(`select set_config('app.workspace_id', $1, true)`, [workspaceId])
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Execute a function as admin, bypassing RLS.
 * Used for cross-workspace operations: creating new workspaces,
 * billing reconciliation, migrations, backups.
 *
 * SECURITY: only call from trusted code paths that don't take user input as workspace_id.
 */
export async function asAdmin<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query(`set local row_security = off`)
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
