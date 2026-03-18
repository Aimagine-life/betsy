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

The existing `conversations` table has no data and lacks required columns. On startup:
1. Check `PRAGMA table_info(conversations)` for `user_id` column
2. If missing: check `SELECT COUNT(*) FROM conversations`
   - If count = 0: `DROP TABLE IF EXISTS conversations` + recreate with new schema
   - If count > 0: wrap ALL migration DDL in a single transaction to prevent partial migration on crash:
     ```sql
     BEGIN;
     ALTER TABLE conversations ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
     ALTER TABLE conversations ADD COLUMN tool_call_id TEXT;
     ALTER TABLE conversations ADD COLUMN tool_calls TEXT;
     DELETE FROM conversations WHERE user_id = '';
     COMMIT;
     ```
3. This guards against data loss on deploy → rollback → redeploy cycles. The transaction ensures either all columns are added or none. `DROP TABLE IF EXISTS` prevents crash on concurrent double-startup. Rows with `user_id = ''` are deleted immediately since they have no usable identity.

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
- Reconstruct `LLMMessage[]` format (parse `toolCalls` from JSON with try/catch per row — skip rows with corrupt JSON, restore `toolCallId`)
- Also loads summary via `loadSummary(userId)` and returns it separately
- For user messages with `ContentPart[]` (images): only text part is stored, images are ephemeral
- Returns messages + summary separately — summary is injected into system prompt by the engine, NOT as a message in history

**`saveSummary(userId, summary, tokenEstimate)`**
- UPSERT into `conversation_summaries`

**`loadSummary(userId): { summary, tokenEstimate } | null`**
- SELECT from `conversation_summaries`

## New Module: `src/core/memory/compaction.ts`

### Function: `compactHistory(userId, llm)`

**Trigger:** Called when `response.usage.promptTokens > contextBudget` after an LLM response during a tool-use turn.

**Algorithm:**
1. Load current summary from DB via `loadSummary(userId)`
2. Load ALL messages from DB for this user via a dedicated unbounded query: `SELECT * FROM conversations WHERE user_id = ? ORDER BY timestamp ASC` (NOT via `loadHistory` which has a limit=40 cap). This ensures all accumulated messages are available for summarization.
3. Split at a **turn boundary**: find the midpoint by message count, then advance forward to the next `role: "user"` message. This ensures the split never lands mid-turn (between an assistant tool-call message and its tool results). Old part = everything before the split, fresh part = everything from the split onward.
4. Build the summarization prompt as an `LLMMessage[]` array and call `llm.chat()`:

```typescript
const promptText = `Ты — помощник, который суммаризирует разговоры.

Предыдущее саммари (если есть):
${existingSummary ?? "Нет"}

Новые сообщения для включения в саммари:
${oldMessages.map(m => `${m.role}: ${extractText(m.content)}`).join("\n")}

Обнови саммари, сохранив все важные факты, решения, контекст и предпочтения пользователя.
Пиши кратко, но не теряй важную информацию. Пиши на русском.`;

// Always use chat(), not chatStream() — compaction is internal, no user-facing streaming
const response = await llm.chat([{ role: "user", content: promptText }]);
const newSummary = response.text.trim(); // text is always string per LLMResponse type

// Guard: if LLM returned empty summary, abort compaction entirely.
// This prevents permanent context loss from LLM anomalies.
if (!newSummary) {
  throw new Error("Compaction aborted: LLM returned empty summary");
}

const estimatedTokens = response.usage?.completionTokens ?? Math.ceil(newSummary.length / 4);
```

`estimatedTokens` is computed from the LLM response's `completionTokens` if available, otherwise approximated as `length / 4`. This value is stored in `conversation_summaries.token_estimate` for informational/diagnostic purposes (e.g., monitoring summary growth over time). It is NOT used in the compaction trigger — the trigger relies solely on the real `promptTokens` from the main conversation LLM call.

5. **In a single SQLite transaction:**
   - `saveSummary(userId, newSummary, estimatedTokens)`
   - `DELETE FROM conversations WHERE user_id = ? AND id <= ?` (using the max `id` of the old part)
6. Return — the engine will reload history via `loadHistory()` which will include the summary

**Transaction safety:** Steps 5a and 5b are wrapped in `db.transaction(...)` to prevent partial state on crash. If the LLM call in step 4 fails, the transaction never starts and history remains intact — fallback to splice trimming.

## Changes to `src/core/engine.ts`

### 0. EngineDeps update

Add `contextBudget` to `EngineDeps` interface:
```typescript
export interface EngineDeps {
  llm: { fast(): LLMClient; strong(): LLMClient };
  config: PromptConfig;
  tools: ToolRegistry;
  contextBudget: number; // from config.memory.context_budget, default 40000
}
```

