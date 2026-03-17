import { getDB } from "./db.js";

export interface KnowledgeRow {
  id: number;
  topic: string;
  insight: string;
  source: string;
  confidence: number;
  timestamp: number;
}

/**
 * Add a knowledge entry to the database.
 * @param entry - The knowledge entry (topic, insight, source).
 * @param confidence - Confidence score between 0 and 1 (default 0.5).
 */
export function addKnowledge(
  entry: { topic: string; insight: string; source: string },
  confidence = 0.5,
): void {
  const db = getDB();
  db.prepare(
    "INSERT INTO knowledge (topic, insight, source, confidence, timestamp) VALUES (?, ?, ?, ?, ?)",
  ).run(entry.topic, entry.insight, entry.source, confidence, Math.floor(Date.now() / 1000));
}

/**
 * Full-text search across knowledge entries using FTS5.
 * Returns up to `limit` matching rows ordered by relevance.
 */
export function searchKnowledge(query: string, limit = 5): KnowledgeRow[] {
  if (!query.trim()) return [];

  const db = getDB();
  const rows = db
    .prepare(
      `SELECT k.id, k.topic, k.insight, k.source, k.confidence, k.timestamp
       FROM knowledge_fts fts
       JOIN knowledge k ON k.id = fts.rowid
       WHERE knowledge_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(query, limit) as KnowledgeRow[];

  return rows;
}

/**
 * Retrieve all knowledge entries, ordered by most recent first.
 */
export function getAllKnowledge(): KnowledgeRow[] {
  const db = getDB();
  return db
    .prepare("SELECT id, topic, insight, source, confidence, timestamp FROM knowledge ORDER BY timestamp DESC")
    .all() as KnowledgeRow[];
}

/**
 * Get the total number of knowledge entries.
 */
export function getKnowledgeCount(): number {
  const db = getDB();
  const row = db.prepare("SELECT COUNT(*) as count FROM knowledge").get() as { count: number };
  return row.count;
}
