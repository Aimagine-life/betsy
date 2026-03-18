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

**`saveMessage(userId, channel, role, content, toolCallId?, toolCalls?): number`**
- INSERT into `conversations`, returns the row `id`
- `content` must always be a string — callers extract text from `ContentPart[]` before calling
- `toolCalls` serialized as JSON string

**`loadHistory(userId, limit = 40): { messages: LLMMessage[], summary: string | null }`**
- SELECT last N messages from `conversations` ordered by timestamp
- Reconstruct `LLMMessage[]` format (parse `toolCalls` from JSON, restore `toolCallId`)
- Also loads summary via `loadSummary(userId)` and returns it separately
- For user messages with `ContentPart[]` (images): only text part is stored, images are ephemeral
- Returns messages + summary separately — summary is injected into system prompt by the engine, NOT as a message in history

**`saveSummary(userId, summary, tokenEstimate)`**
- UPSERT into `conversation_summaries`

**`loadSummary(userId): { summary, tokenEstimate } | null`**
- SELECT from `conversation_summaries`

## New Module: `src/core/memory/compaction.ts`

### Function: `compactHistory(userId, llm, channel)`

**Trigger:** Called when `response.usage.promptTokens > contextBudget` after an LLM response during a tool-use turn.

**Algorithm:**
1. Load current summary from DB via `loadSummary(userId)`
2. Load all messages from DB for this user, ordered by timestamp
3. Split: old part (first half) and fresh part (second half, ~20 recent messages kept intact)
4. Send to fast_model with prompt:

```
Ты — помощник, который суммаризирует разговоры.

Предыдущее саммари (если есть):
{existingSummary}

Новые сообщения для включения в саммари:
{oldMessages formatted as role: content}

Обнови саммари, сохранив все важные факты, решения, контекст и предпочтения пользователя.
Пиши кратко, но не теряй важную информацию. Пиши на русском.
```

5. **In a single SQLite transaction:**
   - `saveSummary(userId, newSummary, estimatedTokens)`
   - `DELETE FROM conversations WHERE user_id = ? AND id <= ?` (using the max `id` of the old part)
6. Return — the engine will reload history via `loadHistory()` which will include the summary

**Transaction safety:** Steps 5a and 5b are wrapped in `db.transaction(...)` to prevent partial state on crash. If the LLM call in step 4 fails, the transaction never starts and history remains intact — fallback to splice trimming.

## Changes to `src/core/engine.ts`

### 1. History loading (line 60-62)

Replace empty array initialization with SQLite load:
```typescript
if (!this.histories.has(userId)) {
  const { messages, summary } = loadHistory(userId);
  this.histories.set(userId, messages);
  // summary is stored separately and injected into system prompt
}
```

Summary injection: in `buildPromptWithMemory`, if a summary exists for the user, append it to the system prompt (similar to how knowledge context is appended). This avoids having two `system` role messages in the LLM request.

### 2. Message persistence

After every `history.push(...)`, call `saveMessage()`:
- Line 82-84: user message
- Line 148: assistant final response
- Line 153-157: assistant with tool_calls
- Line 185-189: tool result

### 3. Compaction replaces hard stop (line 134-143)

Current behavior: stop processing when `promptTokens > 50000`.

New behavior — compaction only triggers during tool-use turns (where `continue` makes sense). On terminal turns, the response is already generated and returned.

```typescript
// After LLM response, before tool execution:
if (response.usage && response.usage.promptTokens > contextBudget) {
  await compactHistory(userId, this.deps.llm.fast(), channel);
  const { messages, summary } = loadHistory(userId);
  this.histories.set(userId, messages);
  // update local reference — declare `history` with `let` instead of `const`
  history = messages;
  // update summary in prompt context for next iteration
  continue; // retry the turn with compacted context
}
```

**Important:** Change `const history = ...` (line 63) to `let history = ...` to allow reassignment after compaction.

**Placement:** This check runs ONLY when `stopReason === "tool_use"` — between the tool-use check and tool execution. If the turn is terminal (no tool calls), the response has already been generated correctly and is returned as-is. Compaction will happen on the next user message if needed.

Keep `MAX_PROMPT_TOKENS = 50_000` as an absolute safety hard stop above `contextBudget` (fallback if compaction fails).

### 4. Remove splice trimming (line 88-90)

Delete `history.splice(0, history.length - MAX_HISTORY)` — compaction now manages context size by tokens, not message count.

## Changes to `src/core/config.ts`

Add `context_budget` to the `memory` section of config schema (alongside existing `max_knowledge`, `study_interval_min`):
```typescript
// Inside memorySchema:
context_budget: z.number().optional().default(40000)
```
Update `normalizeConfig()` to pass `context_budget` through if present in flat config format.

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
- **Restart with no history:** `loadHistory` returns empty messages + null summary — same as fresh start
- **Compaction fails (LLM error):** Catch and fall back to splice trimming as safety net. DB transaction never starts, so no partial state.
- **Tool messages without parent assistant:** Skip orphaned tool results during `loadHistory`
- **Images in messages:** `saveMessage` receives extracted text only; callers must extract text from `ContentPart[]` before calling. Images are ephemeral (base64 too large for DB).
- **Crash between history.push and saveMessage:** Tolerable — at most one message lost at crash boundary. On restart, DB is the source of truth. Write-to-DB-first is not worth the complexity since crashes are rare.
- **userId collision across channels:** Currently safe — Telegram uses numeric chat IDs, browser uses `"owner"`. If this changes in the future, `loadHistory` should filter by `(user_id, channel)` pair. For now, `user_id` alone is sufficient.
