import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDB, closeDB } from "../../../src/core/memory/db.js";
import { SkillsStore } from "../../../src/services/skills-store.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

describe("SkillsStore", () => {
  const testDbPath = path.join(os.tmpdir(), `betsy-test-skills-${Date.now()}.db`);
  let store: SkillsStore;

  beforeEach(() => {
    closeDB();
    getDB(testDbPath);
    store = new SkillsStore();
  });

  afterEach(() => {
    closeDB();
    try { fs.unlinkSync(testDbPath); } catch {}
    try { fs.unlinkSync(testDbPath + "-wal"); } catch {}
    try { fs.unlinkSync(testDbPath + "-shm"); } catch {}
  });

  it("installs and retrieves a skill", () => {
    const embedding = new Float32Array([0.1, 0.2, 0.3]);
    store.install({
      serviceId: "google",
      name: "gmail-summary",
      description: "Daily Gmail summary",
      content: "# Gmail Summary\nFetch unread emails...",
      embedding,
      sourceUrl: "https://github.com/test/skill",
    });
    const skills = store.listByService("google");
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("gmail-summary");
    expect(skills[0].content).toContain("Gmail Summary");
  });

  it("searches by vector similarity", () => {
    store.install({ serviceId: "google", name: "gmail-summary", description: "Email digest", content: "...", embedding: new Float32Array([1, 0, 0]), sourceUrl: null });
    store.install({ serviceId: "google", name: "youtube-stats", description: "Channel stats", content: "...", embedding: new Float32Array([0, 1, 0]), sourceUrl: null });
    store.install({ serviceId: "github", name: "pr-review", description: "PR automation", content: "...", embedding: new Float32Array([0, 0, 1]), sourceUrl: null });

    const query = new Float32Array([0.9, 0.1, 0]);
    const results = store.searchByVector(query, 2);
    expect(results).toHaveLength(2);
    expect(results[0].name).toBe("gmail-summary");
  });

  it("searchByVector filters by serviceId", () => {
    store.install({ serviceId: "google", name: "gmail-skill", description: "Gmail", content: "...", embedding: new Float32Array([1, 0]), sourceUrl: null });
    store.install({ serviceId: "github", name: "gh-skill", description: "GitHub", content: "...", embedding: new Float32Array([1, 0]), sourceUrl: null });

    const query = new Float32Array([1, 0]);
    const results = store.searchByVector(query, 10, "google");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("gmail-skill");
  });

  it("deletes a skill by id", () => {
    store.install({ serviceId: "google", name: "test", description: "test", content: "...", embedding: new Float32Array([1]), sourceUrl: null });
    const skills = store.listByService("google");
    expect(skills).toHaveLength(1);
    store.delete(skills[0].id);
    expect(store.listByService("google")).toHaveLength(0);
  });

  it("counts skills per service", () => {
    store.install({ serviceId: "google", name: "s1", description: "d", content: "c", embedding: new Float32Array([1]), sourceUrl: null });
    store.install({ serviceId: "google", name: "s2", description: "d", content: "c", embedding: new Float32Array([1]), sourceUrl: null });
    store.install({ serviceId: "github", name: "s3", description: "d", content: "c", embedding: new Float32Array([1]), sourceUrl: null });
    expect(store.countByService("google")).toBe(2);
    expect(store.countByService("github")).toBe(1);
    expect(store.countTotal()).toBe(3);
  });
});
