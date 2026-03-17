import { describe, it, expect } from "vitest";
import { Engine } from "../../src/core/engine.js";
import type { LLMClient, ToolRegistry } from "../../src/core/engine.js";
import type { Tool } from "../../src/core/tools/types.js";

function makeLLM(chatFn: LLMClient["chat"]): { fast(): LLMClient; strong(): LLMClient } {
  const client: LLMClient = { chat: chatFn };
  return { fast: () => client, strong: () => client };
}

function makeTools(toolMap: Record<string, Tool> = {}): ToolRegistry {
  const tools = Object.values(toolMap);
  return {
    list: () => tools,
    get: (name: string) => toolMap[name],
    getToolDefinitions: () => [],
  };
}

describe("Engine", () => {
  it("simple message — direct response, no tools", async () => {
    const llm = makeLLM(async () => ({ text: "\u041f\u0440\u0438\u0432\u0435\u0442!" }));
    const engine = new Engine({ llm, config: {}, tools: makeTools() });

    const res = await engine.process({
      channelName: "test",
      userId: "1",
      text: "\u041f\u0440\u0438\u0432\u0435\u0442",
      timestamp: Date.now(),
    });

    expect(res.text).toBe("\u041f\u0440\u0438\u0432\u0435\u0442!");
  });

  it("uses tool then responds", async () => {
    let callCount = 0;
    const llm = makeLLM(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          tool_calls: [{ name: "shell", arguments: { command: "echo 42" } }],
        };
      }
      return { text: "Result: 42" };
    });

    const mockTool: Tool = {
      name: "shell",
      description: "Run shell command",
      parameters: [],
      execute: async () => ({ success: true, output: "42" }),
    };

    const engine = new Engine({
      llm,
      config: {},
      tools: makeTools({ shell: mockTool }),
    });

    const res = await engine.process({
      channelName: "test",
      userId: "1",
      text: "Run echo",
      timestamp: Date.now(),
    });

    expect(res.text).toBe("Result: 42");
  });

  it("respects max turns", async () => {
    const llm = makeLLM(async () => ({
      tool_calls: [{ name: "shell", arguments: { command: "loop" } }],
    }));

    const mockTool: Tool = {
      name: "shell",
      description: "Run shell command",
      parameters: [],
      execute: async () => ({ success: true, output: "ok" }),
    };

    const engine = new Engine({
      llm,
      config: {},
      tools: makeTools({ shell: mockTool }),
    });

    const res = await engine.process({
      channelName: "test",
      userId: "1",
      text: "loop",
      timestamp: Date.now(),
    });

    expect(res.text).toContain("\u043b\u0438\u043c\u0438\u0442");
  });

  it("handles tool not found gracefully", async () => {
    let callCount = 0;
    const llm = makeLLM(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          tool_calls: [{ name: "unknown_tool", arguments: {} }],
        };
      }
      return { text: "Recovered" };
    });

    const engine = new Engine({ llm, config: {}, tools: makeTools() });

    const res = await engine.process({
      channelName: "test",
      userId: "1",
      text: "do something",
      timestamp: Date.now(),
    });

    expect(res.text).toBe("Recovered");
  });

  it("emits progress events", async () => {
    let callCount = 0;
    const llm = makeLLM(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          tool_calls: [{ name: "shell", arguments: { command: "echo hi" } }],
        };
      }
      return { text: "Done" };
    });

    const mockTool: Tool = {
      name: "shell",
      description: "Run shell command",
      parameters: [],
      execute: async () => ({ success: true, output: "hello" }),
    };

    const progress: string[] = [];
    const engine = new Engine({
      llm,
      config: {},
      tools: makeTools({ shell: mockTool }),
    });
    engine.onProgress((s) => progress.push(s));

    await engine.process({
      channelName: "test",
      userId: "1",
      text: "hi",
      timestamp: Date.now(),
    });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some((p) => p.includes("shell"))).toBe(true);
  });

  it("handles tool execution errors", async () => {
    let callCount = 0;
    const llm = makeLLM(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          tool_calls: [{ name: "broken", arguments: {} }],
        };
      }
      return { text: "Error handled" };
    });

    const brokenTool: Tool = {
      name: "broken",
      description: "A broken tool",
      parameters: [],
      execute: async () => {
        throw new Error("kaboom");
      },
    };

    const engine = new Engine({
      llm,
      config: {},
      tools: makeTools({ broken: brokenTool }),
    });

    const res = await engine.process({
      channelName: "test",
      userId: "1",
      text: "break it",
      timestamp: Date.now(),
    });

    expect(res.text).toBe("Error handled");
  });
});
