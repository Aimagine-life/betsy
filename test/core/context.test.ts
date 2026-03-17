import { describe, it, expect } from "vitest";
import { ContextManager } from "../../src/core/context.js";
import type { LLMMessage } from "../../src/llm/types.js";

describe("ContextManager", () => {
  describe("estimateTokens", () => {
    it("estimates 1 token per 4 characters", () => {
      const cm = new ContextManager({ maxTokens: 1000 });
      expect(cm.estimateTokens("abcd")).toBe(1);
      expect(cm.estimateTokens("abcde")).toBe(2); // ceil(5/4)
      expect(cm.estimateTokens("")).toBe(0);
    });
  });

  describe("trimMessages", () => {
    it("returns empty array for empty input", () => {
      const cm = new ContextManager({ maxTokens: 100 });
      expect(cm.trimMessages([])).toEqual([]);
    });

    it("keeps all messages when within budget", () => {
      const cm = new ContextManager({ maxTokens: 1000 });
      const msgs: LLMMessage[] = [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
      ];
      const trimmed = cm.trimMessages(msgs);
      expect(trimmed).toHaveLength(3);
    });

    it("always preserves system messages", () => {
      const cm = new ContextManager({ maxTokens: 50 });
      const msgs: LLMMessage[] = [
        { role: "system", content: "System prompt." },
        { role: "user", content: "A".repeat(100) },
        { role: "assistant", content: "B".repeat(100) },
        { role: "user", content: "Short" },
      ];
      const trimmed = cm.trimMessages(msgs);

      // System message must always be present
      expect(trimmed[0].role).toBe("system");
      expect(trimmed[0].content).toBe("System prompt.");
    });

    it("keeps most recent messages and drops older ones", () => {
      // Budget: 30 tokens = 120 chars. System uses ~14 chars (4 tokens).
      // Remaining budget: ~26 tokens = 104 chars.
      const cm = new ContextManager({ maxTokens: 30 });
      const msgs: LLMMessage[] = [
        { role: "system", content: "Sys." },           // 1 token
        { role: "user", content: "A".repeat(80) },     // 20 tokens
        { role: "assistant", content: "B".repeat(80) }, // 20 tokens
        { role: "user", content: "C".repeat(40) },     // 10 tokens
        { role: "assistant", content: "D".repeat(40) }, // 10 tokens
      ];

      const trimmed = cm.trimMessages(msgs);

      // System + last two messages (10 + 10 = 20 tokens, within 29 budget)
      expect(trimmed[0].role).toBe("system");
      // The oldest conversation messages should be dropped
      const contents = trimmed.map((m) =>
        typeof m.content === "string" ? m.content : "",
      );
      expect(contents).not.toContain("A".repeat(80));
      // Most recent messages should be present
      expect(contents).toContain("D".repeat(40));
    });

    it("returns only system messages when budget is exhausted by them", () => {
      const cm = new ContextManager({ maxTokens: 5 });
      const msgs: LLMMessage[] = [
        { role: "system", content: "A".repeat(100) }, // 25 tokens > 5 budget
        { role: "user", content: "Hello" },
      ];
      const trimmed = cm.trimMessages(msgs);
      expect(trimmed).toHaveLength(1);
      expect(trimmed[0].role).toBe("system");
    });

    it("handles messages with content block arrays", () => {
      const cm = new ContextManager({ maxTokens: 1000 });
      const msgs: LLMMessage[] = [
        { role: "system", content: "Sys." },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hello there!" }],
        },
        { role: "user", content: "Thanks" },
      ];
      const trimmed = cm.trimMessages(msgs);
      expect(trimmed).toHaveLength(3);
    });
  });
});
