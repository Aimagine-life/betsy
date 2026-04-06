import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'

function here(): string {
  return dirname(fileURLToPath(import.meta.url))
}

export function resolveMigrationsDir(
  exists: (p: string) => boolean = existsSync,
  hereFn: () => string = here,
  cwdFn: () => string = () => process.cwd(),
): string {
  const candidates = [
    resolve(hereFn(), 'migrations'),
    resolve(hereFn(), 'multi', 'db', 'migrations'),
    resolve(cwdFn(), 'dist', 'multi', 'db', 'migrations'),
    resolve(cwdFn(), 'dist', 'migrations'),
    resolve(cwdFn(), 'src', 'multi', 'db', 'migrations'),
  ]
  for (const c of candidates) {
    if (exists(c)) return c
  }
  throw new Error(`Migrations directory not found. Tried:\n${candidates.join('\n')}`)
}

export async function runMigrations(pool: Pool): Promise<string[]> {
  // Advisory lock prevents concurrent migrations from two instances
  await pool.query('SELECT pg_advisory_lock($1)', [7347147])
  try {
    await pool.query(`
      create table if not exists schema_migrations (
        id serial primary key,
        name text unique not null,
        applied_at timestamptz not null default now()
      );
    `)

    const dir = resolveMigrationsDir()
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
    const applied: string[] = []

    for (const file of files) {
      const { rows } = await pool.query(
        'select 1 from schema_migrations where name = $1',
        [file],
      )
      if (rows.length > 0) continue

      const sql = await readFile(resolve(dir, file), 'utf8')
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query(sql)
        await client.query('insert into schema_migrations (name) values ($1)', [file])
        await client.query('commit')
        applied.push(file)
      } catch (e) {
        await client.query('rollback')
        throw e
      } finally {
        client.release()
      }
    }

    return applied
  } finally {
    await pool.query('SELECT pg_advisory_unlock($1)', [7347147])
  }
}
