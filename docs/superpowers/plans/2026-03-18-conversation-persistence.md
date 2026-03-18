# Conversation Persistence with Compaction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist conversation history to SQLite and implement LLM-powered compaction so Betsy remembers conversations across restarts.

**Architecture:** Messages are saved to SQLite after every `history.push()`. On restart, history is loaded from DB. When token usage exceeds a configurable budget, old messages are summarized by the fast LLM model into a cumulative summary, and the summarized messages are deleted from DB.

**Tech Stack:** TypeScript, better-sqlite3, vitest, existing LLM client interface

**Spec:** `docs/superpowers/specs/2026-03-18-conversation-persistence-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/core/config.ts` | Modify | Add `context_budget` to memory schema + normalizeConfig |
| `src/core/memory/db.ts` | Modify | New schema for conversations, migration, conversation_summaries table |
| `src/core/memory/conversations.ts` | Create | `saveMessage`, `loadHistory`, `saveSummary`, `loadSummary`, `extractText` |
| `src/core/memory/compaction.ts` | Create | `compactHistory` — LLM summarization + DB cleanup |
| `src/core/engine.ts` | Modify | `EngineDeps` update, hydration, persistence, compaction integration |
| `src/index.ts` | Modify | Wire `contextBudget` into Engine constructor |
| `test/core/conversations.test.ts` | Create | Tests for conversations CRUD |
| `test/core/compaction.test.ts` | Create | Tests for compaction logic |
| `test/core/engine-persistence.test.ts` | Create | Tests for engine persistence + compaction integration |

---

### Task 1: Add `context_budget` to config schema

**Files:**
- Modify: `src/core/config.ts:64-68` (memory schema), `src/core/config.ts:140-144` (normalizeConfig)
- Test: `test/core/config.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// In test/core/config.test.ts, add to existing describe block:
it("includes context_budget in memory schema with default 40000", () => {
  // Write a minimal nested config to a temp file, parse it
  const tmpPath = path.join(os.tmpdir(), `betsy-cfg-${crypto.randomUUID()}.yaml`);
  fs.writeFileSync(tmpPath, "agent:\n  name: Test\nllm:\n  provider: openrouter\n  api_key: test\n");
  const config = loadConfig(tmpPath);
  fs.unlinkSync(tmpPath);
  expect(config?.memory?.context_budget).toBe(40000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/config.test.ts -t "context_budget"`
Expected: FAIL — `context_budget` is undefined

- [ ] **Step 3: Add `context_budget` to memorySchema and normalizeConfig**

In `src/core/config.ts` line 64-68, add to the memory zod object:
```typescript
memory: z.object({
  max_knowledge: z.number().default(200),
  study_interval_min: z.number().default(30),
  learning_enabled: z.boolean().default(true),
  context_budget: z.number().default(40000), // NEW
}).optional(),
```

