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
  }).optional(),

  plugins: z.array(z.string()).default([]),

  voice: z.record(z.string(), z.any()).optional(),
  video: z.record(z.string(), z.any()).optional(),
  selfies: z.record(z.string(), z.any()).optional(),
  sync_so: z.record(z.string(), z.any()).optional(),
}).passthrough(); // Allow extra fields

export type BetsyConfig = z.infer<typeof configSchema>;

export function getConfigDir(): string {
  return path.join(os.homedir(), ".betsy");
}

export function getConfigPath(customPath?: string): string {
  return customPath ?? path.join(getConfigDir(), "config.yaml");
}

export function loadConfig(customPath?: string): BetsyConfig | null {
  const filePath = getConfigPath(customPath);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== "object") return null;

  return configSchema.parse(parsed);
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
