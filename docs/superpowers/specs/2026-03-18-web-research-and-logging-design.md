# Web Research & Engine Logging

## Problem

Betsy can't effectively browse the web. The `http` tool does raw `fetch()` which:
- Gets blocked by anti-bot systems (Ozon, etc.)
- Returns raw HTML (50K+ chars) that wastes tokens
- LLM can't extract useful info, retries endlessly
- No circuit-breaker: 11 HTTP calls burned $10+ in one conversation

Additionally, the engine has no meaningful logging — we can't debug what happened after the fact.

## Design

### 1. New `web` tool (search + read via Jina)

Two actions: **search** and **read**.

#### `search` — Google Custom Search API

- Uses Google Programmable Search Engine
- cx and API key stored in `~/.betsy/config.yaml` under `google.api_key` and `google.cx`
- Returns structured results: title, link, snippet
- Compact, token-efficient
- Output truncated to **2000 characters** max

```
GET https://www.googleapis.com/customsearch/v1?key=KEY&cx=CX&q=QUERY
```

#### `read` — Jina Reader

- Fetches `https://r.jina.ai/URL` — returns clean markdown
- Timeout: 15 seconds
- Failure = non-2xx status, timeout, or empty/near-empty body (<100 chars)
- Headers: `Accept: text/markdown`, descriptive User-Agent
- On failure: returns error with explanation so LLM can decide to try `browser` tool

Output truncated to **4000 characters** max with indicator: `"\n\n[truncated, showing first 4000 of N chars]"`

### 2. `browser` tool — keep as separate tool, improve

Keep as independent tool that LLM can use as fallback when `web.read` fails, or for interactive tasks (click, fill, evaluate).

Changes:
- `get_text`: truncate output to **4000 characters** with truncation indicator
- `screenshot`: keep as-is (needed for visual tasks)
- `search`: remove (replaced by `web.search` via Google API)
- Update description: "Browse websites with a real browser (Playwright). Use when `web` tool can't access a site, or for interactive tasks like clicking, filling forms."
- Register in `src/index.ts` (currently dead code — not registered)

### 3. `http` tool — keep for API calls only

- Update description: "Make HTTP API requests (JSON/REST). For browsing websites use the `web` or `browser` tool."
- Add output truncation: max 8000 characters with truncation indicator
- No other changes

### 4. Engine logging

On every turn of the agentic loop, log:

| Field | Source |
|---|---|
| Tool input | tool name + params |
| Tool output size | `resultText.length` + `success` + duration ms |
| LLM reasoning | `response.text` (assistant text before tool calls) |
| LLM token usage | `response.usage.promptTokens`, `completionTokens` |
| History size | `history.length` messages, total chars |
| LLM call duration | `Date.now()` delta |

Fix `chatStream()` in openrouter.ts:
- Add `stream_options: { include_usage: true }` to the create call
- Parse usage from the final stream chunk and pass to `buildResponse()`

Log format: structured single-line JSON, prefixed with `[engine]` for easy grep/filtering separate from existing emoji-prefixed logs.

### 5. Runaway protection in engine

- **Token budget:** after each LLM response, check `usage.promptTokens`. If > 50,000 — stop the loop, respond with what's available. This means the 50K call is already paid for, but prevents the next even larger call.
- **Per-tool limit:** max 5 calls of the same tool name per agentic cycle. Enough for legitimate multi-step research, but prevents the 11-call runaway.
- Both are safety nets, not expected to trigger in normal operation.

## Config changes

Add to `~/.betsy/config.yaml`:

```yaml
google:
  api_key: "<key>"
  cx: "<cx>"
```

Add `google` to the zod config schema as optional (Betsy works without web search, just can't search).

## Files to create/modify

| File | Action |
|---|---|
| `src/core/tools/web.ts` | Create — new web tool (search via Google CSE + read via Jina) |
| `src/core/tools/browser.ts` | Modify — truncate get_text output, remove search action, update description, register |
| `src/core/tools/http.ts` | Modify — update description, add output truncation with indicator |
| `src/core/engine.ts` | Modify — add logging, token budget, per-tool limit |
| `src/core/llm/providers/openrouter.ts` | Modify — fix chatStream to return usage via stream_options |
| `src/core/config.ts` | Modify — add google config to schema |
| `src/index.ts` | Modify — register web and browser tools |
