import type { Tool, ToolResult } from "./types.js";
import { SkillsStore } from "../../services/skills-store.js";
import { generateEmbedding } from "../../services/embeddings.js";

const MAX_SKILL_CHARS = 8_000;
const MAX_SKILLS_PER_SERVICE = 20;
const MAX_SKILLS_TOTAL = 200;

export interface SkillInstallConfig {
  apiKey?: string;
}

export class SkillInstallTool implements Tool {
  name = "skill_install";
  description =
    "Install a skill from GitHub by downloading its SKILL.md and saving it to installed_skills. " +
    "After installation the skill instructions become part of your knowledge base and you can follow them. " +
    "Use after skill_search finds a relevant skill.";
  parameters = [
    { name: "github_url", type: "string", description: "GitHub URL of the skill folder (from skill_search results)", required: true },
    { name: "skill_name", type: "string", description: "Short name for the skill (e.g. 'image-generation')", required: true },
    { name: "service_id", type: "string", description: "Associated service ID (e.g. 'google', 'github') or omit for general skills" },
  ];

  private apiKey?: string;

  constructor(config?: SkillInstallConfig) {
    this.apiKey = config?.apiKey;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const githubUrl = String(params.github_url ?? "").trim();
    const skillName = String(params.skill_name ?? "").trim();
    const serviceId = params.service_id ? String(params.service_id).trim() : null;

    if (!githubUrl) {
      return { success: false, output: "Missing required parameter: github_url" };
    }
    if (!skillName) {
      return { success: false, output: "Missing required parameter: skill_name" };
    }

    // Check limits
    const store = new SkillsStore();
    if (store.countTotal() >= MAX_SKILLS_TOTAL) {
      return { success: false, output: `Skill limit reached: max ${MAX_SKILLS_TOTAL} total skills installed` };
    }
    if (serviceId && store.countByService(serviceId) >= MAX_SKILLS_PER_SERVICE) {
      return { success: false, output: `Skill limit reached: max ${MAX_SKILLS_PER_SERVICE} skills per service (${serviceId})` };
    }

    // Convert GitHub tree URL to raw content URL
    const rawUrl = toRawUrl(githubUrl);
    if (!rawUrl) {
      return { success: false, output: `Cannot parse GitHub URL: ${githubUrl}` };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);

      const response = await fetch(rawUrl, { signal: controller.signal });
      clearTimeout(timer);

      if (!response.ok) {
        return { success: false, output: `Failed to download SKILL.md: HTTP ${response.status}`, error: await response.text().then(t => t.slice(0, 300)) };
      }

      let content = await response.text();

      // Truncate very large skills to avoid bloating storage
      if (content.length > MAX_SKILL_CHARS) {
        content = content.slice(0, MAX_SKILL_CHARS) + "\n\n[truncated]";
      }

      // Extract description from SKILL.md frontmatter or first paragraph
      const description = extractDescription(content, skillName);

      // Generate embedding for vector search
      let embedding: Float32Array = new Float32Array(0);
      if (this.apiKey) {
        try {
          embedding = await generateEmbedding(`${skillName}: ${description}`, this.apiKey) as Float32Array;
        } catch (err) {
          console.log(`skill_install: embedding generation failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Save to installed_skills
      const id = store.install({
        serviceId,
        name: skillName,
        description,
        content,
        embedding,
        sourceUrl: githubUrl,
      });

      console.log(`skill_install: installed "${skillName}" (id=${id}, ${content.length} chars) from ${githubUrl}`);

      return {
        success: true,
        output: `Skill "${skillName}" installed (${content.length} chars). It is now in your knowledge base — search for "skill:${skillName}" to recall it. Follow the instructions in the skill to use it.`,
      };
    } catch (err) {
      return {
        success: false,
        output: "Error downloading skill",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Extract a short description from SKILL.md content.
 * Tries frontmatter `description:` field first, then falls back to first non-heading paragraph.
 */
function extractDescription(content: string, fallback: string): string {
  // Try frontmatter
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const descMatch = fmMatch[1].match(/description:\s*(.+)/i);
    if (descMatch) return descMatch[1].trim().slice(0, 200);
  }

  // Fall back to first non-empty, non-heading line
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("---") && trimmed.length > 10) {
      return trimmed.slice(0, 200);
    }
  }

  return fallback;
}

/**
 * Convert a GitHub tree/blob URL to a raw SKILL.md URL.
 * e.g. https://github.com/aviz85/claude-skills-library/tree/main/skills/image-generation
 *   -> https://raw.githubusercontent.com/aviz85/claude-skills-library/main/skills/image-generation/SKILL.md
 */
function toRawUrl(url: string): string | null {
  const match = url.match(
    /github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)/,
  );
  if (!match) return null;
  const [, owner, repo, branch, path] = match;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}/SKILL.md`;
}
