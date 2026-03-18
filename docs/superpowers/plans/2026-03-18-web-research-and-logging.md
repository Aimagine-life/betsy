# Web Research & Engine Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Betsy reliable web research (search + read) with proper logging and runaway protection in the engine.

**Architecture:** New `web` tool (Google CSE search + Jina Reader read), improved `browser` tool (Playwright fallback, registered and truncated), `http` tool narrowed to API-only with truncation. Engine gets structured logging, token budget (50K), and per-tool call limits (5).

**Tech Stack:** Google Custom Search JSON API, Jina Reader (`r.jina.ai`), Playwright (existing), vitest for tests.

**Spec:** `docs/superpowers/specs/2026-03-18-web-research-and-logging-design.md`

---

### Task 1: Fix `chatStream()` to return usage

**Files:**
- Modify: `src/core/llm/providers/openrouter.ts:100-150`

No unit test for this task — `chatStream` requires mocking OpenAI streaming, and `buildResponse` is not exported. Verified manually after implementation + via engine logs in Task 2.

Note: `buildResponse` already accepts a `usage` parameter (line 48). Only the `chatStream` call site at line 150 needs updating — it currently omits the 4th argument.

- [ ] **Step 1: Fix chatStream to pass stream_options and return usage**

In `src/core/llm/providers/openrouter.ts`, modify `chatStream`:

```ts
// Line ~101: add stream_options to create call
const stream = await client.chat.completions.create({
  model: opts.model,
  messages: toOpenAIMessages(messages),
  ...(tools?.length ? { tools } : {}),
  stream: true,
  stream_options: { include_usage: true },
});
```

```ts
// After the for-await loop (~line 140), add usage parsing:
// OpenAI streams usage in the final chunk when stream_options.include_usage is true
let usage: { prompt_tokens: number; completion_tokens: number } | undefined;

// Inside the for-await loop, add after the finish_reason check:
if (chunk.usage) {
  usage = {
    prompt_tokens: chunk.usage.prompt_tokens,
    completion_tokens: chunk.usage.completion_tokens,
  };
}
```

```ts
// Line 150: pass usage to buildResponse
return buildResponse(text, finishReason, toolCalls, usage);
```

- [ ] **Step 2: Build and verify no type errors**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/core/llm/providers/openrouter.ts
git commit -m "fix: chatStream returns usage via stream_options"
```

---

### Task 2: Add engine logging

**Files:**
- Modify: `src/core/engine.ts`

- [ ] **Step 1: Add helper to estimate history size in chars**

At the top of `engine.ts`, add:

```ts
function historyChars(history: LLMMessage[]): number {
  let total = 0;
  for (const m of history) {
    if (typeof m.content === "string") {
      total += m.content.length;
    } else {
      for (const p of m.content) {
        if (p.type === "text") total += p.text.length;
      }
    }
  }
  return total;
}
```

- [ ] **Step 2: Add structured logging to the agentic loop**

Inside the `for` loop in `process()` (after line 83), wrap the LLM call and tool execution with timing and logging:

```ts
// Before LLM call — log history size
const histSize = historyChars(history);

// Around LLM call — time it
const llmStart = Date.now();
const response = streamChunk
  ? await llm.chatStream(messages, streamChunk, tools.length ? tools : undefined)
  : await llm.chat(messages, tools.length ? tools : undefined);
const llmMs = Date.now() - llmStart;

// After LLM call — log
console.log(JSON.stringify({
  tag: "engine",
  turn: turn + 1,
  llmMs,
  promptTokens: response.usage?.promptTokens,
  completionTokens: response.usage?.completionTokens,
  historyMessages: history.length,
  historyChars: histSize,
  reasoning: response.text?.slice(0, 200),
  stopReason: response.stopReason,
  toolCalls: response.toolCalls?.map(t => t.name),
}));
```

```ts
// Around each tool execution — time it and log
for (const tc of response.toolCalls) {
  onProgress?.({ type: "tool_start", tool: tc.name, turn: turn + 1 });

  const toolStart = Date.now();
  const result = await this.executeTool(tc.name, tc.arguments);
  const toolMs = Date.now() - toolStart;

  const resultText = result.success
    ? result.output
    : `Error: ${result.error || result.output}`;

  console.log(JSON.stringify({
    tag: "engine:tool",
    turn: turn + 1,
    tool: tc.name,
    params: tc.arguments,
    success: result.success,
    outputChars: resultText.length,
    toolMs,
  }));

  // ... rest of existing code (mediaUrl, history.push, onProgress)
}
```

- [ ] **Step 3: Remove old console.log line**

Delete line 137:
```ts
console.log(`🔧 Turn ${turn + 1}: executed ${response.toolCalls.map(t => t.name).join(", ")}`);
```

This is replaced by the structured logs above.

- [ ] **Step 4: Build and verify**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/engine.ts
git commit -m "feat: add structured logging to engine agentic loop"
```

