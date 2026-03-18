import { describe, it, expect } from "vitest";
import { isBillingError, isRateLimitError } from "../../src/core/llm/providers/openrouter";
import { LLMRouter } from "../../src/core/llm/router";
import type { LLMClient, LLMResponse, LLMMessage, ToolDefinition, StreamCallback } from "../../src/core/llm/types";
import OpenAI from "openai";

describe("error classification", () => {
  it("detects 402 as billing error", () => {
    const err = new OpenAI.APIError(402, { message: "Payment required" }, "Payment required", {});
    expect(isBillingError(err)).toBe(true);
  });

  it("detects 429 with insufficient_quota as billing error", () => {
    const err = new OpenAI.APIError(429, { message: "insufficient_quota: you have run out of credits" }, "insufficient_quota", {});
    expect(isBillingError(err)).toBe(true);
  });

  it("detects 403 with billing message as billing error", () => {
    const err = new OpenAI.APIError(403, { message: "Your credits have been exhausted" }, "credits exhausted", {});
    expect(isBillingError(err)).toBe(true);
  });

  it("detects regular 429 as rate limit, not billing", () => {
    const err = new OpenAI.APIError(429, { message: "Rate limit exceeded" }, "Rate limit exceeded", {});
    expect(isBillingError(err)).toBe(false);
    expect(isRateLimitError(err)).toBe(true);
  });

  it("detects 404 as rate limit (dead model)", () => {
    const err = new OpenAI.APIError(404, { message: "Model not found" }, "Model not found", {});
    expect(isRateLimitError(err)).toBe(true);
  });

  it("does not classify 500 as billing or rate limit", () => {
    const err = new OpenAI.APIError(500, { message: "Internal server error" }, "Internal server error", {});
    expect(isBillingError(err)).toBe(false);
    expect(isRateLimitError(err)).toBe(false);
  });
});

function mockResponse(text: string): LLMResponse {
  return { text, stopReason: "end_turn" };
}

describe("LLMRouter fallback", () => {
  it("accepts fallback_models config and returns proxy clients", () => {
    const router = new LLMRouter({
      provider: "openrouter",
      api_key: "test-key",
      fast_model: "test/fast",
      strong_model: "test/strong",
      fallback_models: ["free/model-1", "free/model-2"],
    });
    const fast = router.fast();
    const strong = router.strong();
    expect(fast).toBeDefined();
    expect(strong).toBeDefined();
    expect(fast.chat).toBeTypeOf("function");
    expect(fast.chatStream).toBeTypeOf("function");
    router.destroy();
  });

  it("uses default fallback_models when not provided", () => {
    const router = new LLMRouter({
      provider: "openrouter",
      api_key: "test-key",
      fast_model: "test/fast",
      strong_model: "test/strong",
    });
    expect(router.fast()).toBeDefined();
    router.destroy();
  });

  it("exposes mode as normal initially", () => {
    const router = new LLMRouter({
      provider: "openrouter",
      api_key: "test-key",
      fast_model: "test/fast",
      strong_model: "test/strong",
    });
    expect(router.mode).toBe("normal");
    router.destroy();
  });
});

describe("LLMRouter proxy fallback with mocks", () => {
  function createTestRouter(opts: {
    primaryChat: (messages: LLMMessage[], tools?: ToolDefinition[]) => Promise<LLMResponse>;
    fallbackChat?: (messages: LLMMessage[], tools?: ToolDefinition[]) => Promise<LLMResponse>;
  }) {
    const router = new LLMRouter({
      provider: "openrouter",
      api_key: "test-key",
      fast_model: "test/fast",
      strong_model: "test/strong",
      fallback_models: ["free/model-1", "free/model-2"],
    });

    // Override createClient to inject mocks
    (router as any).createClient = (model: string): LLMClient => {
      const isMain = model === "test/fast" || model === "test/strong";
      const chatFn = isMain ? opts.primaryChat : (opts.fallbackChat ?? (async () => mockResponse("fallback response")));
      return {
        chat: chatFn,
        chatStream: async (msgs: LLMMessage[], onChunk: StreamCallback, tools?: ToolDefinition[]) => {
          const res = await chatFn(msgs, tools);
          if (res.text) onChunk(res.text);
          return res;
        },
      };
    };

    // Re-init delegates after overriding createClient
    (router as any).fastDelegate = (router as any).createClient("test/fast");
    (router as any).strongDelegate = (router as any).createClient("test/strong");

    return router;
  }

  it("switches to fallback on billing error and attaches notification", async () => {
    const router = createTestRouter({
      primaryChat: async () => {
        throw new OpenAI.APIError(402, { message: "Payment required" }, "Payment required", {});
      },
      fallbackChat: async () => mockResponse("fallback works"),
    });

    const fast = router.fast();
    const result = await fast.chat([{ role: "user", content: "hello" }]);
    expect(result.text).toContain("Баланс OpenRouter исчерпан");
    expect(result.text).toContain("fallback works");
    expect(router.mode).toBe("degraded");
    router.destroy();
  });

  it("tries next fallback on rate limit of current fallback", async () => {
    let fallbackCalls = 0;
    const router = createTestRouter({
      primaryChat: async () => {
        throw new OpenAI.APIError(402, { message: "Payment required" }, "Payment required", {});
      },
      fallbackChat: async () => {
        fallbackCalls++;
        if (fallbackCalls === 1) {
          throw new OpenAI.APIError(429, { message: "Rate limit exceeded" }, "Rate limit exceeded", {});
        }
        return mockResponse("second fallback works");
      },
    });

    const fast = router.fast();
    const result = await fast.chat([{ role: "user", content: "hello" }]);
    expect(result.text).toContain("second fallback works");
    expect(router.mode).toBe("degraded");
    router.destroy();
  });

  it("retries chatStream on pre-stream billing error (no chunks sent)", async () => {
    const router = createTestRouter({
      primaryChat: async () => {
        throw new OpenAI.APIError(402, { message: "Payment required" }, "Payment required", {});
      },
      fallbackChat: async () => mockResponse("stream fallback works"),
    });

    const fast = router.fast();
    const result = await fast.chatStream([{ role: "user", content: "hello" }], () => {}, []);
    expect(result.text).toContain("stream fallback works");
    expect(router.mode).toBe("degraded");
    router.destroy();
  });

  it("notification is only added once", async () => {
    const router = createTestRouter({
      primaryChat: async () => {
        throw new OpenAI.APIError(402, { message: "Payment required" }, "Payment required", {});
      },
      fallbackChat: async () => mockResponse("ok"),
    });

    const fast = router.fast();
    const r1 = await fast.chat([{ role: "user", content: "hello" }]);
    expect(r1.text).toContain("Баланс OpenRouter исчерпан");

    const r2 = await fast.chat([{ role: "user", content: "hello again" }]);
    expect(r2.text).toBe("ok");
    expect(r2.text).not.toContain("Баланс");
    router.destroy();
  });
});
