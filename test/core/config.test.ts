import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig, saveConfig, configSchema } from "../../src/core/config.js";

describe("core/config", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "betsy-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadConfig returns null when no config file exists", () => {
    const result = loadConfig(path.join(tmpDir, "nonexistent.yaml"));
    expect(result).toBeNull();
  });

  it("save + load roundtrip preserves config", () => {
    const configPath = path.join(tmpDir, "config.yaml");
    const config = configSchema.parse({
      agent: { name: "test-agent", personality: "sarcastic" },
      llm: { provider: "openai", api_key: "sk-test", fast_model: "gpt-4o", strong_model: "gpt-4o" },
      channels: { max: 3 },
      plugins: ["foo", "bar"],
    });

    saveConfig(config, configPath);
    const loaded = loadConfig(configPath);

    expect(loaded).not.toBeNull();
    expect(loaded!.agent.name).toBe("test-agent");
    expect(loaded!.agent.personality).toBe("sarcastic");
    expect(loaded!.llm.provider).toBe("openai");
    expect(loaded!.llm.api_key).toBe("sk-test");
    expect(loaded!.channels.max).toBe(3);
    expect(loaded!.plugins).toEqual(["foo", "bar"]);
  });

  it("Zod rejects invalid config", () => {
    expect(() =>
      configSchema.parse({
        channels: { max: -1 },
      }),
    ).toThrow();
  });
});
