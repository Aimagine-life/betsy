import { describe, it, expect, vi } from "vitest";
import { Engine } from "../../src/core/engine.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";

const testConfig = {
  name: "Бетси",
  personality: { tone: "friendly", responseStyle: "concise" },
};

describe("Engine mediaUrl propagation", () => {
  it("propagates mediaUrl from tool result to OutgoingMessage", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "selfie",
      description: "Generate selfie",
      parameters: [{ name: "context", type: "string", description: "Context", required: true }],
      async execute() {
        return { success: true, output: "Селфи сгенерировано", mediaUrl: "https://fal.media/test.jpg" };
      },
    });

    const chatMock = vi.fn()
      .mockResolvedValueOnce({
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "call_1", name: "selfie", arguments: { context: "на пляже" } }],
      })
      .mockResolvedValueOnce({
        text: "Вот моё селфи с пляжа!",
        stopReason: "end_turn",
      });

    const llm = {
      fast: () => ({ chat: chatMock }),
      strong: () => ({ chat: chatMock }),
    };

    const engine = new Engine({ llm: llm as any, config: testConfig, tools, contextBudget: 40000 });
    const res = await engine.process({
      channelName: "test",
      userId: "1",
      text: "Скинь селфи с пляжа",
      timestamp: Date.now(),
    });

    expect(res.text).toContain("селфи");
    expect(res.mediaUrl).toBe("https://fal.media/test.jpg");
  });

  it("returns no mediaUrl when tools don't produce one", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "shell",
      description: "Run shell",
      parameters: [{ name: "command", type: "string", description: "Command", required: true }],
      async execute() {
        return { success: true, output: "done" };
      },
    });

    const chatMock = vi.fn()
      .mockResolvedValueOnce({
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "call_1", name: "shell", arguments: { command: "echo hi" } }],
      })
      .mockResolvedValueOnce({
        text: "Готово",
        stopReason: "end_turn",
      });

    const llm = {
      fast: () => ({ chat: chatMock }),
      strong: () => ({ chat: chatMock }),
    };

    const engine = new Engine({ llm: llm as any, config: testConfig, tools, contextBudget: 40000 });
    const res = await engine.process({
      channelName: "test",
      userId: "1",
      text: "echo hi",
      timestamp: Date.now(),
    });

    expect(res.mediaUrl).toBeUndefined();
  });
});
