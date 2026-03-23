import type { Tool, ToolResult } from "./types.js";

export interface SkillSearchConfig {
  apiKey: string;
}

interface SkillHit {
  id: string;
  name: string;
  author: string;
  description: string;
  githubUrl: string;
  stars: number;
  updatedAt: string;
}

export class SkillSearchTool implements Tool {
  name = "skill_search";
  description =
    "Search the SkillsMP marketplace for agent skills. Use when you need a new capability (image generation, web scraping, etc.) and want to find an existing skill to install. Returns a list of matching skills with descriptions.";
  parameters = [
    { name: "query", type: "string", description: "What capability to search for (e.g. 'image generation', 'web scraping', 'code review')", required: true },
    { name: "semantic", type: "boolean", description: "Use AI semantic search instead of keyword search (slower but smarter). Default: false" },
  ];

  private apiKey: string;

  constructor(config: SkillSearchConfig) {
    this.apiKey = config.apiKey;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const query = String(params.query ?? "").trim();
    if (!query) {
      return { success: false, output: "Missing required parameter: query" };
    }

    const semantic = params.semantic === true || params.semantic === "true";
    const endpoint = semantic ? "ai-search" : "search";
    const url = `https://skillsmp.com/api/v1/skills/${endpoint}?q=${encodeURIComponent(query)}&limit=5`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errText = await response.text();
        return { success: false, output: `SkillsMP API error: ${response.status}`, error: errText.slice(0, 300) };
      }

      const json = await response.json() as Record<string, unknown>;
      const skills = extractSkills(json, semantic);

      if (skills.length === 0) {
        return { success: true, output: `No skills found for "${query}". Try a different search query.` };
      }

      const lines = skills.map((s, i) =>
        `${i + 1}. **${s.name}** by ${s.author} (${s.stars} stars)\n   ${s.description}\n   GitHub: ${s.githubUrl}`,
      );

      return {
        success: true,
        output: `Found ${skills.length} skills for "${query}":\n\n${lines.join("\n\n")}\n\nTo install a skill, use skill_install with the GitHub URL.`,
      };
    } catch (err) {
      return {
        success: false,
        output: "Error searching SkillsMP",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function extractSkills(json: Record<string, unknown>, semantic: boolean): SkillHit[] {
  const data = json.data as Record<string, unknown> | undefined;
  if (!data) return [];

  if (semantic) {
    const items = data.data as Array<{ skill?: SkillHit }> | undefined;
    return items?.map((item) => item.skill).filter(Boolean) as SkillHit[] ?? [];
  }

  const items = (data as { skills?: SkillHit[] }).skills;
  return items ?? [];
}
