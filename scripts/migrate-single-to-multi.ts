/**
 * Usage:
 *   BC_DATABASE_URL=postgres://... \
 *   BC_SQLITE_PATH=~/.betsy/betsy.db \
 *   BC_SQLITE_USER_ID=tg-123456 \
 *   BC_OWNER_TG_ID=123456 \
 *   npx tsx scripts/migrate-single-to-multi.ts
 *
 * Steps:
 *   1. Opens single-mode SQLite at BC_SQLITE_PATH (default ~/.betsy/betsy.db)
 *   2. Connects to multi-tenant Postgres at BC_DATABASE_URL
 *   3. Runs pending migrations
 *   4. Upserts a workspace for BC_OWNER_TG_ID
 *   5. Copies knowledge / user_facts / conversations for BC_SQLITE_USER_ID
 *   6. Prints migration report
 */
import Database from 'better-sqlite3'
import { Pool } from 'pg'
import os from 'node:os'
import path from 'node:path'
import { runMigrations } from '../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../src/multi/workspaces/repo.js'
import { migrateSingleToMulti } from '../src/multi/migration/sqlite-to-pg.js'

async function main() {
  const pgUrl = process.env.BC_DATABASE_URL
  if (!pgUrl) {
    console.error('BC_DATABASE_URL is required')
    process.exit(1)
  }

  const sqlitePath =
    process.env.BC_SQLITE_PATH ?? path.join(os.homedir(), '.betsy', 'betsy.db')
  const sqliteUserId = process.env.BC_SQLITE_USER_ID
  if (!sqliteUserId) {
    console.error('BC_SQLITE_USER_ID is required (e.g., tg-123456)')
    process.exit(1)
  }
  const ownerTgId = process.env.BC_OWNER_TG_ID
    ? Number(process.env.BC_OWNER_TG_ID)
    : null
  if (!ownerTgId) {
    console.error('BC_OWNER_TG_ID is required (numeric Telegram user id)')
    process.exit(1)
  }

  console.log(`[migrate] sqlite: ${sqlitePath}`)
  console.log(`[migrate] sqlite user id: ${sqliteUserId}`)
  console.log(`[migrate] owner tg id: ${ownerTgId}`)

  const sqlite = new Database(sqlitePath, { readonly: true })
  const pool = new Pool({ connectionString: pgUrl })

  try {
    console.log('[migrate] running postgres migrations...')
    const applied = await runMigrations(pool)
    console.log(`[migrate] postgres migrations applied: ${applied.length}`)

    const wsRepo = new WorkspaceRepo(pool)
    const workspace = await wsRepo.upsertForTelegram(ownerTgId)
    console.log(`[migrate] workspace id: ${workspace.id}`)

    console.log('[migrate] copying memory...')
    const result = await migrateSingleToMulti({
      sqlite,
      pool,
      workspaceId: workspace.id,
      sqliteUserId,
    })
    console.log('[migrate] result:', result)
    console.log('[migrate] done')
  } finally {
    sqlite.close()
    await pool.end()
  }
}

main().catch((e) => {
  console.error('[migrate] failed:', e)
  process.exit(1)
})
