# Chat Memory Recall + Quoted Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Betsy semantically search every past chat message and answer recall questions ("что я говорил про X") by sending a Telegram reply that quotes the original message, with her own comment as the reply text.

**Architecture:** Every row in `bc_conversation` gets a pgvector embedding (inline on `append`), a native `chat_id` column, and a native `external_message_id` column holding the Telegram message id. Two new tools: `recall_messages` (cosine-distance nearest-neighbour search) and `set_reply_target` (stores an outgoing reply target in a per-turn mutable run context). The runner propagates the target into `BetsyResponse.replyTo`; the Telegram adapter uses grammy's `reply_parameters` to send the final message as a native Telegram reply. For the streaming path, `streamMessage` accepts a `replyToPromise` that it awaits right before its final send, so the draft preview is replaced by a real reply-quoted message.

**Tech Stack:** TypeScript, Node 20+, PostgreSQL 16 + pgvector, grammy (Telegram), @google/genai (Gemini text-embedding-004 + gemini-2.5-flash), vitest.

---

## File Structure

**New files:**
- `src/multi/db/migrations/007_conversation_embeddings.sql` — adds `embedding`, `chat_id`, `external_message_id` columns + indexes
- `src/multi/memory/conversation-search.ts` — pure helper: builds the semantic search SQL with dynamic filters (kept out of repo to keep the repo class small and readable)
- `src/multi/agents/run-context.ts` — tiny shared type for the per-turn mutable context (currently only `replyTarget`, but extensible)
- `src/multi/agents/tools/recall-tools.ts` — the two new tools (`recall_messages`, `set_reply_target`)
- `scripts/embed-conversation-history.mjs` — one-shot bulk embedder for legacy rows
- `tests/multi/memory/conversation-search.test.ts` — unit test for the SQL builder
- `tests/multi/memory/conversation-repo-embedding.test.ts` — integration test for new ConversationRepo methods (behind `BC_TEST_DATABASE_URL`)
- `tests/multi/agents/tools/recall-tools.test.ts` — unit test for the two tools with mocked repo + gemini

**Modified files:**
- `src/multi/memory/conversation-repo.ts` — extend `AppendInput`, add inline embedding in `append`, add `searchByEmbedding`, `listMissingEmbeddings`, `setEmbedding`, `setExternalMessageId`, `updateRecentByIdOnly` helpers; accept optional `gemini` in constructor
- `src/multi/memory/types.ts` — extend `Conversation` type with `chatId`, `externalMessageId`
- `src/multi/bot-router/router.ts` — pass `chatId` + `externalMessageId` when appending user message; use `replyTo` from `BetsyResponse` in outgoing `sendMessage`; for streaming path, wire `replyToPromise`
- `src/multi/agents/runner.ts` — create `runContext` object, pass to tool factories, plumb `replyTo` into `BetsyResponse` and `RunBetsyStreamResult`; after sending, call `setExternalMessageId` on the assistant row
- `src/multi/agents/tools/memory-tools.ts` — extend `MemoryToolsDeps` with `currentChannel`, `currentChatId`, `runContext`; factory is unchanged but file re-exports `createRecallTools` for callers that also want the new tools bundled
- `src/multi/agents/betsy-factory.ts` — accept `recallTools: MemoryTool[]` in `BetsyTools`, append to `allTools`
- `src/multi/channels/base.ts` — extend `StreamableOutbound` with optional `replyToPromise`
- `src/multi/channels/telegram.ts` — `sendMessage` honours `replyToMessageId`; `streamMessage` awaits `replyToPromise` before final send and uses `reply_parameters` when set; both return the outgoing message id via a new method `sendMessageReturningId`
- `src/multi/server.ts` — instantiate `ConversationRepo` with `gemini` argument; wire up new tool factory
- `src/multi/personality/bridge.ts` — add `RECALL_INSTRUCTIONS` constant and concatenate into the system prompt

---

## Ground Rules (read before starting)

1. **RLS always.** Every new SQL query in `ConversationRepo` must run inside `withWorkspace(this.pool, workspaceId, …)`. Never bypass.
2. **Russian output.** Prompts sent TO models are English; instructions the model emits to the user (inside `RECALL_INSTRUCTIONS`) are Russian — the user speaks Russian.
3. **Failure modes are non-fatal.** Embedding calls can fail (Vertex 429, Gemini hiccups). `append` MUST succeed and return even if embedding fails — embedding gets `NULL` and backfill picks it up later. Never throw out of `append` on an embedding error.
4. **No new env vars** beyond `BC_RECALL_DEFAULT_LIMIT` and `BC_RECALL_EXCLUDE_RECENT_N` (both optional, documented in Task 5).
5. **Tests first.** Each task has a failing test written before the implementation. If a step is pure plumbing (e.g. migration), the test becomes an integration check.
6. **Commit after every green test.** The commit messages are prescribed — use them verbatim.
7. **Typecheck gate.** After every task, run `npm run typecheck`. If it fails, fix before moving on.
8. **Do not touch `src/core/*`.** This is multi-mode only.

---

### Task 1: Migration 007 — schema for recall

**Files:**
- Create: `src/multi/db/migrations/007_conversation_embeddings.sql`

**Rationale:** Adds the three new columns (`embedding`, `chat_id`, `external_message_id`), a pgvector ivfflat index for cosine search, and a composite index for chat-scoped lookups. All `if not exists` so re-runs are safe. No data backfill in SQL — `scripts/embed-conversation-history.mjs` handles that after deploy.

- [ ] **Step 1: Create the migration file**

```sql
-- 007_conversation_embeddings.sql
-- Adds vector embeddings + native chat_id + external message id to bc_conversation
-- so Betsy can semantically recall old messages and reply-quote them.

create extension if not exists vector;

alter table bc_conversation
  add column if not exists embedding vector(768),
  add column if not exists chat_id text,
  add column if not exists external_message_id bigint;

-- ivfflat cosine index for nearest-neighbour search.
-- lists=100 is a reasonable default up to ~1M rows.
create index if not exists bc_conversation_embedding_idx
  on bc_conversation using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Composite index for chat-scoped chronological queries used by recall_messages
-- (filter by chat_id, then order).
create index if not exists bc_conversation_chat_created_idx
  on bc_conversation (workspace_id, chat_id, created_at desc);
```

- [ ] **Step 2: Verify migration parses locally (dry-run SQL)**

Run: `psql -f src/multi/db/migrations/007_conversation_embeddings.sql` against a scratch DB if available; otherwise rely on the migration runner smoke-test in the integration test (Task 2).

Expected: no syntax errors. If `vector` extension is missing locally, install `postgresql-16-pgvector` or use the Docker `pgvector/pgvector:pg16` image.

- [ ] **Step 3: Commit**

```bash
git add src/multi/db/migrations/007_conversation_embeddings.sql
git commit -m "feat(multi/db): migration 007 — bc_conversation embedding + chat_id + external_message_id"
```

---

### Task 2: Extend Conversation type + ConversationRepo (schema side)

**Files:**
- Modify: `src/multi/memory/types.ts`
- Modify: `src/multi/memory/conversation-repo.ts`
- Test: `tests/multi/memory/conversation-repo.test.ts` (extend existing)

**Rationale:** Before embedding logic lands, the repo needs to round-trip the new columns. This task is strictly about schema/shape — no embedding calls yet.

- [ ] **Step 1: Write failing test for chat_id + external_message_id round-trip**

Append to `tests/multi/memory/conversation-repo.test.ts`, inside the existing `d('ConversationRepo', ...)` block:

```typescript
  it('append persists chat_id and external_message_id when provided', async () => {
    const msg = await repo.append(workspaceId, {
      channel: 'telegram',
      role: 'user',
      content: 'Привет',
      chatId: '123456',
      externalMessageId: 789,
    })
    expect(msg.chatId).toBe('123456')
    expect(msg.externalMessageId).toBe(789)

    const recent = await repo.recent(workspaceId, 1)
    expect(recent[0].chatId).toBe('123456')
    expect(recent[0].externalMessageId).toBe(789)
  })

  it('append allows chat_id and external_message_id to be omitted (legacy callers)', async () => {
    const msg = await repo.append(workspaceId, {
      channel: 'telegram',
      role: 'assistant',
      content: 'Ответ',
    })
    expect(msg.chatId).toBeNull()
    expect(msg.externalMessageId).toBeNull()
  })

  it('setExternalMessageId updates the row', async () => {
    const msg = await repo.append(workspaceId, {
      channel: 'telegram',
      role: 'assistant',
      content: 'ok',
      chatId: '1',
    })
    await repo.setExternalMessageId(workspaceId, msg.id, 555)
    const recent = await repo.recent(workspaceId, 1)
    expect(recent[0].externalMessageId).toBe(555)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `BC_TEST_DATABASE_URL=postgres://... npx vitest run tests/multi/memory/conversation-repo.test.ts`

Expected: failures — `chatId is not a function` / `Column "chat_id" does not exist` / `setExternalMessageId is not a function`. If `BC_TEST_DATABASE_URL` is unset, the whole suite is skipped — set it to a throwaway local DB before running this task.

- [ ] **Step 3: Extend `Conversation` type**

Replace the existing `Conversation` interface in `src/multi/memory/types.ts` (find the existing definition — search for `export interface Conversation`) with:

```typescript
export interface Conversation {
  id: string
  workspaceId: string
  channel: 'telegram' | 'max' | 'cabinet'
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls: unknown
  tokensUsed: number
  meta: Record<string, unknown>
  chatId: string | null
  externalMessageId: number | null
  createdAt: Date
}
```

- [ ] **Step 4: Update `rowToConversation` and `AppendInput` in `conversation-repo.ts`**

Replace the top of `src/multi/memory/conversation-repo.ts` (lines 1–68, i.e. imports, `rowToConversation`, `AppendInput`, `append`) with:

