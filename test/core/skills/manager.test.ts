import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillManager } from "../../../src/core/skills/manager.js";
import type { Skill } from "../../../src/core/skills/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "betsy-skills-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SkillManager", () => {
  it("saves and loads skill", () => {
    const mgr = new SkillManager(tmpDir);
    mgr.save({ name: "test", description: "A test", trigger: "test", steps: [] });
    const skills = mgr.load();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("test");
  });

  it("deletes skill", () => {
    const mgr = new SkillManager(tmpDir);
    mgr.save({ name: "test", description: "", trigger: "", steps: [] });
    mgr.delete("test");
    expect(mgr.load()).toHaveLength(0);
  });

  it("returns loaded skills from list()", () => {
    const mgr = new SkillManager(tmpDir);
    mgr.save({ name: "alpha", description: "first", trigger: "a", steps: [] });
    mgr.save({ name: "beta", description: "second", trigger: "b", steps: [] });
    mgr.load();
    expect(mgr.list()).toHaveLength(2);
  });

  it("finds a skill by name via get()", () => {
    const mgr = new SkillManager(tmpDir);
    const skill: Skill = {
      name: "lookup",
      description: "Find things",
      trigger: "find",
      steps: [{ tool: "browser", action: "search" }],
    };
    mgr.save(skill);
    mgr.load();
    const found = mgr.get("lookup");
    expect(found).toBeDefined();
    expect(found!.description).toBe("Find things");
    expect(found!.steps).toHaveLength(1);
  });

  it("returns undefined for unknown skill", () => {
    const mgr = new SkillManager(tmpDir);
    mgr.load();
    expect(mgr.get("nonexistent")).toBeUndefined();
  });

  it("persists skill steps and params as YAML", () => {
    const mgr = new SkillManager(tmpDir);
    const skill: Skill = {
      name: "full",
      description: "Full skill",
      trigger: { scheduler: "0 * * * *" },
      steps: [
        { tool: "browser", action: "get_text", params: { url: "https://example.com" } },
        { tool: "memory", action: "save", params: { topic: "test" } },
      ],
    };
    mgr.save(skill);
    const loaded = mgr.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].trigger).toEqual({ scheduler: "0 * * * *" });
    expect(loaded[0].steps).toHaveLength(2);
    expect(loaded[0].steps[0].params?.url).toBe("https://example.com");
  });
});
