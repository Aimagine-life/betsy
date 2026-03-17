import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse, stringify } from "yaml";
import type { Skill } from "./types.js";

const DEFAULT_SKILLS_DIR = path.join(os.homedir(), ".betsy", "skills");

export class SkillManager {
  private skillsDir: string;
  private skills: Skill[] = [];

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir ?? DEFAULT_SKILLS_DIR;
  }

  load(): Skill[] {
    fs.mkdirSync(this.skillsDir, { recursive: true });

    const files = fs.readdirSync(this.skillsDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

    this.skills = files.map((file) => {
      const content = fs.readFileSync(path.join(this.skillsDir, file), "utf-8");
      return parse(content) as Skill;
    });

    return this.skills;
  }

  save(skill: Skill): void {
    fs.mkdirSync(this.skillsDir, { recursive: true });
    const filename = toFilename(skill.name) + ".yaml";
    const filepath = path.join(this.skillsDir, filename);
    fs.writeFileSync(filepath, stringify(skill), "utf-8");
  }

  delete(name: string): void {
    const filename = toFilename(name) + ".yaml";
    const filepath = path.join(this.skillsDir, filename);
    try {
      fs.unlinkSync(filepath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  list(): Skill[] {
    return this.skills;
  }

  get(name: string): Skill | undefined {
    return this.skills.find((s) => s.name === name);
  }
}

/** Convert a skill name into a safe filename (lowercase, dashes for spaces). */
function toFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9а-яё\s-]/g, "")
    .replace(/\s+/g, "-");
}