```typescript
import type { Pool } from 'pg'
import type { GoogleGenAI } from '@google/genai'
import { withWorkspace } from '../db/rls.js'
import type { Conversation } from './types.js'
import { embedText, toPgVector } from './embeddings.js'
import { log } from '../observability/logger.js'

function rowToConversation(r: any): Conversation {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    channel: r.channel,
    role: r.role,
    content: r.content,
    toolCalls: r.tool_calls,
    tokensUsed: r.tokens_used,
    meta: r.meta ?? {},
    chatId: r.chat_id ?? null,
    externalMessageId:
      r.external_message_id === null || r.external_message_id === undefined
        ? null
        : Number(r.external_message_id),
    createdAt: r.created_at,
  }
}

export interface AppendInput {
  channel: 'telegram' | 'max' | 'cabinet'
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: unknown
  tokensUsed?: number
  meta?: Record<string, unknown>
  /** Native column — platform chat id (Telegram chat.id stringified). */
  chatId?: string | null
  /** Native column — platform message id (Telegram message_id as bigint). */
  externalMessageId?: number | null
}

/** Minimum content length for embedding. Avoids indexing "ok"/"да"/emoji-only replies. */
const MIN_EMBED_LEN = 10

export class ConversationRepo {
  constructor(
    private pool: Pool,
    /** Optional — when provided, `append` inline-computes embeddings. */
    private gemini?: GoogleGenAI,
  ) {}

  async append(workspaceId: string, input: AppendInput): Promise<Conversation> {
    log().info('convRepo.append: start', {
      workspaceId,
      role: input.role,
      channel: input.channel,
      contentLen: input.content?.length ?? 0,
      hasChatId: input.chatId != null,
      hasExternalMessageId: input.externalMessageId != null,
    })
    try {
      const result = await withWorkspace(this.pool, workspaceId, async (client) => {
        const { rows } = await client.query(
          `insert into bc_conversation
            (workspace_id, channel, role, content, tool_calls, tokens_used, meta, chat_id, external_message_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           returning *`,
          [
            workspaceId,
            input.channel,
            input.role,
            input.content,
            input.toolCalls ? JSON.stringify(input.toolCalls) : null,
            input.tokensUsed ?? 0,
            JSON.stringify(input.meta ?? {}),
            input.chatId ?? null,
            input.externalMessageId ?? null,
          ],
        )
        return rowToConversation(rows[0])
      })
      log().info('convRepo.append: ok', { workspaceId, id: result.id, role: input.role })

      // Inline embedding (best-effort). Runs AFTER the insert succeeds so the
      // message is always persisted. Failure → log + leave embedding NULL.
      if (
        this.gemini &&
        (input.role === 'user' || input.role === 'assistant') &&
        input.content.length >= MIN_EMBED_LEN
      ) {
        this.embedAndStore(workspaceId, result.id, input.content).catch((e) =>
          log().warn('convRepo.append: inline embedding failed (will backfill)', {
            workspaceId,
            id: result.id,
            error: e instanceof Error ? e.message : String(e),
          }),
        )
      }

      return result
    } catch (e) {
      log().error('convRepo.append: failed', {
        workspaceId,
        role: input.role,
        error: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
  }

  /** Internal: embed content and write it to the row. Non-fatal on failure. */
  private async embedAndStore(workspaceId: string, id: string, content: string): Promise<void> {
    if (!this.gemini) return
    const vec = await embedText(this.gemini, content)
    await this.setEmbedding(workspaceId, id, vec)
  }
```

Note: the class closing `}` and the existing `recent`/`countActive`/… methods stay — this edit only replaces the top of the file through the end of the new `embedAndStore` method. Leave the rest of the file untouched for now; Task 3 will add more methods.

- [ ] **Step 5: Add `setExternalMessageId` and `setEmbedding` methods**

Inside `ConversationRepo`, AFTER `purgeAll` (which is the last existing method), add:

```typescript
  async setExternalMessageId(
    workspaceId: string,
    id: string,
    externalMessageId: number,
  ): Promise<void> {
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(
        `update bc_conversation set external_message_id = $1 where id = $2`,
        [externalMessageId, id],
      )
    })
  }

  async setEmbedding(workspaceId: string, id: string, vec: number[]): Promise<void> {
    const pgVec = toPgVector(vec)
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(
        `update bc_conversation set embedding = $1::vector where id = $2`,
        [pgVec, id],
      )
    })
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `BC_TEST_DATABASE_URL=postgres://... npx vitest run tests/multi/memory/conversation-repo.test.ts`

Expected: all tests in the file pass, including the three new ones.

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`

Expected: clean exit 0. If failures, fix type errors in `types.ts` consumers — `Conversation` may be destructured elsewhere.

- [ ] **Step 8: Commit**

```bash
git add src/multi/memory/types.ts src/multi/memory/conversation-repo.ts tests/multi/memory/conversation-repo.test.ts
git commit -m "feat(multi/memory): chat_id, external_message_id, inline embedding on bc_conversation"
```

---

### Task 3: ConversationRepo semantic search + backfill helpers

**Files:**
- Create: `src/multi/memory/conversation-search.ts`
- Modify: `src/multi/memory/conversation-repo.ts`
- Create: `tests/multi/memory/conversation-search.test.ts`
- Create: `tests/multi/memory/conversation-repo-embedding.test.ts`

**Rationale:** Splits SQL construction into a pure helper so the query builder can be unit-tested without a database. The repo method delegates to the builder and executes the query. Also adds `listMissingEmbeddings` used by backfill.

- [ ] **Step 1: Create the SQL builder helper with a unit test**

Create `tests/multi/memory/conversation-search.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { buildConversationSearchSQL } from '../../../src/multi/memory/conversation-search.js'

describe('buildConversationSearchSQL', () => {
  it('builds the minimal query with just workspace + chat', () => {
    const { sql, params } = buildConversationSearchSQL({
      workspaceId: 'ws1',
      queryVecLiteral: '[0.1,0.2]',
      chatId: 'chat1',
      limit: 5,
    })
    expect(sql).toContain("embedding <=> $1::vector as distance")
    expect(sql).toContain('chat_id = $2')
    expect(sql).toContain('order by embedding <=> $1::vector')
    expect(sql).toContain('limit $3')
    expect(params).toEqual(['[0.1,0.2]', 'chat1', 5])
  })

  it('adds role filter when specified', () => {
    const { sql, params } = buildConversationSearchSQL({
      workspaceId: 'ws1',
      queryVecLiteral: '[0]',
      chatId: 'c',
      limit: 3,
      role: 'user',
    })
    expect(sql).toContain('role = $4')
    expect(params).toContain('user')
  })

  it('omits role filter when role = any', () => {
    const { sql } = buildConversationSearchSQL({
      workspaceId: 'ws1',
      queryVecLiteral: '[0]',
      chatId: 'c',
      limit: 3,
      role: 'any',
    })
    expect(sql).not.toContain('role =')
  })

  it('adds since/until filters', () => {
    const { sql, params } = buildConversationSearchSQL({
      workspaceId: 'ws1',
      queryVecLiteral: '[0]',
      chatId: 'c',
      limit: 3,
      since: '2026-01-01',
      until: '2026-12-31',
    })
    expect(sql).toContain('created_at >=')
    expect(sql).toContain('created_at <=')
    expect(params).toContain('2026-01-01')
    expect(params).toContain('2026-12-31')
  })

  it('excludes the most recent N rows via NOT IN subquery', () => {
    const { sql, params } = buildConversationSearchSQL({
      workspaceId: 'ws1',
      queryVecLiteral: '[0]',
      chatId: 'c',
      limit: 5,
      excludeRecentN: 200,
    })
    expect(sql).toContain('not in (')
    expect(sql).toContain('order by created_at desc')
    expect(params).toContain(200)
  })

  it('always skips summarized rows and null embeddings', () => {
    const { sql } = buildConversationSearchSQL({
      workspaceId: 'ws1',
      queryVecLiteral: '[0]',
      chatId: 'c',
      limit: 3,
    })
    expect(sql).toContain('embedding is not null')
    expect(sql).toContain("coalesce(meta->>'summarized', 'false') <> 'true'")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/multi/memory/conversation-search.test.ts`

Expected: FAIL with `Cannot find module '../../../src/multi/memory/conversation-search.js'`.

- [ ] **Step 3: Create the SQL builder**

Create `src/multi/memory/conversation-search.ts`:

```typescript
/**
 * Pure SQL builder for semantic search over bc_conversation.
 *
 * Extracted from ConversationRepo so it can be unit-tested without a database.
 * The caller (ConversationRepo.searchByEmbedding) wraps the result in a
 * withWorkspace() RLS-scoped client.query.
 *
 * Hard invariants (unconditional):
 *   - embedding must not be null
 *   - summarized rows (meta.summarized = 'true') are skipped
 *   - results are scoped to the given chat_id
 */

export interface BuildConversationSearchInput {
  workspaceId: string
  queryVecLiteral: string
  chatId: string
  limit: number
  role?: 'user' | 'assistant' | 'any'
  since?: string // ISO date
  until?: string // ISO date
  /** When set, exclude the N most recent rows in this chat (they are already
   *  loaded into live context by loadAgentContext). */
  excludeRecentN?: number
}

export interface BuildConversationSearchResult {
  sql: string
  params: unknown[]
}

export function buildConversationSearchSQL(
  input: BuildConversationSearchInput,
): BuildConversationSearchResult {
  // $1 = queryVec, $2 = chatId, $3 = limit — these three are always present.
  const params: unknown[] = [input.queryVecLiteral, input.chatId, input.limit]
  const whereClauses: string[] = [
    'embedding is not null',
    'chat_id = $2',
    `coalesce(meta->>'summarized', 'false') <> 'true'`,
  ]

  if (input.role && input.role !== 'any') {
    params.push(input.role)
    whereClauses.push(`role = $${params.length}`)
  }

  if (input.since) {
    params.push(input.since)
    whereClauses.push(`created_at >= $${params.length}`)
  }

  if (input.until) {
    params.push(input.until)
    whereClauses.push(`created_at <= $${params.length}`)
  }

  if (input.excludeRecentN && input.excludeRecentN > 0) {
    params.push(input.excludeRecentN)
    whereClauses.push(
      `id not in (
         select id from bc_conversation
         where chat_id = $2
         order by created_at desc
         limit $${params.length}
       )`,
    )
  }

  const sql = `
    select *, embedding <=> $1::vector as distance
    from bc_conversation
    where ${whereClauses.join(' and ')}
    order by embedding <=> $1::vector
    limit $3
  `

  return { sql, params }
}
```

- [ ] **Step 4: Run unit test**

Run: `npx vitest run tests/multi/memory/conversation-search.test.ts`

Expected: all 6 tests pass.

- [ ] **Step 5: Add repo methods that use the builder**

Append to `ConversationRepo` in `src/multi/memory/conversation-repo.ts`, immediately after `setEmbedding`:

```typescript
  async searchByEmbedding(
    workspaceId: string,
    queryVec: number[],
    opts: {
      chatId: string
      limit: number
      role?: 'user' | 'assistant' | 'any'
      since?: string
      until?: string
      excludeRecentN?: number
    },
  ): Promise<Array<Conversation & { distance: number }>> {
    const { buildConversationSearchSQL } = await import('./conversation-search.js')
    const { sql, params } = buildConversationSearchSQL({
      workspaceId,
      queryVecLiteral: toPgVector(queryVec),
      chatId: opts.chatId,
      limit: opts.limit,
      role: opts.role,
      since: opts.since,
      until: opts.until,
      excludeRecentN: opts.excludeRecentN,
    })
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(sql, params)
      return rows.map((r: any) => ({
        ...rowToConversation(r),
        distance: parseFloat(r.distance),
      }))
    })
  }

  async listMissingEmbeddings(workspaceId: string, limit: number): Promise<Conversation[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_conversation
         where embedding is null
           and role in ('user','assistant')
           and length(content) >= 10
           and coalesce(meta->>'summarized', 'false') <> 'true'
         order by created_at asc
         limit $1`,
        [limit],
      )
      return rows.map(rowToConversation)
    })
  }
```

Note: the `await import('./conversation-search.js')` dynamic import keeps the helper isolated even if a consumer imports the repo without pulling in the helper. Static import would also work — pick `import { buildConversationSearchSQL } from './conversation-search.js'` at the top of the file instead and drop the dynamic import inside the method. Use the static import for simplicity.

Replace the method body to use the static import:

```typescript
  async searchByEmbedding(
    workspaceId: string,
    queryVec: number[],
    opts: {
      chatId: string
      limit: number
      role?: 'user' | 'assistant' | 'any'
      since?: string
      until?: string
      excludeRecentN?: number
    },
  ): Promise<Array<Conversation & { distance: number }>> {
    const { sql, params } = buildConversationSearchSQL({
      workspaceId,
      queryVecLiteral: toPgVector(queryVec),
      chatId: opts.chatId,
      limit: opts.limit,
      role: opts.role,
      since: opts.since,
      until: opts.until,
      excludeRecentN: opts.excludeRecentN,
    })
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(sql, params)
      return rows.map((r: any) => ({
        ...rowToConversation(r),
        distance: parseFloat(r.distance),
      }))
    })
  }
```

And add at the top of `conversation-repo.ts`:

```typescript
import { buildConversationSearchSQL } from './conversation-search.js'
```

- [ ] **Step 6: Write failing integration test for searchByEmbedding**

Create `tests/multi/memory/conversation-repo-embedding.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'
import { ConversationRepo } from '../../../src/multi/memory/conversation-repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('ConversationRepo semantic search', () => {
  let pool: Pool
  let wsRepo: WorkspaceRepo
  let repo: ConversationRepo
  let workspaceId: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    wsRepo = new WorkspaceRepo(pool)
    // No gemini — tests use manually-set embeddings
    repo = new ConversationRepo(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('truncate workspaces cascade')
    const ws = await wsRepo.upsertForTelegram(1)
    workspaceId = ws.id
  })

  async function seedRow(
    content: string,
    embedding: number[],
    opts: { role?: 'user' | 'assistant'; chatId?: string; externalMessageId?: number } = {},
  ): Promise<string> {
    const msg = await repo.append(workspaceId, {
      channel: 'telegram',
      role: opts.role ?? 'user',
      content,
      chatId: opts.chatId ?? '100',
      externalMessageId: opts.externalMessageId,
    })
    await repo.setEmbedding(workspaceId, msg.id, embedding)
    return msg.id
  }

  it('returns rows ordered by cosine distance', async () => {
    // 3-d vectors are enough for the behaviour test; pad to 768 at the end.
    const pad = (v: number[]): number[] => [...v, ...Array(768 - v.length).fill(0)]
    await seedRow('apple', pad([1, 0, 0]))
    await seedRow('banana', pad([0, 1, 0]))
    await seedRow('cherry', pad([0, 0, 1]))

    const results = await repo.searchByEmbedding(workspaceId, pad([0.9, 0.1, 0]), {
      chatId: '100',
      limit: 2,
    })
    expect(results).toHaveLength(2)
    expect(results[0].content).toBe('apple')
    expect(results[0].distance).toBeLessThan(results[1].distance)
  })

  it('filters by role', async () => {
    const pad = (v: number[]): number[] => [...v, ...Array(768 - v.length).fill(0)]
    await seedRow('user-a', pad([1, 0, 0]), { role: 'user' })
    await seedRow('assistant-a', pad([1, 0, 0]), { role: 'assistant' })
    const results = await repo.searchByEmbedding(workspaceId, pad([1, 0, 0]), {
      chatId: '100',
      limit: 10,
      role: 'assistant',
    })
    expect(results).toHaveLength(1)
    expect(results[0].role).toBe('assistant')
  })

  it('filters by chat_id', async () => {
    const pad = (v: number[]): number[] => [...v, ...Array(768 - v.length).fill(0)]
    await seedRow('in-chat-a', pad([1, 0, 0]), { chatId: 'A' })
    await seedRow('in-chat-b', pad([1, 0, 0]), { chatId: 'B' })
    const results = await repo.searchByEmbedding(workspaceId, pad([1, 0, 0]), {
      chatId: 'A',
      limit: 10,
    })
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('in-chat-a')
  })

  it('excludes recent N rows', async () => {
    const pad = (v: number[]): number[] => [...v, ...Array(768 - v.length).fill(0)]
    for (let i = 0; i < 5; i++) {
      await seedRow(`msg-${i}`, pad([1, 0, 0]))
      await new Promise((r) => setTimeout(r, 5))
    }
    const results = await repo.searchByEmbedding(workspaceId, pad([1, 0, 0]), {
      chatId: '100',
      limit: 10,
      excludeRecentN: 3,
    })
    // 5 total rows, exclude 3 most recent → only msg-0 and msg-1 left
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.content).sort()).toEqual(['msg-0', 'msg-1'])
  })

  it('listMissingEmbeddings skips short and summarized rows', async () => {
    // too short (< 10 chars)
    await repo.append(workspaceId, { channel: 'telegram', role: 'user', content: 'ok' })
    // summarized
    const summarized = await repo.append(workspaceId, {
      channel: 'telegram',
      role: 'user',
      content: 'long enough content here',
    })
    await repo.markSummarized(workspaceId, [summarized.id])
    // valid
    await repo.append(workspaceId, {
      channel: 'telegram',
      role: 'user',
      content: 'this one should be backfilled',
    })

    const missing = await repo.listMissingEmbeddings(workspaceId, 10)
    expect(missing).toHaveLength(1)
    expect(missing[0].content).toBe('this one should be backfilled')
  })
})
```

- [ ] **Step 7: Run tests — they should pass**

Run: `BC_TEST_DATABASE_URL=postgres://... npx vitest run tests/multi/memory/conversation-repo-embedding.test.ts tests/multi/memory/conversation-search.test.ts`

Expected: all pass. If integration tests skip because `BC_TEST_DATABASE_URL` is unset, set it to a local pgvector-enabled DB.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`

Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/multi/memory/conversation-search.ts src/multi/memory/conversation-repo.ts tests/multi/memory/conversation-search.test.ts tests/multi/memory/conversation-repo-embedding.test.ts
git commit -m "feat(multi/memory): semantic search + listMissingEmbeddings for bc_conversation"
```

---

### Task 4: Plumb chat_id + external_message_id from Telegram into bot-router → convRepo

**Files:**
- Modify: `src/multi/bot-router/router.ts`

**Rationale:** Bot router already persists the user message (line 273–287 in the current file). This task extends that append call to include `chatId` and `externalMessageId` from the inbound event, which already carries them (`ev.chatId`, `ev.messageId`). For the assistant row we wait until we know the outgoing message id — Task 6 handles that.

- [ ] **Step 1: Modify the user-message append in router.ts**

In `src/multi/bot-router/router.ts`, find this block (roughly around line 273):

```typescript
      if (this.deps.convRepo) {
        try {
          await this.deps.convRepo.append(workspace.id, {
            channel: ev.channel,
            role: 'user',
            content: ev.text,
          } as any)
```

Replace with:

```typescript
      if (this.deps.convRepo) {
        try {
          await this.deps.convRepo.append(workspace.id, {
            channel: ev.channel,
            role: 'user',
            content: ev.text,
            chatId: ev.chatId,
            externalMessageId: /^\d+$/.test(ev.messageId) ? Number(ev.messageId) : null,
          })
```

Rationale: `InboundEvent.messageId` is typed as `string`, and Telegram message ids are numeric — but we guard with a regex in case a future channel uses non-numeric ids. The `as any` cast was there because `AppendInput` was still loose; after Task 2 it's fully typed, so the cast can be dropped.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: clean. If it errors on `AppendInput`, double-check Task 2 exports.

- [ ] **Step 3: Start the dev server or run router tests**

If `tests/multi/bot-router/` has a router test, run it: `npx vitest run tests/multi/bot-router/`.

Otherwise, do a targeted smoke test by creating `tests/multi/bot-router/chat-id-plumbing.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { BotRouter } from '../../../src/multi/bot-router/router.js'
import type { InboundEvent } from '../../../src/multi/channels/base.js'

describe('BotRouter chat_id plumbing', () => {
  it('passes chatId and numeric externalMessageId to convRepo.append for user messages', async () => {
    const appendSpy = vi.fn().mockResolvedValue({ id: 'row1' })
    const fakeChannel = {
      name: 'telegram' as const,
      start: async () => {},
      stop: async () => {},
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      onMessage: () => {},
    }
    const router = new BotRouter({
      wsRepo: {
        upsertForTelegram: vi.fn().mockResolvedValue({ id: 'ws1', status: 'active', displayName: 'X', addressForm: 'ty' }),
        upsertForMax: vi.fn(),
        updateLastActiveChannel: vi.fn(),
      } as any,
      personaRepo: {
        findByWorkspace: vi.fn().mockResolvedValue({ behaviorConfig: {}, voiceId: 'v' }),
      } as any,
      factsRepo: {} as any,
      convRepo: { append: appendSpy } as any,
      linkingSvc: { verifyAndLink: vi.fn() } as any,
      channels: { telegram: fakeChannel as any },
      runBetsyFn: vi.fn().mockResolvedValue({ text: 'hi', toolCalls: [], tokensUsed: 0 }),
      runBetsyDeps: {} as any,
    })

    const ev: InboundEvent = {
      channel: 'telegram',
      chatId: '99',
      userId: '1',
      userDisplay: 'u',
      text: 'привет',
      messageId: '42',
      timestamp: new Date(),
      isVoiceMessage: false,
      raw: null,
    }
    await router.handleInbound(ev)

    expect(appendSpy).toHaveBeenCalledWith('ws1', expect.objectContaining({
      chatId: '99',
      externalMessageId: 42,
    }))
  })
})
```

Run: `npx vitest run tests/multi/bot-router/chat-id-plumbing.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/multi/bot-router/router.ts tests/multi/bot-router/chat-id-plumbing.test.ts
git commit -m "feat(multi/bot-router): persist chat_id and external_message_id on user messages"
```

---

### Task 5: Run-context type + recall tools

**Files:**
- Create: `src/multi/agents/run-context.ts`
- Create: `src/multi/agents/tools/recall-tools.ts`
- Create: `tests/multi/agents/tools/recall-tools.test.ts`

**Rationale:** Introduces the two new tools (`recall_messages`, `set_reply_target`) in their own file so `memory-tools.ts` stays focused on factual memory. `RunContext` is a tiny mutable object — the tool factory closes over it, the runner reads it after the agent loop finishes.

- [ ] **Step 1: Create the run-context type**

Create `src/multi/agents/run-context.ts`:

```typescript
/**
 * Per-turn mutable context shared between tool executions and the runner.
 *
 * Tools that need to influence how the final response is delivered (e.g.
 * set_reply_target, which makes the assistant's reply a Telegram reply-quote
 * of an earlier message) write into this object. The runner reads it after
 * the agent loop completes and propagates the values into BetsyResponse.
 *
 * One instance per turn. Never shared across turns.
 */
export interface RunContext {
  /** When set, the outgoing assistant reply should be sent as a Telegram reply
   *  to the message with this id. */
  replyTarget?: number
}

export function createRunContext(): RunContext {
  return {}
}
```

- [ ] **Step 2: Write failing test for the tools**

Create `tests/multi/agents/tools/recall-tools.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createRecallTools } from '../../../../src/multi/agents/tools/recall-tools.js'
import { createRunContext } from '../../../../src/multi/agents/run-context.js'

function fakeGemini() {
  return {
    models: {
      embedContent: vi.fn().mockResolvedValue({
        embeddings: [{ values: Array(768).fill(0.1) }],
      }),
    },
  } as any
}

function fakeConvRepo(hits: any[]) {
  return {
    searchByEmbedding: vi.fn().mockResolvedValue(hits),
  } as any
}

describe('createRecallTools', () => {
  it('recall_messages embeds the query and returns shaped hits', async () => {
    const hits = [
      {
        id: 'r1',
        role: 'user',
        content: 'люблю чай с лимоном',
        chatId: '100',
        externalMessageId: 42,
        createdAt: new Date('2026-04-01T10:00:00Z'),
        distance: 0.15,
      },
    ]
    const convRepo = fakeConvRepo(hits)
    const gemini = fakeGemini()
    const runContext = createRunContext()
    const tools = createRecallTools({
      convRepo,
      gemini,
      workspaceId: 'ws1',
      currentChatId: '100',
      currentChannel: 'telegram',
      runContext,
    })
    const recall = tools.find((t) => t.name === 'recall_messages')!
    const result = (await recall.execute({ query: 'что я пью' })) as any

    expect(gemini.models.embedContent).toHaveBeenCalled()
    expect(convRepo.searchByEmbedding).toHaveBeenCalledWith(
      'ws1',
      expect.any(Array),
      expect.objectContaining({ chatId: '100', role: 'any', excludeRecentN: 200 }),
    )
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({
      role: 'user',
      content: 'люблю чай с лимоном',
      externalMessageId: 42,
      similarity: expect.any(Number),
    })
    expect(result.matches[0].similarity).toBeCloseTo(0.85, 2) // 1 - 0.15
  })

  it('recall_messages passes role/since/until/limit through', async () => {
    const convRepo = fakeConvRepo([])
    const gemini = fakeGemini()
    const runContext = createRunContext()
    const tools = createRecallTools({
      convRepo,
      gemini,
      workspaceId: 'ws1',
      currentChatId: '100',
      currentChannel: 'telegram',
      runContext,
    })
    const recall = tools.find((t) => t.name === 'recall_messages')!
    await recall.execute({
      query: 'x',
      role: 'assistant',
      limit: 7,
      since: '2026-01-01',
      until: '2026-12-31',
    })
    expect(convRepo.searchByEmbedding).toHaveBeenCalledWith(
      'ws1',
      expect.any(Array),
      expect.objectContaining({
        role: 'assistant',
        limit: 7,
        since: '2026-01-01',
        until: '2026-12-31',
      }),
    )
  })

  it('recall_messages clamps limit to <= 20', async () => {
    const convRepo = fakeConvRepo([])
    const gemini = fakeGemini()
    const tools = createRecallTools({
      convRepo,
      gemini,
      workspaceId: 'ws1',
      currentChatId: '100',
      currentChannel: 'telegram',
      runContext: createRunContext(),
    })
    const recall = tools.find((t) => t.name === 'recall_messages')!
    await recall.execute({ query: 'x', limit: 999 })
    expect(convRepo.searchByEmbedding).toHaveBeenCalledWith(
      'ws1',
      expect.any(Array),
      expect.objectContaining({ limit: 20 }),
    )
  })

  it('set_reply_target writes into runContext', async () => {
    const convRepo = fakeConvRepo([])
    const gemini = fakeGemini()
    const runContext = createRunContext()
    const tools = createRecallTools({
      convRepo,
      gemini,
      workspaceId: 'ws1',
      currentChatId: '100',
      currentChannel: 'telegram',
      runContext,
    })
    const setReply = tools.find((t) => t.name === 'set_reply_target')!
    const result = (await setReply.execute({ externalMessageId: 42 })) as any
    expect(runContext.replyTarget).toBe(42)
    expect(result.ok).toBe(true)
  })

  it('set_reply_target is a no-op when currentChannel is not telegram', async () => {
    const tools = createRecallTools({
      convRepo: fakeConvRepo([]),
      gemini: fakeGemini(),
      workspaceId: 'ws1',
      currentChatId: '100',
      currentChannel: 'max',
      runContext: createRunContext(),
    })
    const setReply = tools.find((t) => t.name === 'set_reply_target')!
    const result = (await setReply.execute({ externalMessageId: 42 })) as any
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/only telegram/i)
  })
})
```

- [ ] **Step 3: Run test — should fail**

Run: `npx vitest run tests/multi/agents/tools/recall-tools.test.ts`

Expected: FAIL with `Cannot find module '.../recall-tools.js'`.

- [ ] **Step 4: Create the tools file**

Create `src/multi/agents/tools/recall-tools.ts`:

```typescript
import { z } from 'zod'
import type { GoogleGenAI } from '@google/genai'
import type { ConversationRepo } from '../../memory/conversation-repo.js'
import { embedText } from '../../memory/embeddings.js'
import { log } from '../../observability/logger.js'
import type { MemoryTool } from './memory-tools.js'
import type { RunContext } from '../run-context.js'

const DEFAULT_LIMIT = Number(process.env.BC_RECALL_DEFAULT_LIMIT ?? 5)
const MAX_LIMIT = 20
const EXCLUDE_RECENT_N = Number(process.env.BC_RECALL_EXCLUDE_RECENT_N ?? 200)

export interface RecallToolsDeps {
  convRepo: ConversationRepo
  gemini: GoogleGenAI
  workspaceId: string
  currentChatId: string
  currentChannel: 'telegram' | 'max'
  runContext: RunContext
}

export function createRecallTools(deps: RecallToolsDeps): MemoryTool[] {
  const { convRepo, gemini, workspaceId, currentChatId, currentChannel, runContext } = deps

  const recallParams = z.object({
    query: z.string().min(1).max(500).describe('Что искать. Свободный текст на русском.'),
    role: z
      .enum(['user', 'assistant', 'any'])
      .optional()
      .describe('Чьи реплики искать: user — мои, assistant — твои, any — любые.'),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    since: z
      .string()
      .optional()
      .describe('ISO-дата (YYYY-MM-DD). Только сообщения начиная с этой даты.'),
    until: z
      .string()
      .optional()
      .describe('ISO-дата (YYYY-MM-DD). Только сообщения до этой даты включительно.'),
  })

  const recallMessages: MemoryTool = {
    name: 'recall_messages',
    description:
      'Семантический поиск по старым сообщениям из этого чата (уже выпавшим из активного контекста). ' +
      'Используй когда юзер просит вспомнить что-то конкретное из прошлого: "что я говорил про X", ' +
      '"когда ты обещала Y", "о чём мы говорили вчера про Z". Возвращает массив matches с content, role, ' +
      'externalMessageId и similarity (0..1). После выбора нужного сообщения используй set_reply_target ' +
      'чтобы процитировать его реплаем.',
    parameters: recallParams,
    async execute(params) {
      const parsed = recallParams.parse(params)
      const limit = Math.min(parsed.limit ?? DEFAULT_LIMIT, MAX_LIMIT)

      let queryVec: number[]
      try {
        queryVec = await embedText(gemini, parsed.query)
      } catch (e) {
        log().warn('recall_messages: embed failed', {
          workspaceId,
          error: e instanceof Error ? e.message : String(e),
        })
        return { matches: [], error: 'embedding_failed' }
      }

      const hits = await convRepo.searchByEmbedding(workspaceId, queryVec, {
        chatId: currentChatId,
        limit,
        role: parsed.role ?? 'any',
        since: parsed.since,
        until: parsed.until,
        excludeRecentN: EXCLUDE_RECENT_N,
      })

      return {
        matches: hits.map((h) => ({
          role: h.role,
          content: h.content.length > 300 ? h.content.slice(0, 300) + '…' : h.content,
          externalMessageId: h.externalMessageId,
          chatId: h.chatId,
          timestamp:
            h.createdAt instanceof Date ? h.createdAt.toISOString() : String(h.createdAt),
          similarity: Number((1 - h.distance).toFixed(3)),
        })),
      }
    },
  }

  const setReplyTargetParams = z.object({
    externalMessageId: z
      .number()
      .int()
      .positive()
      .describe('externalMessageId из recall_messages результата.'),
  })
  const setReplyTarget: MemoryTool = {
    name: 'set_reply_target',
    description:
      'Пометить следующий твой ответ как реплай на указанное сообщение (Telegram reply-quote). ' +
      'Вызывай ОДИН раз перед финальным текстом. Твой обычный текстовый ответ станет комментарием ' +
      'к процитированному сообщению. Работает только в Telegram.',
    parameters: setReplyTargetParams,
    async execute(params) {
      const parsed = setReplyTargetParams.parse(params)
      if (currentChannel !== 'telegram') {
        return { ok: false, reason: 'reply-quote only telegram supported in v1' }
      }
      runContext.replyTarget = parsed.externalMessageId
      log().info('set_reply_target: target set', { workspaceId, externalMessageId: parsed.externalMessageId })
      return { ok: true }
    },
  }

  return [recallMessages, setReplyTarget]
}
```

- [ ] **Step 5: Run test — should pass**

Run: `npx vitest run tests/multi/agents/tools/recall-tools.test.ts`

Expected: all 5 tests pass.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/multi/agents/run-context.ts src/multi/agents/tools/recall-tools.ts tests/multi/agents/tools/recall-tools.test.ts
git commit -m "feat(multi/agents): recall_messages + set_reply_target tools"
```

---

### Task 6: Channel adapter — honour replyToMessageId + return outgoing id + replyToPromise in streams

**Files:**
- Modify: `src/multi/channels/base.ts`
- Modify: `src/multi/channels/telegram.ts`
- Test: `tests/multi/channels/telegram.test.ts` (extend)

**Rationale:** `OutboundMessage.replyToMessageId` already exists in the type but `TelegramAdapter.sendMessage` ignores it — wire it into grammy's `reply_parameters`. Additionally, we need to (a) capture the outgoing message id so the runner can store it on the assistant row, and (b) support late-resolved reply targets in the streaming path via `replyToPromise`.

- [ ] **Step 1: Extend `StreamableOutbound` in `base.ts`**

Replace the existing `StreamableOutbound` interface in `src/multi/channels/base.ts` with:

```typescript
export interface StreamableOutbound {
  chatId: string
  /** Async iterable that yields incrementally growing text. Each yield is the
   *  full accumulated text so far (NOT just the delta). */
  textStream: AsyncIterable<string>
  /** Optional explicit final text; if absent the last yielded value is used. */
  finalText?: string
  /** Resolves (just before final send) with an optional Telegram message id
   *  the final outgoing message should quote as a reply. Used by recall_messages
   *  + set_reply_target flow. Returning undefined = no reply-quote. */
  replyToPromise?: Promise<number | undefined>
}
```

Also extend `ChannelAdapter.sendMessage` to return a structured result:

```typescript
export interface SendResult {
  /** Platform-native outgoing message id (Telegram message_id). Undefined if the
   *  platform does not return one or the adapter could not capture it. */
  externalMessageId?: number
}

export interface ChannelAdapter {
  readonly name: ChannelName
  start(): Promise<void>
  stop(): Promise<void>
  sendMessage(msg: OutboundMessage): Promise<SendResult>
  onMessage(handler: (ev: InboundEvent) => Promise<void>): void
  sendTyping?(chatId: string, action?: string): Promise<void>
  /** Stream a message via native channel streaming API if supported. */
  streamMessage?(msg: StreamableOutbound): Promise<SendResult>
}
```

The return type change from `Promise<void>` to `Promise<SendResult>` is source-compatible because `void`-returning callers don't check the result, but it enables callers that DO need the id. TypeScript will force every adapter and caller to return `SendResult` (or `{}`), so the compiler will guide the fix-up across the codebase. That's fine — work through each error in subsequent steps.

- [ ] **Step 2: Update `TelegramAdapter.sendMessage` to use reply_parameters and return SendResult**

In `src/multi/channels/telegram.ts`, replace the existing `sendMessage` method with:

```typescript
  async sendMessage(msg: OutboundMessage): Promise<import('./base.js').SendResult> {
    const chatId = Number(msg.chatId)
    const replyParams =
      msg.replyToMessageId != null
        ? {
            reply_parameters: {
              message_id: Number(msg.replyToMessageId),
              allow_sending_without_reply: true,
            },
          }
        : {}

    // If image present — send as photo with caption
    if (msg.image) {
      const captionHtml = msg.text ? markdownToTelegramHTML(msg.text) : undefined
      const opts: any = {
        ...replyParams,
        ...(captionHtml ? { caption: captionHtml, parse_mode: 'HTML' as const } : {}),
      }
      try {
        let out
        if ('url' in msg.image) {
          out = await this.bot.api.sendPhoto(chatId, msg.image.url, opts)
        } else {
          const buf = Buffer.from(msg.image.base64, 'base64')
          out = await this.bot.api.sendPhoto(chatId, new InputFile(buf, 'image.png'), opts)
        }
        return { externalMessageId: out?.message_id }
      } catch (e: any) {
        if (e?.error_code === 400 && msg.text) {
          // Retry without parse_mode
          const retryOpts: any = { ...replyParams, caption: msg.text }
          let out
          if ('url' in msg.image) {
            out = await this.bot.api.sendPhoto(chatId, msg.image.url, retryOpts)
          } else {
            const buf = Buffer.from(msg.image.base64, 'base64')
            out = await this.bot.api.sendPhoto(chatId, new InputFile(buf, 'image.png'), retryOpts)
          }
          return { externalMessageId: out?.message_id }
        }
        throw e
      }
    }

    // Text always
    let textOutId: number | undefined
    if (msg.text && msg.text.length > 0) {
      textOutId = await sendHtmlOrPlainReturningId(this.bot, chatId, msg.text, replyParams)
    }

    // Audio as voice message (no reply quote attached — voice is a secondary artifact)
    if (msg.audio) {
      const buf = Buffer.from(msg.audio.base64, 'base64')
      await this.bot.api.sendVoice(chatId, new InputFile(buf, 'voice.ogg'))
    }

    return { externalMessageId: textOutId }
  }
```

And replace the top-of-file `sendHtmlOrPlain` with an id-returning version:

```typescript
/** Send text with parse_mode=HTML; on Telegram 400 fall back to plain text.
 *  Returns the outgoing message_id (undefined if capture failed). */
async function sendHtmlOrPlainReturningId(
  bot: Bot,
  chatId: number,
  text: string,
  extraOpts: Record<string, unknown> = {},
): Promise<number | undefined> {
  const html = markdownToTelegramHTML(text)
  try {
    const out = await bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', ...extraOpts })
    return out?.message_id
  } catch (e: any) {
    if (e?.error_code === 400) {
      try {
        const out = await bot.api.sendMessage(chatId, text, extraOpts)
        return out?.message_id
      } catch {
        return undefined
      }
    } else {
      throw e
    }
  }
}

/** Backwards-compatible alias used inside streamMessage. */
async function sendHtmlOrPlain(
  bot: Bot,
  chatId: number,
  text: string,
): Promise<void> {
  await sendHtmlOrPlainReturningId(bot, chatId, text)
}
```

- [ ] **Step 3: Update `streamMessage` to await replyToPromise before finalizing**

Replace the `streamMessage` method body in `src/multi/channels/telegram.ts` with:

```typescript
  async streamMessage(msg: StreamableOutbound): Promise<import('./base.js').SendResult> {
    const chatIdNum = Number(msg.chatId)
    const draftId =
      ((Date.now() & 0x7fffffff) ^ Math.floor(Math.random() * 0x7fffffff)) || 1
    let lastText = ''
    let draftSupported = true
    let throttleUntil = 0
    let streamFailed = false

    try {
      for await (const accumulated of msg.textStream) {
        if (!accumulated || accumulated === lastText) continue
        lastText = accumulated

        if (!draftSupported) continue

        const now = Date.now()
        if (now < throttleUntil) continue
        throttleUntil = now + 200

        const chunkText = accumulated.length > 4096 ? accumulated.slice(0, 4096) : accumulated
        const chunkHtml = markdownToTelegramHTML(chunkText)

        try {
          await (this.bot.api.raw as any).sendMessageDraft({
            chat_id: chatIdNum,
            draft_id: draftId,
            text: chunkHtml,
            parse_mode: 'HTML',
          })
        } catch (e: any) {
          const desc: string = e?.description ?? e?.message ?? ''
          if (
            e?.error_code === 404 ||
            /method not found|not implemented|unknown method/i.test(desc)
          ) {
            draftSupported = false
          } else {
            draftSupported = false
          }
        }
      }
    } catch (e) {
      streamFailed = true
      throw e
    }

    if (streamFailed || !lastText || lastText.length === 0) {
      return {}
    }

    // Stream ended naturally. Check if a recall tool set a reply target; if so,
    // send the final message as a reply-quote (drafts expire on their own).
    let replyTo: number | undefined
    if (msg.replyToPromise) {
      try {
        // Short guard timeout — the promise should resolve immediately since
        // the agent loop has already finished by the time we reach here.
        replyTo = await Promise.race([
          msg.replyToPromise,
          new Promise<undefined>((r) => setTimeout(() => r(undefined), 2000)),
        ])
      } catch {
        replyTo = undefined
      }
    }

    const finalText = lastText.length > 4096 ? lastText.slice(0, 4096) : lastText
    const replyParams =
      replyTo != null
        ? {
            reply_parameters: {
              message_id: replyTo,
              allow_sending_without_reply: true,
            },
          }
        : {}
    const outId = await sendHtmlOrPlainReturningId(this.bot, chatIdNum, finalText, replyParams)
    return { externalMessageId: outId }
  }
```

- [ ] **Step 4: Fix all compile errors from the signature change**

Run: `npm run typecheck`

Expected: errors in places that destructure `sendMessage`'s `void` return, and in tests that mock channels. Work through each:
- Mock channels in tests: change `sendMessage: vi.fn().mockResolvedValue(undefined)` to `sendMessage: vi.fn().mockResolvedValue({})`.
- MaxAdapter (`src/multi/channels/max.ts`): add `return {}` at the end of `sendMessage`, and if it implements `streamMessage`, the same.
- Any `await channel.sendMessage(...)` call-site that ignored the return stays valid (the caller just discards).

After fixing each error, re-run `npm run typecheck` until clean.

- [ ] **Step 5: Extend telegram adapter test with reply_parameters assertion**

In `tests/multi/channels/telegram.test.ts`, add:

```typescript
  it('sendMessage forwards replyToMessageId to grammy reply_parameters', async () => {
    const sendSpy = vi.fn().mockResolvedValue({ message_id: 999 })
    const adapter = new TelegramAdapter('xxx')
    ;(adapter as any).bot = {
      api: {
        sendMessage: sendSpy,
      },
    }
    const result = await adapter.sendMessage({
      chatId: '100',
      text: 'hi',
      replyToMessageId: '42',
    })
    expect(sendSpy).toHaveBeenCalledWith(
      100,
      expect.any(String),
      expect.objectContaining({
        reply_parameters: { message_id: 42, allow_sending_without_reply: true },
      }),
    )
    expect(result.externalMessageId).toBe(999)
  })
```

Note: adjust the mock shape (`;(adapter as any).bot = {...}`) to match however existing tests stub the adapter. If the existing test file uses a different pattern, mirror it — the assertions matter, not the mock strategy.

Run: `npx vitest run tests/multi/channels/telegram.test.ts`

Expected: new test passes, existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/multi/channels/base.ts src/multi/channels/telegram.ts src/multi/channels/max.ts tests/multi/channels/telegram.test.ts
git commit -m "feat(multi/channels): honour replyToMessageId + return SendResult + streaming replyToPromise"
```

(Include `max.ts` in the commit only if you had to touch it to fix compile errors in Step 4.)

---

### Task 7: Runner — run context, replyTo in BetsyResponse, post-send external id capture

**Files:**
- Modify: `src/multi/agents/runner.ts`
- Modify: `src/multi/agents/betsy-factory.ts`
- Modify: `src/multi/bot-router/router.ts`
- Test: `tests/multi/agents/runner.test.ts` (extend)

**Rationale:** Wire the run context through the agent construction, extend `BetsyResponse` and `RunBetsyStreamResult` with `replyTo`, and update the bot router to (a) pass `replyTo` into `channel.sendMessage`, (b) capture the returned `externalMessageId` and write it to the assistant row.

- [ ] **Step 1: Extend `BetsyResponse` and `RunBetsyInput`**

In `src/multi/agents/runner.ts`, find `export interface RunBetsyInput` and extend it:

```typescript
export interface RunBetsyInput {
  workspaceId: string
  userMessage: string
  channel: 'telegram' | 'max'
  deps: RunBetsyDeps
  skipAppendUser?: boolean
  /** Chat-id of the current inbound message (required for recall + chat_id plumbing). */
  currentChatId: string
}
```

And extend `BetsyResponse`:

```typescript
export interface BetsyResponse {
  text: string
  audio?: { base64: string; mimeType: string }
  toolCalls: unknown[]
  tokensUsed: number
  /** Set by set_reply_target tool — outgoing reply should quote this message id. */
  replyTo?: number
}
```

And extend `RunBetsyStreamResult`:

```typescript
export interface RunBetsyStreamResult {
  textStream: AsyncIterable<string>
  done: Promise<{ text: string; toolCalls: unknown[]; tokensUsed: number; replyTo?: number }>
  /** Resolves (same as `done`) with just the reply target, for the channel
   *  adapter's streamMessage to await before its final send. */
  replyToPromise: Promise<number | undefined>
  /** The bc_conversation row id of the assistant message once it has been
   *  persisted. Runner callers use this with convRepo.setExternalMessageId
   *  after the outbound send returns. */
  assistantRowIdPromise: Promise<string | undefined>
}
```

And add to `runBetsy`'s non-streaming return type a second value — change the function to return `{ response: BetsyResponse; assistantRowId: string | undefined }`:

Actually this doubles the call-site pain. Simpler: add `assistantRowId?: string` directly to `BetsyResponse`. Use that.

```typescript
export interface BetsyResponse {
  text: string
  audio?: { base64: string; mimeType: string }
  toolCalls: unknown[]
  tokensUsed: number
  /** Set by set_reply_target tool — outgoing reply should quote this message id. */
  replyTo?: number
  /** bc_conversation.id of the just-persisted assistant row, so the caller can
   *  update it with the outbound external_message_id once the channel send returns. */
  assistantRowId?: string
}
```

- [ ] **Step 2: Create run context and pass through tool factories**

At the top of `runBetsy` function body, after `if (!persona) throw …`, add:

```typescript
  const { createRunContext } = await import('./run-context.js')
  const runContext = createRunContext()
```

(Or use a static import at the top of the file — simpler. Add `import { createRunContext } from './run-context.js'` to the imports.)

Then find the `memoryTools = createMemoryTools({...})` block and, immediately after it, add:

```typescript
  const { createRecallTools } = await import('./tools/recall-tools.js')
  const recallTools = createRecallTools({
    convRepo: deps.convRepo,
    gemini: deps.gemini,
    workspaceId,
    currentChatId: input.currentChatId,
    currentChannel: channel,
    runContext,
  })
```

(Again, prefer static `import { createRecallTools } from './tools/recall-tools.js'` at top.)

- [ ] **Step 3: Extend `BetsyTools` and wire into `createBetsyAgent`**

In `src/multi/agents/betsy-factory.ts`, extend `BetsyTools`:

```typescript
export interface BetsyTools {
  memoryTools: MemoryTool[]
  reminderTools: MemoryTool[]
  selfieTool: MemoryTool
  webSearchTool?: MemoryTool
  recallTools?: MemoryTool[]
}
```

And inside `createBetsyAgent`, update `allTools`:

```typescript
  const allTools = [
    ...tools.memoryTools,
    ...tools.reminderTools,
    tools.selfieTool,
    ...(tools.webSearchTool ? [tools.webSearchTool] : []),
    ...(tools.recallTools ?? []),
  ]
```

- [ ] **Step 4: Pass `recallTools` into `createBetsyAgent` from runBetsy and runBetsyStream**

In `runBetsy`, update the `createBetsyAgent` call:

```typescript
  const agent = createBetsyAgent({
    workspace,
    persona,
    ownerFacts: context.factContents,
    tools: { memoryTools, reminderTools, selfieTool, webSearchTool, recallTools },
    currentChannel: channel,
  })
```

Repeat the same three additions (run context, recallTools factory, tools bundle) inside `runBetsyStream` — it has its own copy of the agent construction.

- [ ] **Step 5: Persist assistant row id + replyTo in BetsyResponse (non-streaming)**

In `runBetsy`, find the `// Store assistant reply` block (around line 247). Replace with:

```typescript
  let assistantRowId: string | undefined
  try {
    const row = await deps.convRepo.append(workspaceId, {
      channel,
      role: 'assistant',
      content: result.text,
      toolCalls: result.toolCalls,
      tokensUsed: result.tokensUsed,
      chatId: input.currentChatId,
    })
    assistantRowId = row.id
    log().info('runBetsy: assistant message appended', { workspaceId, rowId: row.id })
  } catch (e) {
    log().error('runBetsy: append assistant failed', {
      workspaceId,
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }
```

Then at the bottom where we return, add `replyTo` and `assistantRowId`:

```typescript
  return {
    text: result.text,
    audio,
    toolCalls: result.toolCalls,
    tokensUsed: result.tokensUsed,
    replyTo: runContext.replyTarget,
    assistantRowId,
  }
```

- [ ] **Step 6: Expose replyToPromise + assistantRowIdPromise in runBetsyStream**

In `runBetsyStream`, the existing code builds an IIFE called `done`. We need to fork two additional promises that resolve BEFORE `done` fully finishes its post-processing — specifically, `replyToPromise` needs to resolve as soon as the agent loop ends (after `finalize()`), not after the background tasks are kicked off.

Replace the entire `done = (async () => {...})()` block with:

```typescript
  // Two resolvers exposed so the channel adapter can await the reply target
  // before its final send.
  let resolveReply!: (v: number | undefined) => void
  let resolveRowId!: (v: string | undefined) => void
  const replyToPromise: Promise<number | undefined> = new Promise((r) => {
    resolveReply = r
  })
  const assistantRowIdPromise: Promise<string | undefined> = new Promise((r) => {
    resolveRowId = r
  })

  const done = (async () => {
    let result: { text: string; toolCalls: unknown[]; tokensUsed: number }
    try {
      result = await finalize()
    } catch (e) {
      resolveReply(undefined)
      resolveRowId(undefined)
      throw e
    }
    // Agent loop is done — the reply target is now stable.
    resolveReply(runContext.replyTarget)

    log().info('runBetsyStream: agent done', {
      workspaceId,
      textLen: result.text?.length ?? 0,
      toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
      tokensUsed: result.tokensUsed,
      replyTo: runContext.replyTarget,
    })

    let assistantRowId: string | undefined
    try {
      const row = await deps.convRepo.append(workspaceId, {
        channel,
        role: 'assistant',
        content: result.text,
        toolCalls: result.toolCalls,
        tokensUsed: result.tokensUsed,
        chatId: input.currentChatId,
      })
      assistantRowId = row.id
    } catch (e) {
      log().error('runBetsyStream: append assistant failed', {
        workspaceId,
        error: e instanceof Error ? e.message : String(e),
      })
    }
    resolveRowId(assistantRowId)

    fireAndForgetSummarize(deps, workspaceId)
    fireAndForgetExtract(deps, workspaceId, userMessage, result.text)
    fireAndForgetBackfillEmbeddings(deps, workspaceId)

    return {
      text: result.text,
      toolCalls: result.toolCalls,
      tokensUsed: result.tokensUsed,
      replyTo: runContext.replyTarget,
    }
  })()

  return { textStream: wrappedStream, done, replyToPromise, assistantRowIdPromise }
```

- [ ] **Step 7: Update bot router to use replyTo, replyToPromise, assistantRowIdPromise**

In `src/multi/bot-router/router.ts`, first find the non-streaming branch (where `canStream` is false — around line 322). Replace:

```typescript
              const response = await withTimeout(
                this.deps.runBetsyFn({
                  workspaceId: workspace.id,
                  userMessage: ev.text,
                  channel: ev.channel,
                  deps: this.deps.runBetsyDeps,
                  skipAppendUser: true,
                }),
                ATTEMPT_TIMEOUT_MS,
                'runBetsy',
              )
              log().info('runBetsy returned', {
                workspaceId: workspace.id,
                attempt,
                textLen: response.text?.length ?? 0,
                hasAudio: Boolean(response.audio),
                toolCalls: Array.isArray(response.toolCalls) ? response.toolCalls.length : 0,
              })
              await channel.sendMessage({
                chatId: ev.chatId,
                text: response.text,
                audio: response.audio && {
                  base64: response.audio.base64,
                  mimeType: response.audio.mimeType,
                },
              })
```

with:

```typescript
              const response = await withTimeout(
                this.deps.runBetsyFn({
                  workspaceId: workspace.id,
                  userMessage: ev.text,
                  channel: ev.channel,
                  deps: this.deps.runBetsyDeps,
                  skipAppendUser: true,
                  currentChatId: ev.chatId,
                }),
                ATTEMPT_TIMEOUT_MS,
                'runBetsy',
              )
              log().info('runBetsy returned', {
                workspaceId: workspace.id,
                attempt,
                textLen: response.text?.length ?? 0,
                hasAudio: Boolean(response.audio),
                toolCalls: Array.isArray(response.toolCalls) ? response.toolCalls.length : 0,
                replyTo: response.replyTo,
              })
              const sendResult = await channel.sendMessage({
                chatId: ev.chatId,
                text: response.text,
                audio: response.audio && {
                  base64: response.audio.base64,
                  mimeType: response.audio.mimeType,
                },
                replyToMessageId: response.replyTo != null ? String(response.replyTo) : undefined,
              })
              if (sendResult.externalMessageId != null && response.assistantRowId && this.deps.convRepo) {
                await this.deps.convRepo
                  .setExternalMessageId(workspace.id, response.assistantRowId, sendResult.externalMessageId)
                  .catch((e) =>
                    log().warn('bot-router: setExternalMessageId failed', {
                      workspaceId: workspace.id,
                      error: e instanceof Error ? e.message : String(e),
                    }),
                  )
              }
```

Then find the streaming branch (where `canStream` is true — around line 294). Replace:

```typescript
              const { textStream, done } = await this.deps.runBetsyStreamFn!({
                workspaceId: workspace.id,
                userMessage: ev.text,
                channel: ev.channel,
                deps: this.deps.runBetsyDeps,
                skipAppendUser: true,
              })
              const turnPromise = (async () => {
                await channel.streamMessage!({ chatId: ev.chatId, textStream })
                return done
              })()
              const result = await withTimeout(
                turnPromise.then((d) => d),
                ATTEMPT_TIMEOUT_MS,
                'runBetsyStream',
              )
              log().info('runBetsyStream returned', {
                workspaceId: workspace.id,
                attempt,
                textLen: result.text?.length ?? 0,
                toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
              })
```

with:

```typescript
              const { textStream, done, replyToPromise, assistantRowIdPromise } = await this.deps.runBetsyStreamFn!({
                workspaceId: workspace.id,
                userMessage: ev.text,
                channel: ev.channel,
                deps: this.deps.runBetsyDeps,
                skipAppendUser: true,
                currentChatId: ev.chatId,
              })
              const turnPromise = (async () => {
                const sendResult = await channel.streamMessage!({
                  chatId: ev.chatId,
                  textStream,
                  replyToPromise,
                })
                const d = await done
                // Persist outgoing message_id on the assistant row if we captured it.
                const rowId = await assistantRowIdPromise
                if (sendResult.externalMessageId != null && rowId && this.deps.convRepo) {
                  await this.deps.convRepo
                    .setExternalMessageId(workspace.id, rowId, sendResult.externalMessageId)
                    .catch((e) =>
                      log().warn('bot-router(stream): setExternalMessageId failed', {
                        workspaceId: workspace.id,
                        error: e instanceof Error ? e.message : String(e),
                      }),
                    )
                }
                return d
              })()
              const result = await withTimeout(
                turnPromise,
                ATTEMPT_TIMEOUT_MS,
                'runBetsyStream',
              )
              log().info('runBetsyStream returned', {
                workspaceId: workspace.id,
                attempt,
                textLen: result.text?.length ?? 0,
                toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
                replyTo: result.replyTo,
              })
```

- [ ] **Step 8: Extend runner test to assert replyTo propagates**

In `tests/multi/agents/runner.test.ts`, add a test:

```typescript
  it('runBetsy propagates runContext.replyTarget into BetsyResponse.replyTo', async () => {
    // Use the existing test harness pattern — mock convRepo, factsRepo, and a
    // fake agentRunner that invokes a stubbed set_reply_target during its run.
    const convRepo = {
      append: vi.fn().mockResolvedValue({ id: 'row1' }),
      recent: vi.fn().mockResolvedValue([]),
      listMissingEmbeddings: vi.fn().mockResolvedValue([]),
    }
    const factsRepo = {
      list: vi.fn().mockResolvedValue([]),
      listByKind: vi.fn().mockResolvedValue([]),
      searchByEmbedding: vi.fn().mockResolvedValue([]),
      listMissingEmbeddings: vi.fn().mockResolvedValue([]),
      remember: vi.fn(),
    }
    // The agentRunner stub must have access to the tools we passed to the agent
    // and invoke set_reply_target before returning. In the real runner, agent
    // construction gives us back the LlmAgent instance; we cheat by attaching
    // the tools on a side-channel in this test.
    const agentRunner = vi.fn(async (agent: any) => {
      const setReplyTool = agent.tools.find((t: any) => t.name === 'set_reply_target')
      await setReplyTool.execute({ externalMessageId: 777 })
      return { text: 'вот это ты говорил', toolCalls: [], tokensUsed: 0 }
    })

    const { runBetsy } = await import('../../../src/multi/agents/runner.js')
    const response = await runBetsy({
      workspaceId: 'ws1',
      userMessage: 'что я говорил про чай',
      channel: 'telegram',
      currentChatId: '100',
      deps: {
        wsRepo: { findById: vi.fn().mockResolvedValue({ id: 'ws1', plan: 'trial', displayName: 'X', addressForm: 'ty' }) } as any,
        personaRepo: { findByWorkspace: vi.fn().mockResolvedValue({ name: 'B', gender: 'female', voiceId: 'v', behaviorConfig: {}, personalityPrompt: '' }) } as any,
        factsRepo: factsRepo as any,
        convRepo: convRepo as any,
        remindersRepo: {} as any,
        s3: {} as any,
        gemini: { models: { embedContent: vi.fn().mockRejectedValue(new Error('no-op')) } } as any,
        agentRunner: agentRunner as any,
      },
    })

    expect(response.replyTo).toBe(777)
    expect(response.assistantRowId).toBe('row1')
  })
```

This test requires `runner.ts` to expose the recall tools on the agent instance so the stub can find them — the existing `createBetsyAgent` returns an LlmAgent object; in the ADK API the tools are readable at `agent.tools`. If that property is actually named differently, update the selector accordingly. If the ADK doesn't expose tools at all, instead of stubbing, directly call `runContext.replyTarget = 777` from a wrapper tool — the goal is just to prove the runner reads from runContext into BetsyResponse.

Fallback test shape if tools aren't introspectable (use this if the above fails):

```typescript
    // Use a spy factory that captures the runContext via the createRecallTools call
    // ... import mock of createRecallTools that mutates the passed runContext immediately.
```

Choose whichever works for the current ADK version — the important assertion is `expect(response.replyTo).toBe(777)`.

- [ ] **Step 9: Run tests**

Run: `npx vitest run tests/multi/agents/runner.test.ts tests/multi/bot-router/chat-id-plumbing.test.ts`

Expected: all pass. If the runner test shape doesn't work, iterate on it — but do not skip the assertion that `response.replyTo === 777`.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`

Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/multi/agents/runner.ts src/multi/agents/betsy-factory.ts src/multi/bot-router/router.ts tests/multi/agents/runner.test.ts
git commit -m "feat(multi/agents): propagate replyTo from runContext through runner and bot router"
```

---

### Task 8: Server wiring — construct ConversationRepo with gemini, pass currentChatId

**Files:**
- Modify: `src/multi/server.ts`

**Rationale:** The production entrypoint constructs `ConversationRepo` without `gemini` today. Inline embedding needs `gemini`. This is a one-line change but easy to forget.

- [ ] **Step 1: Find the ConversationRepo instantiation**

In `src/multi/server.ts`, search for `new ConversationRepo(`. There should be one site, passing only `pool`.

- [ ] **Step 2: Add the gemini argument**

Change:

```typescript
const convRepo = new ConversationRepo(pool)
```

to:

```typescript
const convRepo = new ConversationRepo(pool, gemini)
```

The `gemini` variable already exists in the same scope (it's used to construct `FactsRepo` via `new FactsRepo(pool, getGemini())` in the current code — see Task 1.5 of the mem0 plan). If the variable is called `getGemini()` rather than `gemini`, use the same form:

```typescript
const convRepo = new ConversationRepo(pool, getGemini())
```

- [ ] **Step 3: Typecheck and run any server smoke test**

Run: `npm run typecheck`

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/multi/server.ts
git commit -m "feat(multi/server): wire gemini into ConversationRepo for inline embeddings"
```

---

### Task 9: System prompt — RECALL_INSTRUCTIONS

**Files:**
- Modify: `src/multi/personality/bridge.ts`

**Rationale:** Teaches Betsy when to call `recall_messages` and `set_reply_target`. Short (3–6 bullet points) — we don't want to bloat the system prompt.

- [ ] **Step 1: Add the constant**

In `src/multi/personality/bridge.ts`, find `const SELFIE_INSTRUCTIONS = ...`. After the `SELFIE_INSTRUCTIONS` constant block, add:

```typescript
const RECALL_INSTRUCTIONS = `## Поиск по истории чата

У тебя есть два инструмента для работы со старыми сообщениями (те, что уже выпали из живого контекста):

- **recall_messages(query, role?, since?, until?, limit?)** — семантический поиск по истории.
  - role: "user" = что я говорил, "assistant" = что ты говорила, "any" = любые (по умолчанию)
  - since/until: ISO-даты вида "2026-04-01" для запросов «вчера», «на прошлой неделе» и т.п.
  - Возвращает matches с content, externalMessageId, similarity (0..1).

- **set_reply_target(externalMessageId)** — сделать твой следующий текстовый ответ Telegram-реплаем на найденное сообщение. Вызывай РОВНО ОДИН РАЗ перед финальным текстом. Твой обычный текстовый ответ станет комментарием к процитированному сообщению.

Когда звать:
- «что я говорил про X» / «когда я упоминал Y» → recall_messages(query=X, role="user") → выбери top-1 → set_reply_target(его externalMessageId) → ответь комментарием
- «что ты говорила про X» / «когда ты обещала Y» → recall_messages(query=X, role="assistant") → set_reply_target → ответ
- «вспомни наш разговор про Z» → recall_messages(query=Z, role="any") → set_reply_target на самое релевантное
- Временные запросы «вчера», «на прошлой неделе» → вычисли дату из currentTimestamp (см. ниже) и передай в since/until

Правила:
- Если в matches у нужного сообщения externalMessageId == null — set_reply_target НЕ вызывай, просто процитируй фрагмент в кавычках в тексте (это старые данные без id).
- Если релевантных совпадений несколько — реплай на самое релевантное (top-1), остальные упомяни в тексте своим обычным языком.
- Если recall_messages вернул пустой matches или error — честно скажи «не нашла в старой переписке» и предложи уточнить формулировку.
- Не звони recall_messages для свежего разговора — свежие сообщения и так у тебя в контексте.

Текущий момент: ${new Date().toISOString()}`
```

- [ ] **Step 2: Append to the prompt output**

Find the `return` statement at the bottom of `buildSystemPromptForPersona`:

```typescript
  return `${base}\n\n${ADDRESS_INSTRUCTIONS}\n\n${FORMATTING_INSTRUCTIONS}\n\n${WEB_SEARCH_INSTRUCTIONS}\n\n${SELFIE_INSTRUCTIONS}`
```

Replace with:

```typescript
  return `${base}\n\n${ADDRESS_INSTRUCTIONS}\n\n${FORMATTING_INSTRUCTIONS}\n\n${WEB_SEARCH_INSTRUCTIONS}\n\n${SELFIE_INSTRUCTIONS}\n\n${RECALL_INSTRUCTIONS}`
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

Expected: clean.

- [ ] **Step 4: Verify the prompt changes in the existing prompt-builder test**

Run: `npx vitest run tests/multi/agents/prompt-builder.test.ts`

Expected: if an existing test snapshot-matches the full prompt, it will fail — update the snapshot (`npx vitest run tests/multi/agents/prompt-builder.test.ts -u`). If the test asserts substrings, add a new assertion:

```typescript
    expect(prompt).toContain('recall_messages')
    expect(prompt).toContain('set_reply_target')
```

- [ ] **Step 5: Commit**

```bash
git add src/multi/personality/bridge.ts tests/multi/agents/prompt-builder.test.ts
git commit -m "feat(multi/personality): add RECALL_INSTRUCTIONS to system prompt"
```

---

### Task 10: Bulk backfill script for historical conversation rows

**Files:**
- Create: `scripts/embed-conversation-history.mjs`

**Rationale:** Every pre-existing row in `bc_conversation` has `embedding=NULL`. We don't want to wait for per-turn backfill to catch up (it's slow at 20/turn). A one-shot script run manually after deploy embeds everything.

- [ ] **Step 1: Create the script**

Create `scripts/embed-conversation-history.mjs`:

```javascript
#!/usr/bin/env node
/**
 * One-shot backfill: compute embeddings for all bc_conversation rows that
 * currently have embedding=NULL. Run ONCE manually after deploying migration
 * 007, then never again — inline embedding in ConversationRepo.append handles
 * every new row.
 *
 * Usage (on the VPS, from /opt/betsy-multi):
 *   export GOOGLE_APPLICATION_CREDENTIALS=/opt/betsy-multi/gcp-sa.json
 *   set -a && . ./.env.multi && set +a
 *   node scripts/embed-conversation-history.mjs
 *
 * Env it reads:
 *   BC_DATABASE_URL         — required
 *   BC_GCP_PROJECT          — required (Vertex)
 *   BC_GCP_LOCATION         — required (Vertex)
 *   BC_BACKFILL_BATCH       — optional, default 50
 *   BC_BACKFILL_MAX         — optional, default Infinity (for dry-run testing)
 */
import { GoogleGenAI } from '@google/genai'
import pg from 'pg'

const BATCH = Number(process.env.BC_BACKFILL_BATCH ?? 50)
const MAX = Number(process.env.BC_BACKFILL_MAX ?? Infinity)
const MIN_LEN = 10

const gemini = new GoogleGenAI({
  vertexai: true,
  project: process.env.BC_GCP_PROJECT,
  location: process.env.BC_GCP_LOCATION,
})
const pool = new pg.Pool({ connectionString: process.env.BC_DATABASE_URL })

async function embed(text) {
  const input = text.length > 8000 ? text.slice(0, 8000) : text
  const r = await gemini.models.embedContent({
    model: 'text-embedding-004',
    contents: input,
  })
  const v = r?.embeddings?.[0]?.values
  if (!v || v.length === 0) throw new Error('empty embedding')
  return v
}
const toVec = (v) => '[' + v.join(',') + ']'

let processed = 0
let failed = 0

for (;;) {
  if (processed >= MAX) break
  const { rows } = await pool.query(
    `select id, content
     from bc_conversation
     where embedding is null
       and role in ('user','assistant')
       and length(content) >= $1
       and coalesce(meta->>'summarized', 'false') <> 'true'
     order by created_at asc
     limit $2`,
    [MIN_LEN, BATCH],
  )
  if (rows.length === 0) break

  for (const row of rows) {
    if (processed >= MAX) break
    try {
      const vec = await embed(row.content)
      await pool.query(
        `update bc_conversation set embedding = $1::vector where id = $2`,
        [toVec(vec), row.id],
      )
      processed++
      if (processed % 20 === 0) {
        console.log(`progress: ${processed} embedded, ${failed} failed`)
      }
    } catch (e) {
      failed++
      console.error(`fail ${row.id}: ${e?.message ?? e}`)
    }
  }
}

console.log(`done. embedded=${processed} failed=${failed}`)
await pool.end()
```

- [ ] **Step 2: Local smoke test**

Run against a test DB with some rows:
```bash
BC_DATABASE_URL=$BC_TEST_DATABASE_URL BC_GCP_PROJECT=... BC_GCP_LOCATION=... node scripts/embed-conversation-history.mjs
```

Expected: prints `done. embedded=N failed=0` or skips if there are no NULL rows. If Vertex isn't configured locally, skip this step — it runs on the VPS only.

- [ ] **Step 3: Commit**

```bash
git add scripts/embed-conversation-history.mjs
git commit -m "chore(scripts): one-shot bulk embedder for bc_conversation history"
```

---

### Task 11: Build, deploy, end-to-end verification

**Files:** none (deployment)

**Rationale:** Migration 007 applies automatically on startup. Bulk script runs once after deploy. Then a live test in Telegram.

- [ ] **Step 1: Local build**

Run: `npm run build:all`

Expected: `dist/index.js` rebuilt, `dist/multi/db/migrations/007_conversation_embeddings.sql` present, UI rebuilt.

```bash
ls dist/migrations/ | grep 007
ls dist/multi/db/migrations/ 2>/dev/null | grep 007 || true
```

Expected: `007_conversation_embeddings.sql` shows up in at least one of the two locations (whichever `migrate.ts` resolves).

- [ ] **Step 2: Backup VPS DB before deploy**

```bash
ssh root@193.42.124.214 "docker exec betsy-pg pg_dump -U postgres betsy > /root/betsy-pg-pre-recall.sql && wc -l /root/betsy-pg-pre-recall.sql"
```

Expected: line count printed, e.g. `1234 /root/betsy-pg-pre-recall.sql`.

- [ ] **Step 3: Upload dist and restart**

```bash
tar czf /tmp/betsy-dist.tgz dist/ scripts/embed-conversation-history.mjs
scp /tmp/betsy-dist.tgz root@193.42.124.214:/tmp/
ssh root@193.42.124.214 "cd /opt/betsy-multi && cp -r dist dist.bak.$(date +%s) && tar xzf /tmp/betsy-dist.tgz && systemctl restart betsy-multi && sleep 4 && systemctl status betsy-multi --no-pager | head -10"
```

Expected: `active (running)`.

- [ ] **Step 4: Verify migration 007 applied**

```bash
ssh root@193.42.124.214 "docker exec betsy-pg psql -U postgres -d betsy -c \"select name from schema_migrations order by name;\" | grep 007"
ssh root@193.42.124.214 "docker exec betsy-pg psql -U postgres -d betsy -c \"select column_name from information_schema.columns where table_name='bc_conversation' order by ordinal_position;\""
```

Expected: `007_conversation_embeddings.sql` present; columns include `embedding`, `chat_id`, `external_message_id`.

- [ ] **Step 5: Run bulk backfill**

```bash
ssh root@193.42.124.214 "cd /opt/betsy-multi && export GOOGLE_APPLICATION_CREDENTIALS=/opt/betsy-multi/gcp-sa.json && set -a && . ./.env.multi && set +a && node scripts/embed-conversation-history.mjs"
```

Expected: progress lines followed by `done. embedded=N failed=0`.

Verify:
```bash
ssh root@193.42.124.214 "docker exec betsy-pg psql -U postgres -d betsy -c \"select count(*) total, count(embedding) with_emb from bc_conversation where role in ('user','assistant') and length(content) >= 10;\""
```

Expected: `with_emb` equals `total` (or very close — allow for short/summarized rows).

- [ ] **Step 6: End-to-end Telegram test**

Manual steps — perform in the real Telegram chat with the bot:

1. Send three messages on distinct topics, each separated by a non-topic message:
   - «Кстати, сегодня купил новую кофемашину Delonghi La Specialista»
   - Wait for Betsy's reply
   - «А что у тебя с погодой за окном?» (distractor)
   - «Аня вчера записалась на йогу по вторникам и четвергам»
   - Wait
   - «Читаю сейчас книгу “Sapiens” Харари, очень зашло»
   - Wait

2. Then ask: «Напомни что я говорил про кофемашину».

   Expected behaviour:
   - Betsy replies **as a reply-quote** to the Delonghi message (Telegram shows the quote above her text).
   - Her comment mentions Delonghi / кофемашину.

3. Ask: «Когда ты в прошлый раз говорила про книги?»

   Expected:
   - Reply-quote to Betsy's own previous reply about the Sapiens message.
   - Comment contextualises it.

4. Ask a temporal query: «Что я говорил вчера про спорт?»

   Expected:
   - Reply-quote to the Аня/йога message OR a graceful «не нашла ничего конкретно про спорт вчера» if the embedding didn't match.

- [ ] **Step 7: DB spot-checks after the test**

```bash
ssh root@193.42.124.214 "docker exec betsy-pg psql -U postgres -d betsy -c \"select id, role, chat_id, external_message_id, embedding is not null as has_emb, left(content,50) from bc_conversation where external_message_id is not null order by created_at desc limit 10;\""
```

Expected: recent rows have `chat_id` set, `external_message_id` populated for both user AND assistant roles (assistant roles are filled by `setExternalMessageId` in bot-router post-send), `has_emb=t`.

- [ ] **Step 8: Journal check**

```bash
ssh root@193.42.124.214 "journalctl -u betsy-multi --since '10 min ago' -o cat | grep -iE 'recall_messages|set_reply_target|replyTo' | tail -20"
```

Expected: lines showing `set_reply_target: target set`, `runBetsy returned ... replyTo=<id>`.

- [ ] **Step 9: If anything fails, stop and diagnose — do not retry deploy**

Following the `feedback_deploy_once` rule: if E2E fails, ssh in, read logs, fix the code locally, push a single new build. Do not iterate on prod.

- [ ] **Step 10: Final commit (release marker)**

```bash
git commit --allow-empty -m "release: chat memory recall + quoted reply deployed to VPS"
```

---

## Out of scope (explicitly deferred)

- **Max channel reply-quote.** `set_reply_target` returns `{ok: false, reason}` for Max. When Max adapter gains reply support, add a `sendMessage` path that honours `replyToMessageId` and remove the channel guard in `set_reply_target`.
- **Multi-message reply.** Telegram doesn't natively support it. Betsy must summarise additional matches in text.
- **LLM re-ranking of recall hits.** Pure cosine top-K for v1. If top-1 consistently misses the mark in production, add a Gemini-flash re-rank pass (take top-10, ask the model which is most relevant, pick that one).
- **Cross-chat recall.** One workspace can be linked to multiple Telegram chats (e.g. personal + group). v1 recall is strictly scoped to `currentChatId`.
- **UI for recall debugging.** No admin page showing "what would recall return for query X". Add if needed based on user reports.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-07-chat-memory-recall.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
