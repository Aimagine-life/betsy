import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { loadConfig, getPersonality, getLLMApiKey, getAgentName } from "../../src/core/config.js";

const TEST_DIR = path.join(os.tmpdir(), `betsy-config-test-${Date.now()}`);

describe("Config", () => {
  beforeEach(() => fs.mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

  it("returns null when no config exists", () => {
    const config = loadConfig(path.join(TEST_DIR, "nonexistent.yaml"));
    expect(config).toBeNull();
  });

  it("loads old format config (nested llm)", () => {
    const configPath = path.join(TEST_DIR, "config.yaml");
    fs.writeFileSync(configPath, `
agent:
  name: Betsy
  personality:
    tone: friendly
    style: detailed
    custom_instructions: "Be helpful"
telegram:
  token: test-token
llm:
  fast:
    provider: openrouter
    model: google/gemini-2.5-flash
    api_key: sk-test-key
  strong:
    provider: openrouter
    model: anthropic/claude-sonnet-4
    api_key: sk-test-key
memory:
  max_knowledge: 200
  study_interval_min: 30
  learning_enabled: true
plugins: []
`);
    const config = loadConfig(configPath);
    expect(config).not.toBeNull();
    expect(getAgentName(config!)).toBe("Betsy");
    expect(getLLMApiKey(config!)).toBe("sk-test-key");
    expect(getPersonality(config!).tone).toBe("friendly");
    expect(getPersonality(config!).customInstructions).toBe("Be helpful");
    expect(config!.telegram?.token).toBe("test-token");
  });

  it("loads new format config (flat llm)", () => {
    const configPath = path.join(TEST_DIR, "config.yaml");
    fs.writeFileSync(configPath, `
agent:
  name: Test
llm:
  provider: openrouter
  api_key: sk-new-key
  fast_model: test/fast
  strong_model: test/strong
`);
    const config = loadConfig(configPath);
    expect(config).not.toBeNull();
    expect(getLLMApiKey(config!)).toBe("sk-new-key");
  });

  it("includes context_budget in memory schema with default 40000", () => {
    const tmpPath = path.join(os.tmpdir(), `betsy-cfg-${crypto.randomUUID()}.yaml`);
    fs.writeFileSync(tmpPath, "agent:\n  name: Test\nllm:\n  provider: openrouter\n  api_key: test\n");
    const config = loadConfig(tmpPath);
    fs.unlinkSync(tmpPath);
    expect(config?.memory?.context_budget).toBe(40000);
  });
});