---

### Task 3: Add runaway protection to engine

**Files:**
- Modify: `src/core/engine.ts`
- Create: `test/core/engine-limits.test.ts`

- [ ] **Step 1: Write failing test for token budget**

```ts
// test/core/engine-limits.test.ts
import { describe, it, expect } from "vitest"

describe("engine runaway protection", () => {
  it("MAX_PROMPT_TOKENS is defined as 50000", async () => {
    // We can't easily unit-test the full engine loop without mocking LLM,
    // so we verify the constants are correct.
    // The real protection is in the engine loop.
    const engine = await import("../../src/core/engine.js")
    expect((engine as any).MAX_PROMPT_TOKENS).toBe(50_000)
  })

  it("MAX_SAME_TOOL is defined as 5", async () => {
    const engine = await import("../../src/core/engine.js")
    expect((engine as any).MAX_SAME_TOOL).toBe(5)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run test/core/engine-limits.test.ts`
Expected: FAIL (constants not exported)

- [ ] **Step 3: Add constants and protection logic**

At the top of `src/core/engine.ts`:

```ts
const MAX_TURNS = 20;
const MAX_HISTORY = 40;
export const MAX_PROMPT_TOKENS = 50_000;
export const MAX_SAME_TOOL = 5;
```

Inside the `for` loop, after the LLM call and logging, add two checks:

```ts
// Check 1: Token budget
if (response.usage && response.usage.promptTokens > MAX_PROMPT_TOKENS) {
  const text = response.text || "Достигнут лимит контекста. Вот что удалось найти.";
  history.push({ role: "assistant", content: text });
  console.log(JSON.stringify({
    tag: "engine:limit",
    reason: "token_budget",
    promptTokens: response.usage.promptTokens,
  }));
  return { text, mediaUrl: lastMediaUrl };
}
```

Track tool calls per agentic cycle (not full conversation history). Add a local counter **before** the `for` loop:

```ts
// Before the agentic loop (before `for (let turn = 0; ...)`)
const toolCallCounts = new Map<string, number>();
```

After the tool execution loop, before `onProgress?.({ type: "turn_complete" })`:

```ts
// Increment tool counts for this cycle
for (const tc of response.toolCalls) {
  toolCallCounts.set(tc.name, (toolCallCounts.get(tc.name) ?? 0) + 1);
}

// Check 2: Per-tool limit (scoped to current process() call, not full history)
const overused = [...toolCallCounts.entries()].find(([, count]) => count > MAX_SAME_TOOL);
if (overused) {
  const text = `Инструмент "${overused[0]}" использован ${overused[1]} раз. Попробую ответить тем, что есть.`;
  history.push({ role: "assistant", content: text });
  console.log(JSON.stringify({
    tag: "engine:limit",
    reason: "tool_limit",
    tool: overused[0],
    count: overused[1],
  }));
  return { text, mediaUrl: lastMediaUrl };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run test/core/engine-limits.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/engine.ts test/core/engine-limits.test.ts
git commit -m "feat: engine runaway protection — token budget and per-tool limits"
```

---

### Task 4: Create `web` tool (search + read)

**Files:**
- Create: `src/core/tools/web.ts`
- Create: `test/tools/web.test.ts`
- Modify: `src/core/config.ts` (add google config)

- [ ] **Step 1: Add google config to schema**

In `src/core/config.ts`, add after line 75 (before `.passthrough()`):

```ts
google: z.object({
  api_key: z.string(),
  cx: z.string(),
}).optional(),
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Write web tool test**

```ts
// test/tools/web.test.ts
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
    // This would need a mock, but verifies the truncation constant exists
    expect(WebTool.MAX_READ_CHARS).toBe(4000)
    expect(WebTool.MAX_SEARCH_CHARS).toBe(2000)
  })
})
```

- [ ] **Step 4: Run test, verify it fails**

Run: `npx vitest run test/tools/web.test.ts`
Expected: FAIL (WebTool doesn't exist)

- [ ] **Step 5: Implement WebTool**

```ts
// src/core/tools/web.ts
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

    // Try Jina Reader first
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

    // Jina failed
    return {
      success: false,
      output: "",
      error: `Could not read ${url} via Jina Reader. Try using the 'browser' tool with action 'get_text' as fallback.`,
    }
  }
}
```

- [ ] **Step 6: Run test, verify it passes**

Run: `npx vitest run test/tools/web.test.ts`
Expected: PASS

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/core/tools/web.ts src/core/config.ts test/tools/web.test.ts
git commit -m "feat: web tool with Google CSE search and Jina Reader"
```

---

### Task 5: Improve `browser` tool and register it