In `src/index.ts`, wire it when constructing Engine:
```typescript
const engine = new Engine({
  llm, config: promptConfig, tools,
  contextBudget: config.memory?.context_budget ?? 40000,
});
```

The engine accesses it as `this.deps.contextBudget` in the compaction check.

### 1. History loading (line 60-62)

Replace empty array initialization with SQLite load:
```typescript
if (!this.histories.has(userId)) {
  this.hydrateUser(userId); // shared helper for process() and getHistory()
}
```

**Helper method `hydrateUser(userId)`:** Loads history + summary from DB and populates both `this.histories` and `this.summaries`. **Guarded by `!this.histories.has(userId)`** — never overwrites in-session history.

**Update `getHistory()`** to also call `hydrateUser` so the scheduler gets DB-backed history after restart:
```typescript
getHistory(userId: string): Array<{ role: string; content: string }> {
  this.hydrateUser(userId); // hydrate from DB if not yet loaded
  const history = this.histories.get(userId);
  // ... rest unchanged
}
```

```typescript
private hydrateUser(userId: string): void {
  if (this.histories.has(userId)) return; // already hydrated, don't overwrite
  const { messages, summary } = loadHistory(userId);
  this.histories.set(userId, messages);
  if (summary) this.summaries.set(userId, summary);
}
```

**Summary cache:** Add `private summaries: Map<string, string> = new Map()` to Engine. This cache is updated on:
- Initial load from DB (above)
- After compaction (reload summary from DB)

**Summary injection:** In `buildPromptWithMemory`, check `this.summaries.get(userId)` and append to system prompt:
```typescript
const summary = this.summaries.get(userId);
if (summary) {
  prompt += `\n\n## Краткое содержание предыдущего разговора\n\n${summary}`;
}
```
This is analogous to how knowledge context is already appended. No second `system` message in the LLM request.

### 2. Message persistence

After every `history.push(...)`, call `saveMessage()`:
- Line 82-84: user message
- Line 136: assistant response on hard-stop (MAX_PROMPT_TOKENS exceeded)
- Line 148: assistant final response
- Line 153-157: assistant with tool_calls
- Line 185-189: tool result

### 3. Compaction replaces hard stop (line 134-143)

Current behavior: stop processing when `promptTokens > 50000`.

New behavior — compaction only triggers during tool-use turns (where `continue` makes sense). On terminal turns, the response is already generated and returned.

```typescript
// After LLM response, before tool execution:
if (!compactionAttempted && response.usage && response.usage.promptTokens > contextBudget) {
  compactionAttempted = true; // prevent tight loop on repeated failure
  await compactHistory(userId, this.deps.llm.fast());
  const { messages, summary } = loadHistory(userId);
  this.histories.set(userId, messages);
  history = messages; // requires `let` declaration
  if (summary) this.summaries.set(userId, summary);
  // rebuild system prompt with updated summary
  systemPrompt = this.buildPromptWithMemory(msg.text, userId);
  continue; // retry the turn with compacted context
}
```

**Compaction cooldown:** A `let compactionAttempted = false` flag is set at the start of `process()`. Once compaction fires (success or failure), the flag prevents re-triggering on subsequent tool-use turns within the same `process()` call. This prevents an API-burning tight loop if compaction fails to bring tokens under budget.

**System prompt rebuild:** `systemPrompt` must be rebuilt after compaction because it is constructed before the `for` loop (line 66). After compaction updates `this.summaries`, we call `buildPromptWithMemory` again to pick up the new summary. This requires changing `const systemPrompt` to `let systemPrompt` (line 66).

**Note on `continue` behavior and double-save prevention:** The compaction check fires BEFORE the assistant tool-call message is saved to DB. Move the `saveMessage` for assistant tool-call messages (line 153-157) to AFTER the compaction check. This way, if compaction triggers, the unsaved assistant message is discarded, `loadHistory` returns a clean history, and the `continue` re-runs the LLM which produces a fresh response. No duplicate assistant messages in DB.

**Important declarations:** Change both `const history = ...` (line 63) and `const systemPrompt = ...` (line 66) to `let` to allow reassignment after compaction.

**Execution order in the agentic loop (explicit):**
```
1. LLM call → response
2. [EXISTING] Hard stop: if promptTokens > MAX_PROMPT_TOKENS (50k) → return immediately
   - This fires on ALL turns (tool-use and terminal) as absolute safety
   - The hard-stop assistant message (line 136) IS saved to DB via saveMessage (see Section 2)
   - The assistant tool-call message (line 153-157) is NOT yet saved — it's saved after the compaction check
