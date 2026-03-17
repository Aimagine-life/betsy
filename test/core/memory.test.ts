import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import {
  addKnowledge,
  searchKnowledge,
  getKnowledgeCount,
} from "../../src/core/memory/knowledge.js";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";

describe("Memory", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `betsy-test-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {}
    }
  });

  it("adds and searches knowledge", () => {
    addKnowledge(
      { topic: "test", insight: "TypeScript is great", source: "test" },
      100,
    );
    const results = searchKnowledge("TypeScript", 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it("counts knowledge entries", () => {
    addKnowledge({ topic: "a", insight: "fact 1", source: "test" }, 100);
    addKnowledge({ topic: "b", insight: "fact 2", source: "test" }, 100);
    expect(getKnowledgeCount()).toBe(2);
  });
});
