# Conversation Persistence with Compaction

## Problem

Betsy stores conversation history only in RAM (`Map<string, LLMMessage[]>` in `engine.ts`). On process restart, all history is lost. The `conversations` table in SQLite exists but is never used and lacks a `user_id` column.

## Solution

Persist conversation messages to SQLite and implement LLM-powered compaction with cumulative summarization and token budgeting.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Compaction trigger | By token count (real `promptTokens` from API) | Accurate, already available from OpenRouter |
| Token counting | From LLM API response | Zero-dependency, exact |
| Budget threshold | Configurable `context_budget` in config (default 40000) | Different models have different context windows |
| Compaction strategy | Sliding window + cumulative summary | Preserves deep context without unbounded growth |
| Summary structure | Single cumulative summary per user | Simpler than summary chains, doesn't grow uncontrollably |
| Summarization model | fast_model (Gemini 2.5 Flash) | Cheap, fast, sufficient for summarization |

## Database Schema

### Migration

The existing `conversations` table has no data and lacks required columns. On startup, check `PRAGMA table_info(conversations)` — if `user_id` column is missing, drop and recreate.

### Tables

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  role TEXT NOT NULL,            -- user | assistant | tool
  content TEXT NOT NULL,
  tool_call_id TEXT,             -- for tool result messages
  tool_calls TEXT,               -- JSON string, for assistant messages with tool calls
  timestamp INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, timestamp);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  user_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

## New Module: `src/core/memory/conversations.ts`

### Functions

**`saveMessage(userId, channel, role, content, toolCallId?, toolCalls?)`**
- INSERT into `conversations`
- `toolCalls` serialized as JSON string

**`loadHistory(userId, limit = 40): LLMMessage[]`**
- SELECT last N messages from `conversations` ordered by timestamp
- Reconstruct `LLMMessage[]` format (parse `toolCalls` from JSON, restore `toolCallId`)
- If a summary exists, prepend it as a system-like message at the start
- Returns ready-to-use message array for the engine

**`saveSummary(userId, summary, tokenEstimate)`**
- UPSERT into `conversation_summaries`

**`loadSummary(userId): { summary, tokenEstimate } | null`**
- SELECT from `conversation_summaries`

## New Module: `src/core/memory/compaction.ts`

### Function: `compactHistory(userId, history, llm, contextBudget)`

**Trigger:** Called when `response.usage.promptTokens > contextBudget` after an LLM response.

**Algorithm:**
1. Load current summary from DB via `loadSummary(userId)`
2. Split history in half: old part (first half) and fresh part (second half, ~20 recent messages kept intact)
3. Send to fast_model with prompt:

```
Ты — помощник, который суммаризирует разговоры.

Предыдущее саммари (если есть):
{existingSummary}

Новые сообщения для включения в саммари:
{oldMessages formatted as role: content}

Обнови саммари, сохранив все важные факты, решения, контекст и предпочтения пользователя.
Пиши кратко, но не теряй важную информацию. Пиши на русском.
```

4. Save updated summary via `saveSummary(userId, newSummary, estimatedTokens)`
5. Delete compacted messages from `conversations` table (those that were summarized)
6. Return — the engine will reload history via `loadHistory()` which will include the summary

## Changes to `src/core/engine.ts`

### 1. History loading (line 60-62)

Replace empty array initialization with SQLite load:
```typescript
if (!this.histories.has(userId)) {
  const restored = loadHistory(userId);
  this.histories.set(userId, restored);
}
```

### 2. Message persistence

After every `history.push(...)`, call `saveMessage()`:
- Line 82-84: user message
- Line 148: assistant final response
- Line 153-157: assistant with tool_calls
- Line 185-189: tool result

### 3. Compaction replaces hard stop (line 134-143)

Current behavior: stop processing when `promptTokens > 50000`.

New behavior:
```typescript
if (response.usage && response.usage.promptTokens > contextBudget) {
  await compactHistory(userId, history, this.deps.llm.fast(), contextBudget);
  const restored = loadHistory(userId);
  this.histories.set(userId, restored);
  history = restored; // update local reference
  continue; // retry the turn with compacted context
}
```

Keep `MAX_PROMPT_TOKENS` as an absolute safety limit above `contextBudget` (e.g., at 50k if budget is 40k).

### 4. Remove splice trimming (line 88-90)

Delete `history.splice(0, history.length - MAX_HISTORY)` — compaction now manages context size by tokens, not message count.

## Changes to `src/core/config.ts`

Add `context_budget` to config schema:
```typescript
context_budget: z.number().optional().default(40000)
```

## Changes to `src/core/memory/db.ts`

Add migration logic and new table:
1. Check `PRAGMA table_info(conversations)` for `user_id` column
2. If missing: `DROP TABLE conversations` + recreate with new schema
3. Add `CREATE TABLE IF NOT EXISTS conversation_summaries`

## Data Flow

```
User message
  → saveMessage(userId, channel, "user", content)
  → history.push(userMessage)
  → LLM call
  → check promptTokens > context_budget?
      YES → compactHistory(fast_model summarizes old messages)
          → saveSummary to DB
          → delete old messages from DB
          → reload history from DB
          → continue loop
      NO  → continue
  → assistant response
  → saveMessage(userId, channel, "assistant", content, toolCalls?)
  → return response

On restart:
  → loadHistory(userId)
  → loadSummary + recent messages from DB
  → restored history ready for use
```

## Files Changed

| File | Change |
|---|---|
| `src/core/memory/db.ts` | Migration + new table |
| `src/core/memory/conversations.ts` | **New** — CRUD for messages + summaries |
| `src/core/memory/compaction.ts` | **New** — compaction logic |
| `src/core/engine.ts` | Load from DB, save after push, compaction instead of hard stop |
| `src/core/config.ts` | Add `context_budget` parameter |

## Edge Cases

- **First message ever:** No history in DB, no summary — works like today
- **Restart with no history:** `loadHistory` returns empty array — same as fresh start
- **Compaction fails (LLM error):** Catch and fall back to splice trimming as safety net
- **Tool messages without parent assistant:** Skip orphaned tool results during `loadHistory`
- **Images in messages:** Store text content only; images are ephemeral (base64 too large for DB)
