import { describe, it, expect } from "vitest"
import { WebTool } from "../../src/core/tools/web.js"

describe("WebTool", () => {
  it("has correct name and actions", () => {
    const tool = new WebTool({ apiKey: "test", cx: "test" })
    expect(tool.name).toBe("web")
    expect(tool.parameters.find(p => p.name === "action")).toBeTruthy()
  })

  it("returns error when action is missing", async () => {
    const tool = new WebTool({ apiKey: "test", cx: "test" })
    const result = await tool.execute({})
    expect(result.success).toBe(false)
    expect(result.error).toContain("action")
  })

  it("returns error when search query is missing", async () => {
    const tool = new WebTool({ apiKey: "test", cx: "test" })
    const result = await tool.execute({ action: "search" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("query")
  })

  it("returns error when read url is missing", async () => {
    const tool = new WebTool({ apiKey: "test", cx: "test" })
    const result = await tool.execute({ action: "read" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("url")
  })

  it("truncates output to MAX_OUTPUT_CHARS", async () => {
    expect(WebTool.MAX_READ_CHARS).toBe(4000)
    expect(WebTool.MAX_SEARCH_CHARS).toBe(2000)
  })
})
