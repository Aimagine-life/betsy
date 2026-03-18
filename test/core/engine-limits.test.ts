import { describe, it, expect } from "vitest"

describe("engine runaway protection", () => {
  it("MAX_PROMPT_TOKENS is defined as 50000", async () => {
    const engine = await import("../../src/core/engine.js")
    expect((engine as any).MAX_PROMPT_TOKENS).toBe(50_000)
  })

  it("MAX_SAME_TOOL is defined as 5", async () => {
    const engine = await import("../../src/core/engine.js")
    expect((engine as any).MAX_SAME_TOOL).toBe(5)
  })
})