**Files:**
- Modify: `src/core/tools/browser.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Update browser tool description and truncate get_text**

In `src/core/tools/browser.ts`:

Update description (line 18):
```ts
readonly description = "Browse websites with a real browser (Playwright). Use when the 'web' tool can't access a site, or for interactive tasks like clicking and filling forms.";
```

Remove `search` from the action description (line 9):
```ts
{ name: "action", type: "string", description: "Action to perform: get_text, screenshot, click, fill, evaluate", required: true },
```

Add truncation helper at the top:
```ts
const MAX_TEXT_CHARS = 4000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n[truncated, showing first ${max} of ${text.length} chars]`;
}
```

Modify `getText` method (line 88-93):
```ts
private async getText(page: Page, url: string | undefined): Promise<ToolResult> {
  if (!url) return { success: false, output: "", error: "Missing required parameter: url" };
  await page.goto(url, { timeout: TIMEOUT, waitUntil: "domcontentloaded" });
  const text = await page.textContent("body") ?? "";
  const cleaned = text.replace(/\s+/g, " ").trim();
  return { success: true, output: truncate(cleaned, MAX_TEXT_CHARS) };
}
```

Remove `search` case from the switch (lines 39-40) and delete the `search` method (lines 102-124).

- [ ] **Step 2: Register browser tool in index.ts**

In `src/index.ts`, add import:
```ts
import { BrowserTool } from "./core/tools/browser.js";
```

After line 84 (`tools.register(new HttpTool())`), add:
```ts
tools.register(new BrowserTool());
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/tools/browser.ts src/index.ts
git commit -m "feat: improve browser tool — truncation, better description, register in index"
```

---

### Task 6: Add truncation to `http` tool

**Files:**
- Modify: `src/core/tools/http.ts`
- Create: `test/tools/http.test.ts`

- [ ] **Step 1: Write test for truncation**

```ts
// test/tools/http.test.ts
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
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run test/tools/http.test.ts`
Expected: FAIL

- [ ] **Step 3: Update http tool**

In `src/core/tools/http.ts`:

```ts
import type { Tool, ToolResult } from "./types.js"

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n\n[truncated, showing first ${max} of ${text.length} chars]`
}

export class HttpTool implements Tool {
  static readonly MAX_OUTPUT_CHARS = 8000

  name = "http"
  description = "Make HTTP API requests (JSON/REST). For browsing websites use the 'web' or 'browser' tool."
  // ... parameters stay the same

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    // ... existing code until line 50, then change return:
    return { success: true, output: truncate(text, HttpTool.MAX_OUTPUT_CHARS) }
    // ... error case also truncate:
    return { success: false, output: truncate(text, HttpTool.MAX_OUTPUT_CHARS), error: `HTTP ${response.status} ${response.statusText}` }
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run test/tools/http.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/http.ts test/tools/http.test.ts
git commit -m "feat: http tool — truncation and API-only description"
```

---

### Task 7: Register `web` tool in index.ts and update config

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Register web tool**

In `src/index.ts`, add import:
```ts
import { WebTool } from "./core/tools/web.js";
```

After the tool registrations, add (conditionally — only if google config exists):
```ts
const googleConfig = (config as any).google as { api_key: string; cx: string } | undefined;
if (googleConfig?.api_key && googleConfig?.cx) {
  tools.register(new WebTool({ apiKey: googleConfig.api_key, cx: googleConfig.cx }));
}
```

- [ ] **Step 2: Add google config to production config on VPS**

SSH into VPS and add to `~/.betsy/config.yaml`:
```yaml
google:
  api_key: "<your-google-api-key>"
  cx: "<your-cx-id>"
```

- [ ] **Step 3: Build everything**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: register web tool with Google CSE config"
```

---

### Task 8: Deploy and verify

- [ ] **Step 1: Deploy to VPS**

Follow existing deploy process (build, copy, pm2 restart).

- [ ] **Step 2: Test web search**

Send Betsy a message: "Найди информацию о погоде в Москве"
Expected: Uses `web.search`, returns results from Google CSE.

- [ ] **Step 3: Test web read**

Send Betsy a message: "Прочитай эту статью: https://example.com"
Expected: Uses `web.read`, returns clean markdown via Jina.

- [ ] **Step 4: Test browser fallback**

Send Betsy a message with a site Jina can't read.
Expected: `web.read` fails, Betsy decides to try `browser.get_text`.

- [ ] **Step 5: Verify logs**

Check PM2 logs for structured JSON output:
```bash
pm2 logs betsy --lines 50 --nostream | grep '"tag":"engine"'
```
Expected: JSON lines with promptTokens, historyChars, tool params, etc.

- [ ] **Step 6: Verify runaway protection**

Check that engine stops if token budget or tool limit is hit (may need to trigger intentionally for testing).
