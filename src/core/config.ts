import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const toolsSchema = z.object({
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
});

const configSchema = z.object({
  agent: z
    .object({
      name: z.string().default("betsy"),
      personality: z.string().default("helpful assistant"),
    })
    .default(() => ({ name: "betsy", personality: "helpful assistant" })),
  security: z
    .object({
      password_hash: z.string().optional(),
      tools: toolsSchema.default(() => ({ allow: [], deny: [] })),
    })
    .default(() => ({ tools: { allow: [], deny: [] } })),
  llm: z
    .object({
      provider: z.string().default("anthropic"),
      api_key: z.string().default(""),
      fast_model: z.string().default("claude-sonnet-4-20250514"),
      strong_model: z.string().default("claude-opus-4-20250514"),
    })
    .default(() => ({
      provider: "anthropic",
      api_key: "",
      fast_model: "claude-sonnet-4-20250514",
      strong_model: "claude-opus-4-20250514",
    })),
  channels: z
    .object({
      browser: z.record(z.string(), z.string()).default({}),
      telegram: z.record(z.string(), z.string()).default({}),
      max: z.number().int().positive().default(5),
    })
    .default(() => ({ browser: {}, telegram: {}, max: 5 })),
  plugins: z.array(z.string()).default([]),
});

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
  return configSchema.parse(parsed);
}

export function saveConfig(config: BetsyConfig, customPath?: string): void {
  const filePath = getConfigPath(customPath);
  const dir = path.dirname(filePath);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, stringifyYaml(config));
}

export { configSchema };