3. Check stopReason:
   a. Terminal (end_turn) → push + saveMessage → return response
      → fire background compaction if promptTokens > contextBudget
   b. Tool use → [NEW] compaction check (contextBudget) → continue if fired
      → push + saveMessage for assistant tool-call → execute tools
```

The hard stop at step 2 always runs first. It fires at 50k regardless of `contextBudget` (40k). The compaction check at step 3b fires at 40k only for tool-use turns. Between 40k and 50k: compaction handles it. Above 50k: hard stop catches it. The hard stop fires before `saveMessage` for the assistant tool-call, so no DB/RAM divergence on hard-stop exit.

**Terminal-turn compaction:** For terminal turns (no tool calls) where `promptTokens > contextBudget`, compaction does NOT fire immediately (no `continue` possible — the response is already generated). Instead, run compaction **after returning the response** as a fire-and-forget cleanup:

```typescript
// After returning the terminal response:
if (response.usage && response.usage.promptTokens > contextBudget) {
  compactHistory(userId, this.deps.llm.fast())
    .then(() => {
      // Update in-memory state so next message benefits immediately
      const { messages, summary } = loadHistory(userId);
      this.histories.set(userId, messages);
      if (summary) this.summaries.set(userId, summary);
    })
    .catch(err => console.error("Background compaction failed:", err));
}
```

This ensures terminal-turn-heavy workloads don't grow from `contextBudget` to `MAX_PROMPT_TOKENS` without ever compacting. After background compaction completes, both `this.histories` and `this.summaries` are updated so the next message uses the compacted context and new summary. The default gap of 10k tokens (40k budget vs 50k hard stop) provides headroom while background compaction runs.

**Race safety:** If a new message arrives while background compaction is running, `process()` uses the current in-memory history (pre-compaction, large but valid). When background compaction finishes and overwrites `this.histories`, the in-flight `process()` still holds a reference to the old array and continues working with it — messages pushed during that call exist only in the old array and in DB (via `saveMessage`). The next `process()` call will use the compacted array from `this.histories`, and those in-between messages will be missing from RAM (but present in DB). This RAM/DB divergence heals **only on process restart** (when `hydrateUser` reloads from DB for a fresh in-memory map) — NOT automatically during runtime, because `hydrateUser` is guarded by `has()` and won't re-hydrate an already-present key. Additionally, the `.then()` reload itself may be instantly stale if the in-flight `process()` is still saving messages via `saveMessage` after the reload completes. This is acceptable for a single-user chatbot where restarts are frequent (deploys). At worst: one extra oversized LLM call and some messages visible only in DB until restart.

### 4. Remove splice trimming (line 88-90)

Delete `history.splice(0, history.length - MAX_HISTORY)` — compaction now manages context size by tokens, not message count. The `limit = 40` in `loadHistory` serves as a secondary guard to prevent loading unbounded messages from DB on restart (before the first compaction runs). This is intentional — it caps DB reads, not in-memory growth.

## Changes to `src/core/config.ts`

**Schema change (required for TypeScript types):** Add `context_budget` to the `memory` zod object inside `configSchema` (lines 64-68 of config.ts):
```typescript
memory: z.object({
  max_knowledge: z.number().default(200),
  study_interval_min: z.number().default(30),
  learning_enabled: z.boolean().default(true),
  context_budget: z.number().default(40000), // NEW
}).optional(),
```
This ensures `BetsyConfig["memory"]` includes `context_budget` in its TypeScript type, so `config.memory?.context_budget` type-checks without `as any`.

**normalizeConfig update (for flat format configs):** Add to `out.memory` block:
```typescript
context_budget: raw.context_budget ?? 40000,
```
Note: zod's `.default(40000)` would cover this at parse time even without the `normalizeConfig` change, but we include it for explicitness and consistency with the other `memory` fields.

## Changes to `src/core/memory/db.ts`

**Restructure `getDB()`:** The existing `db.exec(multiStatementSQL)` runs all DDL at once. Migration requires imperative logic (PRAGMA check → conditional branch) that cannot go inside `db.exec`. The approach:

1. **Update** the existing `db.exec` block: replace the old `CREATE TABLE IF NOT EXISTS conversations` with the **new schema** (including `user_id`, `tool_call_id`, `tool_calls`). This makes fresh installs create the correct schema directly — no wasted DROP+recreate.
2. **After** `db.exec`, add an imperative migration block for existing installs:
   ```typescript
   // Migration: upgrade conversations table if needed (existing installs only)
   const cols = db.pragma("table_info(conversations)") as Array<{ name: string }>;
   const hasUserId = cols.some(c => c.name === "user_id");
   if (!hasUserId) {
     const count = db.prepare("SELECT COUNT(*) as cnt FROM conversations").get() as { cnt: number };
     if (count.cnt === 0) {
       db.exec("DROP TABLE IF EXISTS conversations");
       // Recreate with new schema — intentionally no IF NOT EXISTS since DROP above guarantees table is gone
       db.exec(`CREATE TABLE conversations (...new schema...)`);
     } else {
       // Use db.transaction() for atomic migration
       // IMPORTANT: use db.prepare().run() inside transaction, NOT db.exec()
       // (better-sqlite3 does not support db.exec() inside db.transaction() callbacks)
       db.transaction(() => {
         db.prepare("ALTER TABLE conversations ADD COLUMN user_id TEXT NOT NULL DEFAULT ''").run();
         db.prepare("ALTER TABLE conversations ADD COLUMN tool_call_id TEXT").run();
         db.prepare("ALTER TABLE conversations ADD COLUMN tool_calls TEXT").run();
         db.prepare("DELETE FROM conversations WHERE user_id = ''").run();
       })();
     }
   }
   // Always create summaries table and index (idempotent)
   db.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (...)`);
   db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, timestamp)`);
   ```
3. On fresh install: `db.exec` creates new-schema table directly → migration sees `user_id` present → skips. Clean path.
4. On existing install: `db.exec` finds table exists (IF NOT EXISTS skips) → migration detects missing `user_id` → upgrades atomically via `db.transaction()`.

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
| `src/core/engine.ts` | Load from DB, save after push, compaction instead of hard stop, `contextBudget` from deps |
| `src/core/config.ts` | Add `context_budget` parameter to `memorySchema` and `normalizeConfig` |
| `src/index.ts` | Wire `config.memory.context_budget` into `EngineDeps` |

## Edge Cases

- **First message ever:** No history in DB, no summary — works like today
- **Restart with no history:** `loadHistory` returns empty messages + null summary — same as fresh start
- **Compaction fails (LLM error):** Catch error in the engine's compaction block. Since `compactionAttempted = true` prevents retry, the engine continues with the current (oversized) history. The `MAX_PROMPT_TOKENS = 50_000` hard stop remains as a safety net — if the next LLM response still exceeds 50k tokens, the engine stops gracefully (existing behavior). DB transaction never starts on LLM failure, so no partial state.
- **Orphaned messages at window boundary:** `loadHistory` trims BOTH ends of the loaded window:
  - **Start:** advance forward to the first `role: "user"` message (handles orphaned tool results whose parent assistant was trimmed off by the limit).
  - **End:** if the window ends with an `assistant` message containing `toolCalls` but no following `tool` results (crash between assistant save and tool result save), trim that trailing assistant message.
  - Guarantees a clean message sequence for the LLM: starts with `user`, no orphaned tool results, no dangling tool-call assistant messages.
- **Images in messages:** `saveMessage` receives extracted text only; callers must extract text from `ContentPart[]` before calling. Images are ephemeral (base64 too large for DB).
- **Crash between history.push and saveMessage:** Tolerable — at most one message lost at crash boundary. On restart, DB is the source of truth. Write-to-DB-first is not worth the complexity since crashes are rare.
- **userId collision across channels:** Currently safe — Telegram uses numeric chat IDs, browser uses `"owner"`. Known gap: `channel` is written to DB but `loadHistory` filters only by `user_id`. Note: `"owner"` is a static string used by the browser channel — if a future Telegram config also maps the owner to the string `"owner"` instead of a numeric ID, histories would silently merge. TODO: scope userId as `channel:userId` (e.g., `telegram:123456`, `browser:owner`) to prevent collisions. For now, `user_id` alone is sufficient since Telegram always uses numeric IDs.
- **Scheduler `getHistory()` after restart:** Fixed — `getHistory()` now calls `hydrateUser()` which loads from DB if the in-memory map is empty (see Section 1, "Update `getHistory()`").
- **Summarization language:** The compaction prompt is hardcoded in Russian ("Пиши на русском"). This matches the project's UI language (per CLAUDE.md). If Betsy is ever used for non-Russian conversations, this should be made configurable. Accepted assumption for now.
- **Streaming draft on compaction `continue`:** When compaction fires during a tool-use turn with streaming enabled, the Telegram handler's `streamText` may already contain partial text from the pre-compaction LLM call. After `continue`, the next LLM call appends more text via the same `streamChunk` callback. This is acceptable — tool-use turns typically have minimal/empty `response.text`, so the visual impact is negligible. If it becomes a problem, the engine could reset the streaming state before `continue`, but this is out of scope.
- **`extractText` utility:** Converts `LLMMessage.content` (string or ContentPart[]) to a plain string. Defined as an **exported** helper in `conversations.ts` and used by both `compaction.ts` (for formatting messages in the summarization prompt) and `engine.ts` (for extracting text from image user messages before calling `saveMessage`). Signature: `extractText(content: string | ContentPart[]): string`.
