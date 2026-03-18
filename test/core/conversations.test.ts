import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import {
  saveMessage,
  loadHistory,
  saveSummary,
  loadSummary,
  extractText,
} from "../../src/core/memory/conversations.js";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";

describe("conversations", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `betsy-conv-test-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {}
    }
  });

  describe("saveMessage + loadHistory", () => {
    it("saves and loads a simple user message", () => {
      saveMessage("user1", "telegram", "user", "Hello!");
      const { messages } = loadHistory("user1");
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("Hello!");
    });

    it("saves and loads an assistant message with tool calls", () => {
      saveMessage("user1", "telegram", "user", "Do something");
      const toolCalls = [{ id: "tc1", name: "shell", arguments: { cmd: "ls" } }];
      saveMessage("user1", "telegram", "assistant", "", undefined, toolCalls);
      // Add a tool result so the assistant message is not trimmed as a dangling tail
      saveMessage("user1", "telegram", "tool", "result data", "tc1");
      saveMessage("user1", "telegram", "assistant", "Done!");
      const { messages } = loadHistory("user1");
      expect(messages).toHaveLength(4);
      const assistant = messages[1];
      expect(assistant.role).toBe("assistant");
      expect(assistant.toolCalls).toEqual(toolCalls);
    });

    it("saves and loads a tool result with toolCallId", () => {
      saveMessage("user1", "telegram", "user", "Do something");
      const toolCalls = [{ id: "tc1", name: "shell", arguments: { cmd: "ls" } }];
      saveMessage("user1", "telegram", "assistant", "", undefined, toolCalls);
      saveMessage("user1", "telegram", "tool", "file1\nfile2", "tc1");
      const { messages } = loadHistory("user1");
      expect(messages).toHaveLength(3);
      const toolMsg = messages[2];
      expect(toolMsg.role).toBe("tool");
      expect(toolMsg.toolCallId).toBe("tc1");
      expect(toolMsg.content).toBe("file1\nfile2");
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        saveMessage("user1", "telegram", "user", `Message ${i}`);
      }
      const { messages } = loadHistory("user1", 5);
      expect(messages).toHaveLength(5);
      // Should be the last 5 messages
      expect(messages[4].content).toBe("Message 9");
    });

    it("isolates messages by user_id", () => {
      saveMessage("user1", "telegram", "user", "Hello from user1");
      saveMessage("user2", "telegram", "user", "Hello from user2");
      const { messages: msgs1 } = loadHistory("user1");
      const { messages: msgs2 } = loadHistory("user2");
      expect(msgs1).toHaveLength(1);
      expect(msgs1[0].content).toBe("Hello from user1");
      expect(msgs2).toHaveLength(1);
      expect(msgs2[0].content).toBe("Hello from user2");
    });

    it("trims orphaned tool messages at start", () => {
      // Insert tool message first (orphan at start), then user message
      saveMessage("user1", "telegram", "tool", "orphan tool result", "tc-orphan");
      saveMessage("user1", "telegram", "user", "Real start");
      const { messages } = loadHistory("user1");
      // Should start with user message, not orphan tool
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("Real start");
    });

    it("trims trailing assistant with toolCalls but no following tool results", () => {
      saveMessage("user1", "telegram", "user", "Do something");
      const toolCalls = [{ id: "tc1", name: "shell", arguments: { cmd: "ls" } }];
      // Assistant with toolCalls but no following tool result
      saveMessage("user1", "telegram", "assistant", "", undefined, toolCalls);
      const { messages } = loadHistory("user1");
      // Should trim the dangling assistant tool-call message
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
    });

    it("skips corrupt JSON rows in tool_calls", () => {
      saveMessage("user1", "telegram", "user", "Hello");
      // Insert a row with corrupt tool_calls directly
      const db = getDB(dbPath);
      db.prepare(
        "INSERT INTO conversations (user_id, channel, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("user1", "telegram", "assistant", "response", "NOT VALID JSON{{{", Math.floor(Date.now() / 1000));
      saveMessage("user1", "telegram", "user", "After corrupt");
      const { messages } = loadHistory("user1");
      // Corrupt row should be skipped; we expect at least the two valid messages
      const roles = messages.map(m => m.role);
      expect(roles).not.toContain(undefined);
      // The corrupt assistant row should be skipped
      for (const msg of messages) {
        if (msg.role === "assistant") {
          // If any assistant message sneaked through, it shouldn't have broken toolCalls
          expect(msg.toolCalls).toBeUndefined();
        }
      }
      // We should have valid user messages
      const userMsgs = messages.filter(m => m.role === "user");
      expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("saveSummary + loadSummary", () => {
    it("saves and loads a summary", () => {
      saveSummary("user1", "User likes TypeScript", 150);
      const result = loadSummary("user1");
      expect(result).not.toBeNull();
      expect(result!.summary).toBe("User likes TypeScript");
      expect(result!.tokenEstimate).toBe(150);
    });

    it("upserts on duplicate user_id", () => {
      saveSummary("user1", "First summary", 100);
      saveSummary("user1", "Updated summary", 200);
      const result = loadSummary("user1");
      expect(result!.summary).toBe("Updated summary");
      expect(result!.tokenEstimate).toBe(200);
    });

    it("returns null for nonexistent user", () => {
      const result = loadSummary("nonexistent-user");
      expect(result).toBeNull();
    });

    it("loadHistory includes summary when one exists", () => {
      saveSummary("user1", "User prefers brevity", 50);
      saveMessage("user1", "telegram", "user", "Hi");
      const { messages, summary } = loadHistory("user1");
      expect(summary).toBe("User prefers brevity");
      expect(messages).toHaveLength(1);
    });

    it("loadHistory returns null summary when none exists", () => {
      saveMessage("user1", "telegram", "user", "Hi");
      const { summary } = loadHistory("user1");
      expect(summary).toBeNull();
    });
  });

  describe("extractText", () => {
    it("returns string as-is", () => {
      expect(extractText("hello world")).toBe("hello world");
    });

    it("extracts text from ContentPart array", () => {
      const parts = [
        { type: "text" as const, text: "Hello " },
        { type: "image_url" as const, image_url: { url: "http://example.com/img.png" } },
        { type: "text" as const, text: "world" },
      ];
      expect(extractText(parts)).toBe("Hello world");
    });

    it("returns empty string for empty ContentPart array", () => {
      expect(extractText([])).toBe("");
    });

    it("returns empty string for array with no text parts", () => {
      const parts = [
        { type: "image_url" as const, image_url: { url: "http://example.com/img.png" } },
      ];
      expect(extractText(parts)).toBe("");
    });
  });
});
