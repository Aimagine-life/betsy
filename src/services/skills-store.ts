import { getDB } from "../core/memory/db.js";
import { bufferToEmbedding, embeddingToBuffer, findBestMatches } from "./embeddings.js";

export interface InstallSkillParams {
  serviceId: string | null;
  name: string;
  description: string;
  content: string;
  embedding: Float32Array;
  sourceUrl: string | null;
}

export interface InstalledSkill {
  id: number;
  serviceId: string | null;
  name: string;
  description: string;
  content: string;
  embedding: Float32Array;
  sourceUrl: string | null;
  installedAt: number;
}

interface SkillRow {
  id: number;
  service_id: string | null;
  name: string;
  description: string;
  content: string;
  embedding: Buffer | null;
  source_url: string | null;
  installed_at: number;
}

export class SkillsStore {
  install(params: InstallSkillParams): number {
    const db = getDB();
    const result = db.prepare(`
      INSERT INTO installed_skills (service_id, name, description, content, embedding, source_url, installed_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    `).run(
      params.serviceId,
      params.name,
      params.description,
      params.content,
      embeddingToBuffer(params.embedding),
      params.sourceUrl,
    );
    return Number(result.lastInsertRowid);
  }

  delete(id: number): void {
    const db = getDB();
    db.prepare("DELETE FROM installed_skills WHERE id = ?").run(id);
  }

  listByService(serviceId: string): InstalledSkill[] {
    const db = getDB();
    const rows = db.prepare(
      "SELECT * FROM installed_skills WHERE service_id = ? ORDER BY installed_at DESC"
    ).all(serviceId) as SkillRow[];
    return rows.map(r => this.rowToSkill(r));
  }

  listAll(): InstalledSkill[] {
    const db = getDB();
    const rows = db.prepare(
      "SELECT * FROM installed_skills ORDER BY installed_at DESC"
    ).all() as SkillRow[];
    return rows.map(r => this.rowToSkill(r));
  }

  searchByVector(query: Float32Array, topK: number, serviceId?: string): InstalledSkill[] {
    const all = serviceId ? this.listByService(serviceId) : this.listAll();
    const withEmbeddings = all.filter(s => s.embedding.length > 0);
    if (withEmbeddings.length === 0) return [];
    return findBestMatches(query, withEmbeddings.map(s => ({ ...s, embedding: s.embedding })), topK);
  }

  countByService(serviceId: string): number {
    const db = getDB();
    const row = db.prepare("SELECT COUNT(*) as cnt FROM installed_skills WHERE service_id = ?").get(serviceId) as { cnt: number };
    return row.cnt;
  }

  countTotal(): number {
    const db = getDB();
    const row = db.prepare("SELECT COUNT(*) as cnt FROM installed_skills").get() as { cnt: number };
    return row.cnt;
  }

  private rowToSkill(row: SkillRow): InstalledSkill {
    return {
      id: row.id,
      serviceId: row.service_id,
      name: row.name,
      description: row.description,
      content: row.content,
      embedding: row.embedding ? bufferToEmbedding(row.embedding) : new Float32Array(0),
      sourceUrl: row.source_url,
      installedAt: row.installed_at,
    };
  }
}
