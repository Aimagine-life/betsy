import type Database from 'better-sqlite3'
import type { Pool } from 'pg'
import { withWorkspace } from '../db/rls.js'

export interface SqliteKnowledgeRow {
  id: number
  topic: string
  insight: string
  source: string
  confidence: number
  timestamp: number
}

export interface SqliteUserFactRow {
  id: number
  user_id: string
  fact: string
  source: string
  timestamp: number
}

export interface SqliteConversationRow {
  id: number
  user_id: string
  channel: string
  role: string
  content: string
  tool_calls: string | null
  timestamp: number
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name)
  return row !== undefined
}

export function extractSqliteKnowledge(db: Database.Database): SqliteKnowledgeRow[] {
  if (!tableExists(db, 'knowledge')) return []
  return db
    .prepare('SELECT id, topic, insight, source, confidence, timestamp FROM knowledge ORDER BY id')
    .all() as SqliteKnowledgeRow[]
}

export function extractSqliteUserFacts(
  db: Database.Database,
  userId: string,
): SqliteUserFactRow[] {
  if (!tableExists(db, 'user_facts')) return []
  return db
    .prepare('SELECT id, user_id, fact, source, timestamp FROM user_facts WHERE user_id = ? ORDER BY id')
    .all(userId) as SqliteUserFactRow[]
}

export function extractSqliteConversations(
  db: Database.Database,
  userId: string,
): SqliteConversationRow[] {
  if (!tableExists(db, 'conversations')) return []
  return db
    .prepare(
      'SELECT id, user_id, channel, role, content, tool_calls, timestamp FROM conversations WHERE user_id = ? ORDER BY id',
    )
    .all(userId) as SqliteConversationRow[]
}

export interface MigrationResult {
  knowledgeCopied: number
  userFactsCopied: number
  conversationsCopied: number
  skippedExistingKnowledge: number
  skippedExistingFacts: number
  skippedExistingConversations: number
}

export interface MigrateOptions {
  sqlite: Database.Database
  pool: Pool
  workspaceId: string
  sqliteUserId: string
}

/**
 * Migrate one single-mode user's memory into a multi-tenant workspace.
 *
 * Idempotent: stores `source_sqlite_id` in meta JSON so re-running skips already migrated rows.
 */
export async function migrateSingleToMulti(opts: MigrateOptions): Promise<MigrationResult> {
  const { sqlite, pool, workspaceId, sqliteUserId } = opts

  const knowledge = extractSqliteKnowledge(sqlite)
  const userFacts = extractSqliteUserFacts(sqlite, sqliteUserId)
  const conversations = extractSqliteConversations(sqlite, sqliteUserId)

  const result: MigrationResult = {
    knowledgeCopied: 0,
    userFactsCopied: 0,
    conversationsCopied: 0,
    skippedExistingKnowledge: 0,
    skippedExistingFacts: 0,
    skippedExistingConversations: 0,
  }

  await withWorkspace(pool, workspaceId, async (client) => {
    const existingFacts = await client.query(
      `select meta->>'source_sqlite_id' as sid, kind
       from bc_memory_facts
       where meta ? 'source_sqlite_id'`,
    )
    const knowledgeIds = new Set(
      existingFacts.rows
        .filter((r: any) => r.kind === 'knowledge')
        .map((r: any) => Number(r.sid)),
    )
    const factIds = new Set(
      existingFacts.rows
        .filter((r: any) => r.kind === 'fact')
        .map((r: any) => Number(r.sid)),
    )

    for (const k of knowledge) {
      if (knowledgeIds.has(k.id)) {
        result.skippedExistingKnowledge++
        continue
      }
      const content = `${k.topic}: ${k.insight}`
      const meta = {
        source_sqlite_id: k.id,
        source: k.source,
        confidence: k.confidence,
        original_topic: k.topic,
      }
      await client.query(
        `insert into bc_memory_facts (workspace_id, kind, content, meta, created_at)
         values ($1, 'knowledge', $2, $3, to_timestamp($4))`,
        [workspaceId, content, JSON.stringify(meta), k.timestamp],
      )
      result.knowledgeCopied++
    }

    for (const f of userFacts) {
      if (factIds.has(f.id)) {
        result.skippedExistingFacts++
        continue
      }
      const meta = {
        source_sqlite_id: f.id,
        source: f.source,
        sqlite_user_id: f.user_id,
      }
      await client.query(
        `insert into bc_memory_facts (workspace_id, kind, content, meta, created_at)
         values ($1, 'fact', $2, $3, to_timestamp($4))`,
        [workspaceId, f.fact, JSON.stringify(meta), f.timestamp],
      )
      result.userFactsCopied++
    }

    const existingConv = await client.query(
      `select meta->>'source_sqlite_id' as sid
       from bc_conversation
       where meta ? 'source_sqlite_id'`,
    )
    const convIds = new Set(
      existingConv.rows.map((r: any) => Number(r.sid)),
    )

    for (const c of conversations) {
      if (convIds.has(c.id)) {
        result.skippedExistingConversations++
        continue
      }
      const channel = c.channel === 'telegram' || c.channel === 'max' ? c.channel : 'telegram'
      const role = c.role === 'user' || c.role === 'assistant' || c.role === 'tool' ? c.role : 'user'
      const meta = {
        source_sqlite_id: c.id,
        sqlite_user_id: c.user_id,
        sqlite_channel: c.channel,
      }
      await client.query(
        `insert into bc_conversation (workspace_id, channel, role, content, tool_calls, meta, created_at)
         values ($1, $2, $3, $4, $5, $6, to_timestamp($7))`,
        [
          workspaceId,
          channel,
          role,
          c.content,
          c.tool_calls ? c.tool_calls : null,
          JSON.stringify(meta),
          c.timestamp,
        ],
      )
      result.conversationsCopied++
    }
  })

  return result
}
