import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

let db: Database.Database | null = null;
let currentPath: string | null = null;

const DEFAULT_DB_PATH = path.join(os.homedir(), ".betsy", "betsy.db");

/**
 * Get or create the SQLite database, initializing tables and FTS5 index.
 * Accepts an optional path; defaults to ~/.betsy/betsy.db.
 */
export function getDB(dbPath?: string): Database.Database {
  // If no path specified and a connection already exists, reuse it
  if (!dbPath && db) return db;

  const resolvedPath = dbPath ?? DEFAULT_DB_PATH;

  if (db && currentPath === resolvedPath) return db;

  // Close previous connection if switching paths
  if (db) {
    db.close();
    db = null;
    currentPath = null;
  }

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  db = new Database(resolvedPath);
  currentPath = resolvedPath;

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_call_id TEXT,
      tool_calls TEXT,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      insight TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0.5,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      timestamp INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS user_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      fact TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      timestamp INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts
      USING fts5(topic, insight, content='knowledge', content_rowid='id');

    -- Triggers to keep FTS index in sync
    CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, topic, insight)
        VALUES (new.id, new.topic, new.insight);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, topic, insight)
        VALUES ('delete', old.id, old.topic, old.insight);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, topic, insight)
        VALUES ('delete', old.id, old.topic, old.insight);
      INSERT INTO knowledge_fts(rowid, topic, insight)
        VALUES (new.id, new.topic, new.insight);
    END;
  `);

  // Migration: upgrade old conversations table if needed
  const cols = db.pragma("table_info(conversations)") as Array<{ name: string }>;
  const colNames = cols.map((c: { name: string }) => c.name);
  const hasCorrectSchema = colNames.includes("user_id") && colNames.includes("channel");
  if (!hasCorrectSchema) {
    // Old schema may have chat_id instead of channel, or missing user_id/tool columns
    // Safest approach: drop and recreate (data is either empty or unrecoverable)
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM conversations").get() as { cnt: number }).cnt;
    if (count === 0 || !colNames.includes("channel")) {
      // Empty table or incompatible schema (e.g., chat_id instead of channel) — recreate
      db.exec("DROP TABLE IF EXISTS conversations");
      db.exec(`CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_call_id TEXT,
        tool_calls TEXT,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch())
      )`);
    } else {
      // Has channel but missing user_id/tool columns — ALTER TABLE
      const conn = db;
      conn.transaction(() => {
        if (!colNames.includes("user_id")) conn.prepare("ALTER TABLE conversations ADD COLUMN user_id TEXT NOT NULL DEFAULT ''").run();
        if (!colNames.includes("tool_call_id")) conn.prepare("ALTER TABLE conversations ADD COLUMN tool_call_id TEXT").run();
        if (!colNames.includes("tool_calls")) conn.prepare("ALTER TABLE conversations ADD COLUMN tool_calls TEXT").run();
        conn.prepare("DELETE FROM conversations WHERE user_id = ''").run();
      })();
    }
  }

  db.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (
    user_id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    token_estimate INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

  db.exec("CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, timestamp)");

  db.exec(`CREATE TABLE IF NOT EXISTS service_tokens (
    service_id    TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    access_token  TEXT NOT NULL,
    refresh_token TEXT,
    scopes        TEXT,
    expires_at    INTEGER,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (service_id, user_id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS installed_skills (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id   TEXT,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL,
    content      TEXT NOT NULL,
    embedding    BLOB,
    source_url   TEXT,
    installed_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

  return db;
}

/**
 * Log a structured event to the events table.
 */
export function logEvent(type: string, data: Record<string, unknown> = {}): void {
  const d = getDB();
  d.prepare(
    "INSERT INTO events (type, data, timestamp) VALUES (?, ?, ?)",
  ).run(type, JSON.stringify(data), Math.floor(Date.now() / 1000));
}

/**
 * Close the database connection (useful for cleanup in tests).
 */
export function closeDB(): void {
  if (db) {
    db.close();
    db = null;
    currentPath = null;
  }
}
