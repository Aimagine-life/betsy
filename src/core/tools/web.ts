import type { Tool, ToolResult } from "./types.js"

export interface WebToolConfig {
  apiKey: string
  cx: string
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n\n[truncated, showing first ${max} of ${text.length} chars]`
}

export class WebTool implements Tool {
  static readonly MAX_READ_CHARS = 4000
  static readonly MAX_SEARCH_CHARS = 2000

  readonly name = "web"
  readonly description = "Search the web and read web pages. Use 'search' to find information, 'read' to get page content as clean text. For interactive browsing (clicking, forms) use the 'browser' tool. For API calls use the 'http' tool."
  readonly parameters = [
    { name: "action", type: "string", description: "Action: search or read", required: true },
    { name: "query", type: "string", description: "Search query (for action=search)" },
    { name: "url", type: "string", description: "URL to read (for action=read)" },
  ]

  private config: WebToolConfig

  constructor(config: WebToolConfig) {
    this.config = config
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string | undefined
    if (!action) {
      return { success: false, output: "", error: "Missing required parameter: action (search or read)" }
    }

    switch (action) {
      case "search":
        return this.search(params.query as string | undefined)
      case "read":
        return this.read(params.url as string | undefined)
      default:
        return { success: false, output: "", error: `Unknown action: ${action}. Use 'search' or 'read'.` }
    }
  }

  private async search(query: string | undefined): Promise<ToolResult> {
    if (!query) {
      return { success: false, output: "", error: "Missing required parameter: query" }
    }

    try {
      const url = new URL("https://www.googleapis.com/customsearch/v1")
      url.searchParams.set("key", this.config.apiKey)
      url.searchParams.set("cx", this.config.cx)
      url.searchParams.set("q", query)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)

      const res = await fetch(url.toString(), { signal: controller.signal })
      clearTimeout(timer)

      if (!res.ok) {
        const text = await res.text()
        return { success: false, output: "", error: `Google Search API error ${res.status}: ${text.slice(0, 200)}` }
      }

      const data = await res.json() as {
        items?: Array<{ title: string; link: string; snippet: string }>
      }

      if (!data.items?.length) {
        return { success: true, output: "No results found." }
      }

      const formatted = data.items
        .slice(0, 10)
        .map((item, i) => `${i + 1}. ${item.title}\n   ${item.link}\n   ${item.snippet}`)
        .join("\n\n")

      return { success: true, output: truncate(formatted, WebTool.MAX_SEARCH_CHARS) }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message }
    }
  }

  private async read(url: string | undefined): Promise<ToolResult> {
    if (!url) {
      return { success: false, output: "", error: "Missing required parameter: url" }
    }

    try {
      const jinaUrl = `https://r.jina.ai/${url}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)

      const res = await fetch(jinaUrl, {
        signal: controller.signal,
        headers: {
          "Accept": "text/markdown",
          "User-Agent": "Betsy/1.0 (AI Assistant)",
        },
      })
      clearTimeout(timer)

      if (res.ok) {
        const text = await res.text()
        if (text.length >= 100) {
          return { success: true, output: truncate(text, WebTool.MAX_READ_CHARS) }
        }
      }
    } catch {
      // Jina failed — fall through to error
    }

    return {
      success: false,
      output: "",
      error: `Could not read ${url} via Jina Reader. Try using the 'browser' tool with action 'get_text' as fallback.`,
    }
  }
}
