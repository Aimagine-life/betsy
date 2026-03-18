import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Engine } from "../../src/core/engine.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import { loadHistory } from "../../src/core/memory/conversations.js";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";

function mockLLM(responseText: string) {
  return {
    fast: () => ({
      chat: vi.fn().mockResolvedValue({ text: responseText, stopReason: "end_turn", usage: { promptTokens: 100, completionTokens: 20 } }),
      chatStream: vi.fn().mockResolvedValue({ text: responseText, stopReason: "end_turn", usage: { promptTokens: 100, completionTokens: 20 } }),
    }),
    strong: () => ({
      chat: vi.fn().mockResolvedValue({ text: responseText, stopReason: "end_turn" }),
      chatStream: vi.fn(),
    }),
  };
}

const testConfig = { name: "Бетси", personality: { tone: "friendly", responseStyle: "concise" } };

describe("Engine Persistence", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `betsy-eng-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it("persists user and assistant messages to DB", async () => {
    const engine = new Engine({ llm: mockLLM("Привет!"), config: testConfig, tools: new ToolRegistry(), contextBudget: 40000 });
    await engine.process({ channelName: "test", userId: "u1", text: "Hello", timestamp: Date.now() });
    const { messages } = loadHistory("u1");
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("loads history from DB on restart (new Engine instance)", async () => {
    const engine1 = new Engine({ llm: mockLLM("Reply 1"), config: testConfig, tools: new ToolRegistry(), contextBudget: 40000 });
    await engine1.process({ channelName: "test", userId: "u1", text: "First msg", timestamp: Date.now() });

    const mockChat = vi.fn().mockResolvedValue({ text: "Reply 2", stopReason: "end_turn", usage: { promptTokens: 200, completionTokens: 20 } });
    const engine2 = new Engine({
      llm: { fast: () => ({ chat: mockChat, chatStream: mockChat }), strong: () => ({ chat: vi.fn(), chatStream: vi.fn() }) },
      config: testConfig, tools: new ToolRegistry(), contextBudget: 40000,
    });
    await engine2.process({ channelName: "test", userId: "u1", text: "Second msg", timestamp: Date.now() });
    const callMessages = mockChat.mock.calls[0][0];
    expect(callMessages.length).toBeGreaterThan(2);
  });

  it("getHistory returns DB-backed history after restart", async () => {
    const engine1 = new Engine({ llm: mockLLM("Hi"), config: testConfig, tools: new ToolRegistry(), contextBudget: 40000 });
    await engine1.process({ channelName: "test", userId: "u1", text: "Hello", timestamp: Date.now() });
    const engine2 = new Engine({ llm: mockLLM(""), config: testConfig, tools: new ToolRegistry(), contextBudget: 40000 });
    const history = engine2.getHistory("u1");
    expect(history.length).toBe(2);
  });
});
