import { describe, it, expect } from "vitest";
import { isBillingError, isRateLimitError } from "../../src/core/llm/providers/openrouter";
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
