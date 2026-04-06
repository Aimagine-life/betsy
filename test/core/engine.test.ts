import { describe, it, expect, vi } from "vitest";
import { Engine } from "../../src/core/engine.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";

function mockLLM(responseText: string) {
  return {
    fast: () => ({
      chat: vi.fn().mockResolvedValue({ text: responseText, stopReason: "end_turn" }),
    }),
    strong: () => ({
      chat: vi.fn().mockResolvedValue({ text: responseText, stopReason: "end_turn" }),
    }),
  };
}

const testConfig = {
  name: "Бетси",
  personality: { tone: "friendly", responseStyle: "concise" },
};

describe("Engine", () => {
  it("processes message and returns response", async () => {
    const engine = new Engine({ llm: mockLLM("Привет!"), config: testConfig, tools: new ToolRegistry(), contextBudget: 40000 });
    const res = await engine.process({
      channelName: "test",
      userId: "1",
      text: "Привет",
      timestamp: Date.now(),
    });
    expect(res.text).toBe("Привет!");
  });

  it("handles LLM errors gracefully", async () => {
    const llm = {
      fast: () => ({
        chat: vi.fn().mockRejectedValue(new Error("API down")),
      }),
      strong: () => ({ chat: vi.fn() }),
    };
    const engine = new Engine({ llm, config: testConfig, tools: new ToolRegistry(), contextBudget: 40000 });
    const res = await engine.process({
      channelName: "test",
      userId: "1",
      text: "Hello",
      timestamp: Date.now(),
    });
    // Engine returns a friendly natural-language fallback (no raw error exposed)
    expect(res.text).toBeTruthy();
    expect(res.text).not.toContain("API down");
  });

  it("executes tool calls in agentic loop", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "test_tool",
      description: "A test tool",
      parameters: [{ name: "input", type: "string", description: "Input value", required: true }],
      async execute(params) {
        return { success: true, output: `Got: ${params.input}` };
      },
    });

    // First call: LLM requests a tool, second call: LLM responds with text
    const chatMock = vi.fn()
      .mockResolvedValueOnce({
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "call_1", name: "test_tool", arguments: { input: "hello" } }],
      })
      .mockResolvedValueOnce({
        text: "Результат: Got: hello",
        stopReason: "end_turn",
      });

    const llm = {
      fast: () => ({ chat: chatMock }),
      strong: () => ({ chat: chatMock }),
    };

    const engine = new Engine({ llm, config: testConfig, tools, contextBudget: 40000 });
    const res = await engine.process({
      channelName: "test",
      userId: "1",
      text: "Use the test tool",
      timestamp: Date.now(),
    });

    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(res.text).toContain("Got: hello");
  });
});
