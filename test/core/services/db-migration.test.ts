import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDB, closeDB } from "../../../src/core/memory/db.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

describe("service tables migration", () => {
  const testDbPath = path.join(os.tmpdir(), `betsy-test-svc-${Date.now()}.db`);

  beforeEach(() => {
    closeDB();
  });

  afterEach(() => {
    closeDB();
    try { fs.unlinkSync(testDbPath); } catch {}
    try { fs.unlinkSync(testDbPath + "-wal"); } catch {}
    try { fs.unlinkSync(testDbPath + "-shm"); } catch {}
  });

  it("creates service_tokens table", () => {
    const db = getDB(testDbPath);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='service_tokens'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it("creates installed_skills table", () => {
    const db = getDB(testDbPath);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='installed_skills'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it("service_tokens has correct columns", () => {
    const db = getDB(testDbPath);
    const cols = db.pragma("table_info(service_tokens)") as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain("service_id");
    expect(names).toContain("user_id");
    expect(names).toContain("access_token");
    expect(names).toContain("refresh_token");
    expect(names).toContain("scopes");
    expect(names).toContain("expires_at");
    expect(names).toContain("created_at");
  });

  it("installed_skills has correct columns", () => {
    const db = getDB(testDbPath);
    const cols = db.pragma("table_info(installed_skills)") as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain("service_id");
    expect(names).toContain("name");
    expect(names).toContain("description");
    expect(names).toContain("content");
    expect(names).toContain("embedding");
    expect(names).toContain("source_url");
    expect(names).toContain("installed_at");
  });
});
