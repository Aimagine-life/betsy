import { describe, it, expect, vi } from "vitest";
import { Engine } from "../../src/core/engine.js";

function mockLLM(responseText: string) {
  return {
    fast: () => ({
      chat: vi.fn().mockResolvedValue({ text: responseText }),
    }),
    strong: () => ({
      chat: vi.fn().mockResolvedValue({ text: responseText }),
    }),
  };
}

const testConfig = {
  name: "Бетси",
  personality: { tone: "friendly", responseStyle: "concise" },
};

describe("Engine", () => {
  it("processes message and returns response", async () => {
    const engine = new Engine({ llm: mockLLM("Привет!"), config: testConfig });
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
    const engine = new Engine({ llm, config: testConfig });
    const res = await engine.process({
      channelName: "test",
      userId: "1",
      text: "Hello",
      timestamp: Date.now(),
    });
    expect(res.text).toContain("Ошибка LLM");
  });
});
