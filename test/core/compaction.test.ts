import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import { saveMessage, loadHistory, saveSummary, loadSummary } from "../../src/core/memory/conversations.js";
import { compactHistory } from "../../src/core/memory/compaction.js";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";

function mockLLM(summaryText: string) {
  return {
    chat: vi.fn().mockResolvedValue({
      text: summaryText,
      stopReason: "end_turn",
      usage: { promptTokens: 100, completionTokens: 50 },
    }),
    chatStream: vi.fn(),
  };
}

describe("Compaction", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `betsy-compact-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it("summarizes old messages and deletes them from DB", async () => {
    for (let i = 0; i < 10; i++) {
      saveMessage("u1", "tg", "user", `Question ${i}`);
      saveMessage("u1", "tg", "assistant", `Answer ${i}`);
    }
    const llm = mockLLM("Пользователь задал 10 вопросов и получил ответы.");
    await compactHistory("u1", llm);
    const s = loadSummary("u1");
    expect(s?.summary).toContain("10 вопросов");
    const { messages } = loadHistory("u1");
    expect(messages.length).toBeLessThan(20);
    expect(messages.length).toBeGreaterThan(0);
  });

  it("preserves existing summary in compaction prompt", async () => {
    saveSummary("u1", "Ранее обсуждали TypeScript", 30);
    for (let i = 0; i < 6; i++) {
      saveMessage("u1", "tg", "user", `msg ${i}`);
      saveMessage("u1", "tg", "assistant", `reply ${i}`);
    }
    const llm = mockLLM("Обновлённое саммари.");
    await compactHistory("u1", llm);
    const callArgs = llm.chat.mock.calls[0][0];
    const promptText = callArgs[0].content as string;
    expect(promptText).toContain("Ранее обсуждали TypeScript");
  });

  it("aborts compaction if LLM returns empty summary", async () => {
    for (let i = 0; i < 6; i++) {
      saveMessage("u1", "tg", "user", `msg ${i}`);
      saveMessage("u1", "tg", "assistant", `reply ${i}`);
    }
    const llm = mockLLM("   ");
    await expect(compactHistory("u1", llm)).rejects.toThrow("empty summary");
    const { messages } = loadHistory("u1");
    expect(messages.length).toBe(12);
  });

  it("splits at turn boundary", async () => {
    saveMessage("u1", "tg", "user", "Q1");
    saveMessage("u1", "tg", "assistant", "", undefined, [{ id: "tc1", name: "test", arguments: {} }]);
    saveMessage("u1", "tg", "tool", "result", "tc1");
    saveMessage("u1", "tg", "user", "Q2");
    saveMessage("u1", "tg", "assistant", "A2");
    saveMessage("u1", "tg", "user", "Q3");
    saveMessage("u1", "tg", "assistant", "A3");
    const llm = mockLLM("Summary of Q1 and tool use.");
    await compactHistory("u1", llm);
    const { messages } = loadHistory("u1");
    expect(messages[0].role).toBe("user");
  });
});
