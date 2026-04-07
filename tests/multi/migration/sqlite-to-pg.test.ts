import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  extractSqliteKnowledge,
  extractSqliteUserFacts,
  extractSqliteConversations,
} from '../../../src/multi/migration/sqlite-to-pg.js'

// better-sqlite3 needs a native build; some hosts (Windows without VS toolchain)
// can't compile it. The migration code itself is fine on Linux/CI/prod, so we
// skip this whole suite when the binding can't load — better than 5 noisy fails.
let Database: any
let sqliteLoadError: Error | null = null
try {
  Database = (await import('better-sqlite3')).default
  // Probe the binding by opening a throwaway in-memory db.
  new Database(':memory:').close()
} catch (e) {
  sqliteLoadError = e as Error
}

const describeSqlite = sqliteLoadError ? describe.skip : describe

describeSqlite('sqlite-to-pg extractors', () => {
  let sqlite: any

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        insight TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0.5,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE user_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        fact TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        timestamp INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_call_id TEXT,
        tool_calls TEXT,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('extracts knowledge rows', () => {
    sqlite.prepare(
      "INSERT INTO knowledge (topic, insight, source, confidence) VALUES (?, ?, ?, ?)",
    ).run('coffee', 'User loves espresso', 'learning', 0.9)
    sqlite.prepare(
      "INSERT INTO knowledge (topic, insight, source, confidence) VALUES (?, ?, ?, ?)",
    ).run('work', 'Builds AI agents', 'chat', 0.8)

    const rows = extractSqliteKnowledge(sqlite)
    expect(rows).toHaveLength(2)
    expect(rows[0].topic).toBe('coffee')
    expect(rows[0].insight).toBe('User loves espresso')
    expect(rows[0].confidence).toBe(0.9)
    expect(rows[0].id).toBe(1)
  })

  it('extracts user_facts rows', () => {
    sqlite.prepare(
      "INSERT INTO user_facts (user_id, fact, source) VALUES (?, ?, ?)",
    ).run('tg-123', 'Имя: Константин', 'onboarding')

    const rows = extractSqliteUserFacts(sqlite, 'tg-123')
    expect(rows).toHaveLength(1)
    expect(rows[0].fact).toBe('Имя: Константин')
  })

  it('filters user_facts by user_id', () => {
    sqlite.prepare(
      "INSERT INTO user_facts (user_id, fact) VALUES (?, ?)",
    ).run('a', 'A fact')
    sqlite.prepare(
      "INSERT INTO user_facts (user_id, fact) VALUES (?, ?)",
    ).run('b', 'B fact')

    const rows = extractSqliteUserFacts(sqlite, 'a')
    expect(rows).toHaveLength(1)
    expect(rows[0].fact).toBe('A fact')
  })

  it('extracts conversations by user_id', () => {
    sqlite.prepare(
      "INSERT INTO conversations (user_id, channel, role, content) VALUES (?, ?, ?, ?)",
    ).run('tg-123', 'telegram', 'user', 'Привет')
    sqlite.prepare(
      "INSERT INTO conversations (user_id, channel, role, content) VALUES (?, ?, ?, ?)",
    ).run('tg-123', 'telegram', 'assistant', 'Привет, Константин!')
    sqlite.prepare(
      "INSERT INTO conversations (user_id, channel, role, content) VALUES (?, ?, ?, ?)",
    ).run('other', 'telegram', 'user', 'Hi')

    const rows = extractSqliteConversations(sqlite, 'tg-123')
    expect(rows).toHaveLength(2)
    expect(rows[0].content).toBe('Привет')
    expect(rows[1].content).toBe('Привет, Константин!')
  })

  it('returns empty arrays for missing tables gracefully', () => {
    const empty = new Database(':memory:')
    expect(extractSqliteKnowledge(empty)).toEqual([])
    expect(extractSqliteUserFacts(empty, 'x')).toEqual([])
    expect(extractSqliteConversations(empty, 'x')).toEqual([])
    empty.close()
  })
})