In `src/core/config.ts` line 140-144, add to `out.memory`:
```typescript
out.memory = {
  max_knowledge: raw.max_knowledge ?? 200,
  study_interval_min: raw.study_interval_min ?? 30,
  learning_enabled: raw.learning_enabled ?? true,
  context_budget: raw.context_budget ?? 40000, // NEW
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/config.test.ts -t "context_budget"`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/config.ts test/core/config.test.ts
git commit -m "feat: add context_budget to memory config schema"
```

---

### Task 2: Update DB schema — new conversations table + migration + summaries table

**Files:**
- Modify: `src/core/memory/db.ts:38-91`
- Test: `test/core/memory.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/core/memory.test.ts`:
```typescript
describe("DB Schema", () => {
  it("creates conversations table with user_id column", () => {
    const d = getDB(dbPath);
    const cols = d.pragma("table_info(conversations)") as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain("user_id");
    expect(colNames).toContain("tool_call_id");
    expect(colNames).toContain("tool_calls");
  });

  it("creates conversation_summaries table", () => {
    const d = getDB(dbPath);
    const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_summaries'").all();
    expect(tables.length).toBe(1);
  });

  it("creates idx_conv_user index", () => {
    const d = getDB(dbPath);
    const indexes = d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_conv_user'").all();
    expect(indexes.length).toBe(1);
  });

  it("migrates old conversations table (empty)", async () => {
    // Close, create a DB with the old schema, then call getDB again
    closeDB();
    const Database = (await import("better-sqlite3")).default;
    const oldDb = new Database(dbPath);
    oldDb.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    oldDb.close();
    // Re-open with getDB — migration should run
    getDB(dbPath);
    const d = getDB(dbPath);
    const cols = d.pragma("table_info(conversations)") as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain("user_id");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core/memory.test.ts -t "DB Schema"`
Expected: FAIL — `user_id` not found

- [ ] **Step 3: Update db.ts — new schema + migration + summaries**

In `src/core/memory/db.ts`, replace the old `CREATE TABLE IF NOT EXISTS conversations` block (lines 39-45) with the new schema:

```typescript
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_call_id TEXT,
  tool_calls TEXT,
  timestamp INTEGER NOT NULL DEFAULT (unixepoch())
);
```

After `db.exec(...)` (after line 91), add the imperative migration block:

```typescript
// Migration: upgrade old conversations table if needed
const cols = db.pragma("table_info(conversations)") as Array<{ name: string }>;
const hasUserId = cols.some(c => c.name === "user_id");
if (!hasUserId) {
  const count = (db.prepare("SELECT COUNT(*) as cnt FROM conversations").get() as { cnt: number }).cnt;
  if (count === 0) {
    db.exec("DROP TABLE IF EXISTS conversations");
    db.exec(`CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_call_id TEXT,
      tool_calls TEXT,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch())
    )`);
  } else {
    db.transaction(() => {
      db.prepare("ALTER TABLE conversations ADD COLUMN user_id TEXT NOT NULL DEFAULT ''").run();
      db.prepare("ALTER TABLE conversations ADD COLUMN tool_call_id TEXT").run();
      db.prepare("ALTER TABLE conversations ADD COLUMN tool_calls TEXT").run();
      db.prepare("DELETE FROM conversations WHERE user_id = ''").run();
    })();
  }
}

db.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (
  user_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)`);

db.exec("CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, timestamp)");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core/memory.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/memory/db.ts test/core/memory.test.ts
git commit -m "feat: update conversations schema with migration + summaries table"
```

---

### Task 3: Create conversations.ts — CRUD module

**Files:**
- Create: `src/core/memory/conversations.ts`
- Create: `test/core/conversations.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/core/conversations.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import { saveMessage, loadHistory, saveSummary, loadSummary, extractText } from "../../src/core/memory/conversations.js";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";

describe("Conversations", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `betsy-conv-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  describe("saveMessage + loadHistory", () => {
    it("saves and loads a simple message", () => {
      saveMessage("user1", "telegram", "user", "Hello");
      const { messages, summary } = loadHistory("user1");
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("Hello");
      expect(summary).toBeNull();
    });

    it("saves assistant message with tool calls", () => {
      const toolCalls = [{ id: "tc1", name: "test_tool", arguments: { input: "x" } }];
      saveMessage("user1", "telegram", "assistant", "", undefined, toolCalls);
      const { messages } = loadHistory("user1");
      expect(messages[0].toolCalls).toEqual(toolCalls);
    });

    it("saves tool result message with toolCallId", () => {
      saveMessage("user1", "telegram", "tool", "result text", "tc1");
      const { messages } = loadHistory("user1");
      expect(messages[0].toolCallId).toBe("tc1");
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        saveMessage("user1", "telegram", "user", `msg ${i}`);
      }
      const { messages } = loadHistory("user1", 5);
      expect(messages).toHaveLength(5);
      expect(messages[0].content).toBe("msg 5"); // most recent 5
    });

    it("isolates users", () => {
      saveMessage("user1", "telegram", "user", "Hello from user1");
      saveMessage("user2", "telegram", "user", "Hello from user2");
      const { messages: m1 } = loadHistory("user1");
      const { messages: m2 } = loadHistory("user2");
      expect(m1).toHaveLength(1);
      expect(m2).toHaveLength(1);
    });

    it("trims orphaned tool messages at window start", () => {
      saveMessage("user1", "telegram", "tool", "orphaned result", "tc0");
      saveMessage("user1", "telegram", "user", "Hello");
      saveMessage("user1", "telegram", "assistant", "Hi");
      const { messages } = loadHistory("user1");
      expect(messages[0].role).toBe("user");
      expect(messages).toHaveLength(2);
    });

    it("trims trailing assistant with toolCalls but no tool results", () => {
      saveMessage("user1", "telegram", "user", "Hello");
      saveMessage("user1", "telegram", "assistant", "", undefined, [{ id: "tc1", name: "test", arguments: {} }]);
      const { messages } = loadHistory("user1");
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
    });

    it("skips rows with corrupt tool_calls JSON", () => {
      const d = getDB(dbPath);
      d.prepare("INSERT INTO conversations (user_id, channel, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?, ?)").run(
        "user1", "telegram", "assistant", "", "NOT JSON", Math.floor(Date.now() / 1000),
      );
      saveMessage("user1", "telegram", "user", "Hello");
      const { messages } = loadHistory("user1");
      // corrupt row skipped, only Hello remains
      expect(messages.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("saveSummary + loadSummary", () => {
    it("saves and loads a summary", () => {
      saveSummary("user1", "This is a summary", 100);
      const result = loadSummary("user1");
      expect(result?.summary).toBe("This is a summary");
      expect(result?.tokenEstimate).toBe(100);
    });

    it("upserts on duplicate userId", () => {
      saveSummary("user1", "First", 50);
      saveSummary("user1", "Updated", 100);
      const result = loadSummary("user1");
      expect(result?.summary).toBe("Updated");
    });

    it("returns null for nonexistent user", () => {
      expect(loadSummary("nobody")).toBeNull();
    });

    it("loadHistory includes summary when present", () => {
      saveSummary("user1", "Previous context", 50);
      saveMessage("user1", "telegram", "user", "Hello");
      const { summary } = loadHistory("user1");
      expect(summary).toBe("Previous context");
    });
  });

  describe("extractText", () => {
    it("returns string content as-is", () => {
      expect(extractText("hello")).toBe("hello");
    });

    it("extracts text from ContentPart array", () => {
      const parts = [
        { type: "text" as const, text: "hello" },
        { type: "image_url" as const, image_url: { url: "data:..." } },
      ];
      expect(extractText(parts)).toBe("hello");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core/conversations.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement conversations.ts**

Create `src/core/memory/conversations.ts`:

```typescript
import { getDB } from "./db.js";
import type { LLMMessage, ContentPart, ToolUseRequest } from "../llm/types.js";

/** Extract plain text from LLMMessage content (string or ContentPart[]). */
export function extractText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map(p => p.text)
    .join("\n");
}

/** Save a message to the conversations table. Returns the inserted row id. */
export function saveMessage(
  userId: string,
  channel: string,
  role: string,
  content: string,
  toolCallId?: string,
  toolCalls?: ToolUseRequest[],
): number {
  const db = getDB();
  const result = db.prepare(
    "INSERT INTO conversations (user_id, channel, role, content, tool_call_id, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    userId,
    channel,
    role,
    content,
    toolCallId ?? null,
    toolCalls ? JSON.stringify(toolCalls) : null,
    Math.floor(Date.now() / 1000),
  );
  return Number(result.lastInsertRowid);
}

interface ConversationRow {
  id: number;
  user_id: string;
  channel: string;
  role: string;
  content: string;
  tool_call_id: string | null;
  tool_calls: string | null;
  timestamp: number;
}

/** Load last N messages for a user, plus their summary if any. */
export function loadHistory(
  userId: string,
  limit = 40,
): { messages: LLMMessage[]; summary: string | null } {
  const db = getDB();

  const rows = db.prepare(
    "SELECT * FROM conversations WHERE user_id = ? ORDER BY timestamp ASC, id ASC LIMIT ? OFFSET (SELECT MAX(0, COUNT(*) - ?) FROM conversations WHERE user_id = ?)",
  ).all(userId, limit, limit, userId) as ConversationRow[];

  const messages: LLMMessage[] = [];
  for (const row of rows) {
    let toolCalls: ToolUseRequest[] | undefined;
    if (row.tool_calls) {
      try {
        toolCalls = JSON.parse(row.tool_calls);
      } catch {
        continue; // skip corrupt row
      }
    }

    const msg: LLMMessage = {
      role: row.role as LLMMessage["role"],
      content: row.content,
    };
    if (toolCalls) msg.toolCalls = toolCalls;
    if (row.tool_call_id) msg.toolCallId = row.tool_call_id;

    messages.push(msg);
  }

  // Trim start: advance to first "user" message
  while (messages.length > 0 && messages[0].role !== "user") {
    messages.shift();
  }

  // Trim end: remove trailing assistant with toolCalls but no following tool results
  while (messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last.role === "assistant" && last.toolCalls?.length) {
      messages.pop();
    } else {
      break;
    }
  }

  // Load summary
  const summaryRecord = loadSummary(userId);

  return { messages, summary: summaryRecord?.summary ?? null };
}

/** Save or update the cumulative summary for a user. */
export function saveSummary(userId: string, summary: string, tokenEstimate: number): void {
  const db = getDB();
  db.prepare(
    "INSERT INTO conversation_summaries (user_id, summary, token_estimate, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET summary = excluded.summary, token_estimate = excluded.token_estimate, updated_at = excluded.updated_at",
  ).run(userId, summary, tokenEstimate, Math.floor(Date.now() / 1000));
}

/** Load the summary for a user. Returns null if no summary exists. */
export function loadSummary(userId: string): { summary: string; tokenEstimate: number } | null {
  const db = getDB();
  const row = db.prepare(
    "SELECT summary, token_estimate FROM conversation_summaries WHERE user_id = ?",
  ).get(userId) as { summary: string; token_estimate: number } | undefined;
  if (!row) return null;
  return { summary: row.summary, tokenEstimate: row.token_estimate };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core/conversations.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/memory/conversations.ts test/core/conversations.test.ts
git commit -m "feat: add conversations CRUD module with persistence"
```

---

### Task 4: Create compaction.ts — LLM summarization module

**Files:**
- Create: `src/core/memory/compaction.ts`
- Create: `test/core/compaction.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/core/compaction.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import { saveMessage, loadHistory, saveSummary, loadSummary } from "../../src/core/memory/conversations.js";
import { compactHistory } from "../../src/core/memory/compaction.js";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";

function mockLLM(summaryText: string) {
  return {
    chat: vi.fn().mockResolvedValue({
      text: summaryText,
      stopReason: "end_turn",
      usage: { promptTokens: 100, completionTokens: 50 },
    }),
    chatStream: vi.fn(),
  };
}

describe("Compaction", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `betsy-compact-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it("summarizes old messages and deletes them from DB", async () => {
    // Create 10 user/assistant turns
    for (let i = 0; i < 10; i++) {
      saveMessage("u1", "tg", "user", `Question ${i}`);
      saveMessage("u1", "tg", "assistant", `Answer ${i}`);
    }

    const llm = mockLLM("Пользователь задал 10 вопросов и получил ответы.");
    await compactHistory("u1", llm);

    // Summary should be saved
    const s = loadSummary("u1");
    expect(s?.summary).toContain("10 вопросов");

    // Old messages should be deleted, fresh half remains
    const { messages } = loadHistory("u1");
    expect(messages.length).toBeLessThan(20);
    expect(messages.length).toBeGreaterThan(0);
  });

  it("preserves existing summary in compaction prompt", async () => {
    saveSummary("u1", "Ранее обсуждали TypeScript", 30);
    for (let i = 0; i < 6; i++) {
      saveMessage("u1", "tg", "user", `msg ${i}`);
      saveMessage("u1", "tg", "assistant", `reply ${i}`);
    }

    const llm = mockLLM("Обновлённое саммари.");
    await compactHistory("u1", llm);

    // Check that the prompt included the old summary
    const callArgs = llm.chat.mock.calls[0][0];
    const promptText = callArgs[0].content as string;
    expect(promptText).toContain("Ранее обсуждали TypeScript");
  });

  it("aborts compaction if LLM returns empty summary", async () => {
    for (let i = 0; i < 6; i++) {
      saveMessage("u1", "tg", "user", `msg ${i}`);
      saveMessage("u1", "tg", "assistant", `reply ${i}`);
    }

    const llm = mockLLM("   "); // whitespace only
    await expect(compactHistory("u1", llm)).rejects.toThrow("empty summary");

    // Messages should NOT be deleted
    const { messages } = loadHistory("u1");
    expect(messages.length).toBe(12);
  });

  it("splits at turn boundary", async () => {
    // user, assistant(tool), tool, user, assistant — split should land at a user msg
    saveMessage("u1", "tg", "user", "Q1");
    saveMessage("u1", "tg", "assistant", "", undefined, [{ id: "tc1", name: "test", arguments: {} }]);
    saveMessage("u1", "tg", "tool", "result", "tc1");
    saveMessage("u1", "tg", "user", "Q2");
    saveMessage("u1", "tg", "assistant", "A2");
    saveMessage("u1", "tg", "user", "Q3");
    saveMessage("u1", "tg", "assistant", "A3");

    const llm = mockLLM("Summary of Q1 and tool use.");
    await compactHistory("u1", llm);

    const { messages } = loadHistory("u1");
    // Fresh part should start with a user message
    expect(messages[0].role).toBe("user");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core/compaction.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement compaction.ts**

Create `src/core/memory/compaction.ts`:

```typescript
import { getDB } from "./db.js";
import { loadSummary, saveSummary } from "./conversations.js";
import type { LLMClient } from "../llm/types.js";

interface CompactionRow {
  id: number;
  role: string;
  content: string;
  tool_calls: string | null;
}

// content is already a string from DB, but extractText is used for spec compliance
// and future-proofing in case LLMMessage content types change

/** Compact conversation history: summarize old messages via LLM and delete them. */
export async function compactHistory(userId: string, llm: LLMClient): Promise<void> {
  const db = getDB();

  // 1. Load existing summary
  const existing = loadSummary(userId);

  // 2. Load ALL messages (unbounded) for this user
  const allRows = db.prepare(
    "SELECT id, role, content, tool_calls FROM conversations WHERE user_id = ? ORDER BY timestamp ASC, id ASC",
  ).all(userId) as CompactionRow[];

  if (allRows.length < 4) return; // too few to compact

  // 3. Find split point at a turn boundary (user message near midpoint)
  const mid = Math.floor(allRows.length / 2);
  let splitIdx = -1;

  // Look forward from midpoint for first user message
  for (let i = mid; i < allRows.length; i++) {
    if (allRows[i].role === "user") { splitIdx = i; break; }
  }

  // Fallback: look backward for last user message before midpoint
  if (splitIdx === -1) {
    for (let i = mid - 1; i >= 0; i--) {
      if (allRows[i].role === "user") { splitIdx = i; break; }
    }
  }

  // No user message at all — abort
  if (splitIdx === -1) return;

  const oldPart = allRows.slice(0, splitIdx);
  if (oldPart.length === 0) return;

  // 4. Build summarization prompt
  const oldText = oldPart
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const promptText = `Ты — помощник, который суммаризирует разговоры.

Предыдущее саммари (если есть):
${existing?.summary ?? "Нет"}

Новые сообщения для включения в саммари:
${oldText}

Обнови саммари, сохранив все важные факты, решения, контекст и предпочтения пользователя.
Пиши кратко, но не теряй важную информацию. Пиши на русском.`;

  const response = await llm.chat([{ role: "user", content: promptText }]);
  const newSummary = response.text.trim();

  if (!newSummary) {
    throw new Error("Compaction aborted: LLM returned empty summary");
  }

  const estimatedTokens = response.usage?.completionTokens ?? Math.ceil(newSummary.length / 4);
  const maxOldId = oldPart[oldPart.length - 1].id;

  // 5. Atomic: save summary + delete old messages
  db.transaction(() => {
    saveSummary(userId, newSummary, estimatedTokens);
    db.prepare("DELETE FROM conversations WHERE user_id = ? AND id <= ?").run(userId, maxOldId);
  })();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core/compaction.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/memory/compaction.ts test/core/compaction.test.ts
git commit -m "feat: add LLM-powered conversation compaction"
```

---

### Task 5: Update Engine — hydration, persistence, compaction integration

**Files:**
- Modify: `src/core/engine.ts`
- Create: `test/core/engine-persistence.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/core/engine-persistence.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Engine } from "../../src/core/engine.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import { loadHistory, saveMessage } from "../../src/core/memory/conversations.js";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";

function mockLLM(responseText: string) {
  return {
    fast: () => ({
      chat: vi.fn().mockResolvedValue({ text: responseText, stopReason: "end_turn", usage: { promptTokens: 100, completionTokens: 20 } }),
      chatStream: vi.fn().mockResolvedValue({ text: responseText, stopReason: "end_turn", usage: { promptTokens: 100, completionTokens: 20 } }),
    }),
    strong: () => ({
      chat: vi.fn().mockResolvedValue({ text: responseText, stopReason: "end_turn" }),
      chatStream: vi.fn(),
    }),
  };
}

const testConfig = { name: "Бетси", personality: { tone: "friendly", responseStyle: "concise" } };

describe("Engine Persistence", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `betsy-eng-${crypto.randomUUID()}.db`);
    getDB(dbPath);
  });

  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  });

  it("persists user and assistant messages to DB", async () => {
    const engine = new Engine({ llm: mockLLM("Привет!"), config: testConfig, tools: new ToolRegistry(), contextBudget: 40000 });
    await engine.process({ channelName: "test", userId: "u1", text: "Hello", timestamp: Date.now() });

    const { messages } = loadHistory("u1");
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("loads history from DB on restart (new Engine instance)", async () => {
    // First engine — send a message
    const engine1 = new Engine({ llm: mockLLM("Reply 1"), config: testConfig, tools: new ToolRegistry(), contextBudget: 40000 });
    await engine1.process({ channelName: "test", userId: "u1", text: "First msg", timestamp: Date.now() });

    // Second engine (simulates restart) — history should be loaded from DB
    const mockChat = vi.fn().mockResolvedValue({ text: "Reply 2", stopReason: "end_turn", usage: { promptTokens: 200, completionTokens: 20 } });
    const engine2 = new Engine({
      llm: { fast: () => ({ chat: mockChat, chatStream: mockChat }), strong: () => ({ chat: vi.fn(), chatStream: vi.fn() }) },
      config: testConfig,
      tools: new ToolRegistry(),
      contextBudget: 40000,
    });
    await engine2.process({ channelName: "test", userId: "u1", text: "Second msg", timestamp: Date.now() });

    // The LLM should have received the previous messages in context
    const callMessages = mockChat.mock.calls[0][0];
    expect(callMessages.length).toBeGreaterThan(2); // system + history + new user msg
  });

  it("getHistory returns DB-backed history after restart", async () => {
    const engine1 = new Engine({ llm: mockLLM("Hi"), config: testConfig, tools: new ToolRegistry(), contextBudget: 40000 });
    await engine1.process({ channelName: "test", userId: "u1", text: "Hello", timestamp: Date.now() });

    // New engine instance
    const engine2 = new Engine({ llm: mockLLM(""), config: testConfig, tools: new ToolRegistry(), contextBudget: 40000 });
    const history = engine2.getHistory("u1");
    expect(history.length).toBe(2); // user + assistant from DB
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core/engine-persistence.test.ts`
Expected: FAIL — `contextBudget` not in EngineDeps

- [ ] **Step 3: Update engine.ts**

Apply all changes from the spec to `src/core/engine.ts`:

**3a.** Add imports at top:
```typescript
import { saveMessage, loadHistory, extractText } from "./memory/conversations.js";
import { compactHistory } from "./memory/compaction.js";
```

**3b.** Update `EngineDeps` (line 27-31) — add `contextBudget`:
```typescript
export interface EngineDeps {
  llm: { fast(): LLMClient; strong(): LLMClient };
  config: PromptConfig;
  tools: ToolRegistry;
  contextBudget: number;
}
```

**3c.** Add new fields to `Engine` class (after line 35):
```typescript
private summaries: Map<string, string> = new Map();
private compactionInFlight: Set<string> = new Set();
```

**3d.** Add `hydrateUser` method:
```typescript
private hydrateUser(userId: string): void {
  if (this.histories.has(userId)) return;
  const { messages, summary } = loadHistory(userId);
  this.histories.set(userId, messages);
  if (summary) this.summaries.set(userId, summary);
}
```

**3e.** Update `getHistory()` (line 42) — add hydration:
```typescript
getHistory(userId: string): Array<{ role: string; content: string }> {
  this.hydrateUser(userId);
  const history = this.histories.get(userId);
  if (!history) return [];
  // ... rest unchanged
```

**3f.** Update `process()` (line 60-63) — replace empty array with hydration, change `const` to `let`:
```typescript
if (!this.histories.has(userId)) {
  this.hydrateUser(userId);
}
let history = this.histories.get(userId)!; // MUST be let, not const — reassigned after compaction
```

**3g.** Change `const systemPrompt` to `let systemPrompt` (line 66) — reassigned after compaction.

**3h.** Add `saveMessage` after user message push (after line 85, outside both if/else branches). Use `textContent` which is the already-extracted text string — works for both image and non-image messages:
```typescript
// After the if/else block (line 85):
saveMessage(userId, msg.channelName, "user", textContent);
```

**3i.** Remove splice trimming (lines 88-90) — delete the `if (history.length > MAX_HISTORY)` block.

**3j.** Add `let compactionAttempted = false;` at start of try block (after line 95).

**3k.** Add `saveMessage` for hard-stop assistant response (after line 136):
```typescript
saveMessage(userId, msg.channelName, "assistant", text);
```

**3l.** Add `saveMessage` for terminal assistant response (after line 148):
```typescript
saveMessage(userId, msg.channelName, "assistant", text);
```

**3m.** Add background compaction check before the terminal return (before line 149):
```typescript
// Background compaction for terminal turns
if (!this.compactionInFlight.has(userId) && response.usage && response.usage.promptTokens > this.deps.contextBudget) {
  this.compactionInFlight.add(userId);
  compactHistory(userId, this.deps.llm.fast())
    .then(() => {
      const { messages: m, summary: s } = loadHistory(userId);
      this.histories.set(userId, m);
      if (s) this.summaries.set(userId, s);
    })
    .catch(err => console.error("Background compaction failed:", err))
    .finally(() => this.compactionInFlight.delete(userId));
}
```

**3n.** MOVE the existing `history.push({ role: "assistant", ... })` block (lines 153-157) to AFTER the compaction check below. Then add compaction check in its place (where lines 153-157 used to be):
```typescript
// Compaction check on tool-use turns
if (!compactionAttempted && response.usage && response.usage.promptTokens > this.deps.contextBudget) {
  compactionAttempted = true;
  turn--;
  try {
    await compactHistory(userId, this.deps.llm.fast());
  } catch (err) {
    console.error("Compaction failed:", err);
  }
  const { messages: m, summary: s } = loadHistory(userId);
  this.histories.set(userId, m);
  history = m;
  if (s) this.summaries.set(userId, s);
  systemPrompt = this.buildPromptWithMemory(msg.text, userId);
  continue;
}
```

**3o.** Move `saveMessage` for assistant tool-call to AFTER compaction check (after the compaction block above):
```typescript
saveMessage(userId, msg.channelName, "assistant", response.text || "", undefined, response.toolCalls);
```

**3p.** Add `saveMessage` for each tool result (after line 189):
```typescript
saveMessage(userId, msg.channelName, "tool", resultText, tc.id);
```

**3q.** Add `saveMessage` for tool-limit exceeded (after line 203) and max-turns exceeded (after line 218):
```typescript
// Tool limit: after history.push at line 203
saveMessage(userId, msg.channelName, "assistant", text);

// Max turns: after history.push at line 218
saveMessage(userId, msg.channelName, "assistant", text);
```

**3r.** Add summary injection in `buildPromptWithMemory` (after line 238, before `return prompt`):
```typescript
const summary = this.summaries.get(chatId);
if (summary) {
  prompt += `\n\n## Краткое содержание предыдущего разговора\n\n${summary}`;
}
```

- [ ] **Step 4: Run persistence tests**

Run: `npx vitest run test/core/engine-persistence.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run ALL existing engine tests to check for regressions**

Run: `npx vitest run test/core/engine.test.ts test/core/engine-limits.test.ts test/core/engine-media.test.ts`
Expected: Some may fail because `contextBudget` is now required in `EngineDeps`.

- [ ] **Step 6: Fix existing test mocks — add `contextBudget: 40000` to all Engine constructors in existing tests**

In `test/core/engine.test.ts`, `test/core/engine-limits.test.ts`, `test/core/engine-media.test.ts`: add `contextBudget: 40000` to every `new Engine({...})` call.

- [ ] **Step 7: Run ALL tests**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 8: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/core/engine.ts test/core/engine-persistence.test.ts test/core/engine.test.ts test/core/engine-limits.test.ts test/core/engine-media.test.ts
git commit -m "feat: integrate conversation persistence and compaction into engine"
```

---

### Task 6: Wire contextBudget in index.ts

**Files:**
- Modify: `src/index.ts:110-121`

- [ ] **Step 1: Add contextBudget to Engine constructor**

In `src/index.ts`, find the Engine construction (line 110-121) and add `contextBudget`:

```typescript
const engine = llm ? new Engine({
  llm,
  config: {
    name,
    personality: {
      tone: personality.tone,
      responseStyle: personality.style,
      customInstructions: personality.customInstructions,
    },
  },
  tools,
  contextBudget: config.memory?.context_budget ?? 40000, // NEW
}) : null;
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Run ALL tests**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire context_budget config into engine"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run build**

Run: `npm run build:all`
Expected: PASS

- [ ] **Step 4: Verify no regressions — check existing tests individually**

Run: `npx vitest run test/core/engine.test.ts test/core/engine-limits.test.ts test/channels/telegram.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Final commit if any leftover changes**

```bash
git status
# If clean, skip. If changes remain:
git add -A && git commit -m "chore: final cleanup for conversation persistence"
```
