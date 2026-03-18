import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// Flexible schema that accepts both old and new config formats
const personalitySchema = z.union([
  z.string(),
  z.object({
    tone: z.string().optional(),
    style: z.string().optional(),
    custom_instructions: z.string().optional(),
  }),
]).optional();

const llmProviderSchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
  api_key: z.string(),
});

const llmSchema = z.union([
  // New flat format
  z.object({
    provider: z.string(),
    api_key: z.string(),
    fast_model: z.string().optional(),
    strong_model: z.string().optional(),
  }),
  // Old nested format (fast/strong)
  z.object({
    fast: llmProviderSchema.optional(),
    strong: llmProviderSchema.optional(),
  }),
]);

const configSchema = z.object({
  agent: z.object({
    name: z.string().default("Betsy"),
    personality: personalitySchema,
  }).default({ name: "Betsy" }),

  security: z.object({
    password_hash: z.string().optional(),
    tools: z.object({
      shell: z.boolean().default(true),
      ssh: z.boolean().default(false),
      browser: z.boolean().default(true),
      npm_install: z.boolean().default(true),
    }).optional(),
  }).optional(),

  llm: llmSchema.optional(),

  telegram: z.object({
    token: z.string(),
    streaming: z.boolean().optional(),
    owner_id: z.number().optional(),
  }).optional(),

  channels: z.record(z.string(), z.any()).optional(),

  memory: z.object({
    max_knowledge: z.number().default(200),
    study_interval_min: z.number().default(30),
    learning_enabled: z.boolean().default(true),
    context_budget: z.number().default(40000),
  }).default({}),

  plugins: z.array(z.string()).default([]),

  voice: z.record(z.string(), z.any()).optional(),
  video: z.record(z.string(), z.any()).optional(),
  selfies: z.record(z.string(), z.any()).optional(),
  sync_so: z.record(z.string(), z.any()).optional(),
  google: z.object({
    api_key: z.string(),
    cx: z.string(),
  }).optional(),
}).passthrough(); // Allow extra fields

export type BetsyConfig = z.infer<typeof configSchema>;

export function getConfigDir(): string {
  return path.join(os.homedir(), ".betsy");
}

export function getConfigPath(customPath?: string): string {
  return customPath ?? path.join(getConfigDir(), "config.yaml");
}

/**
 * Convert a flat config (written by self_config tool) to the nested format
 * expected by the zod schema. Handles both flat and already-nested configs.
 */
function normalizeConfig(raw: Record<string, unknown>): Record<string, unknown> {
  // If it's already nested (agent is an object), return as-is
  if (raw.agent && typeof raw.agent === "object") return raw;

  // Flat format → nested
  const out: Record<string, unknown> = {};

  // agent
  out.agent = {
    name: raw.name ?? "Betsy",
    personality: {
      tone: raw.tone,
      style: raw.style,
      custom_instructions: raw.custom_instructions,
      response_style: raw.response_style,
    },
  };

  // telegram
  if (raw.token) {
    out.telegram = {
      token: raw.token,
      streaming: raw.streaming,
      owner_id: raw.owner_id,
    };
  }

  // llm — detect nested (fast/strong providers) vs flat
  if (raw.api_key || raw.provider) {
    out.llm = {
      fast: {
        provider: raw.provider ?? "openrouter",
        model: raw.model ?? raw.fast_model,
        api_key: raw.api_key,
      },
      strong: {
        provider: raw.provider ?? "openrouter",
        model: raw.strong_model ?? raw.model,
        api_key: raw.api_key,
      },
    };
  }

  // memory
  out.memory = {
    max_knowledge: raw.max_knowledge ?? 200,
    study_interval_min: raw.study_interval_min ?? 30,
    learning_enabled: raw.learning_enabled ?? true,
    context_budget: raw.context_budget ?? 40000,
  };

  // voice
  if (raw.tts_provider || raw.voice_id) {
    out.voice = {
      tts_provider: raw.tts_provider,
      voice_id: raw.voice_id,
      speed: raw.speed,
      pitch: raw.pitch,
      emotion: raw.emotion,
      openai_key: raw.openai_key,
    };
  }

  // selfies (fal.ai)
  if (raw.fal_api_key || raw.reference_photo_url) {
    out.selfies = {
      fal_api_key: raw.fal_api_key,
      reference_photo_url: raw.reference_photo_url,
    };
  }

  // plugins
  if (typeof raw.plugins === "string") {
    try { out.plugins = JSON.parse(raw.plugins); } catch { out.plugins = []; }
  } else if (Array.isArray(raw.plugins)) {
    out.plugins = raw.plugins;
  }

  return out;
}

export function loadConfig(customPath?: string): BetsyConfig | null {
  const filePath = getConfigPath(customPath);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== "object") return null;

  const normalized = normalizeConfig(parsed as Record<string, unknown>);

  const result = configSchema.safeParse(normalized);
  if (!result.success) {
    console.error("Config validation warnings:", result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", "));
    // Best-effort: strip invalid fields and retry
    for (const issue of result.error.issues) {
      let obj: Record<string, unknown> = normalized;
      const path = issue.path.slice(0, -1);
      const key = issue.path[issue.path.length - 1];
      for (const p of path) obj = obj[p] as Record<string, unknown>;
      if (obj && key !== undefined) delete obj[key as string];
    }
    return configSchema.parse(normalized);
  }
  return result.data;
}

export function saveConfig(config: BetsyConfig, customPath?: string): void {
  const filePath = getConfigPath(customPath);
  const dir = path.dirname(filePath);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, stringifyYaml(config));
}

/** Check if a config file exists and has LLM credentials */
export function isConfigured(customPath?: string): boolean {
  const config = loadConfig(customPath);
  if (!config) return false;
  if (!config.llm) return false;
  return true;
}

/** Get LLM API key from either config format */
export function getLLMApiKey(config: BetsyConfig): string | null {
  if (!config.llm) return null;
  if ("api_key" in config.llm) return config.llm.api_key;
  if ("fast" in config.llm && config.llm.fast) return config.llm.fast.api_key;
  if ("strong" in config.llm && config.llm.strong) return config.llm.strong.api_key;
  return null;
}

/** Get agent name */
export function getAgentName(config: BetsyConfig): string {
  return config.agent?.name ?? "Betsy";
}

/** Get personality as structured object */
export function getPersonality(config: BetsyConfig): {
  tone?: string;
  style?: string;
  customInstructions?: string;
} {
  const p = config.agent?.personality;
  if (!p) return {};
  if (typeof p === "string") return { customInstructions: p };
  return {
    tone: p.tone,
    style: p.style,
    customInstructions: p.custom_instructions,
  };
}

export { configSchema };
