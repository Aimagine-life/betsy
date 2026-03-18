import { describe, it, expect } from "vitest"
import { HttpTool } from "../../src/core/tools/http.js"

describe("HttpTool", () => {
  it("has updated description mentioning API calls", () => {
    const tool = new HttpTool()
    expect(tool.description).toContain("API")
  })

  it("has MAX_OUTPUT_CHARS constant", () => {
    expect(HttpTool.MAX_OUTPUT_CHARS).toBe(8000)
  })
})
