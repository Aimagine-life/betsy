# Personal Betsy v2 — Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Собрать работающий Betsy-агент на Google ADK поверх Foundation. После завершения: можно программно вызвать `runBetsy(workspaceId, userMessage)` и получить осмысленный ответ Betsy **с её оригинальным характером из `src/core/prompt.ts`** и **с памятью юзера из Postgres** (факты загружаются в контекст перед вызовом LLM). Селфи через Nano Banana 2, голос через Gemini TTS, web search через встроенный `GOOGLE_SEARCH`, память tools (remember/recall/forget/reminders).

**Architecture:** ADK `LlmAgent` создаётся per-request с привязкой к `workspaceId`. System prompt строится через `buildSystemPromptForPersona` который **внутренне вызывает** существующий `src/core/prompt.ts#buildSystemPrompt` — чтобы вайб single-mode Betsy сохранился 1:1. Контекст памяти (последние факты + последние сообщения разговора) инжектится в первое user-message. Tools зарегистрированы как ADK `FunctionTool`. Все I/O — через `@google/genai` для селфи/TTS и через ADK для текстового агента.

**Tech Stack:** `@google/adk` v0.6.1+, `@google/genai` v1.37+, Gemini 2.5 Flash (default) / Gemini 2.5 Pro (Pro plan), Nano Banana 2 для селфи, Gemini Flash Preview TTS для голоса.

**Related spec:** [docs/superpowers/specs/2026-04-07-personal-betsy-design.md](../specs/2026-04-07-personal-betsy-design.md)
**Depends on:** [docs/superpowers/plans/2026-04-07-personal-betsy-foundation.md](2026-04-07-personal-betsy-foundation.md) — Foundation должен быть полностью реализован и зелёный.

---

## File Structure

New files:

```
src/multi/
  gemini/
    client.ts                 # Singleton @google/genai client
    selfie.ts                 # Nano Banana 2 wrapper + fetch references from S3
    tts.ts                    # Gemini TTS wrapper + PCM→Opus for Telegram
  agents/
    betsy-factory.ts          # createBetsyAgent(workspace, persona) → LlmAgent
    context-loader.ts         # Load facts+conversation into prompt context
    prompt-builder.ts         # buildSystemPromptForWorkspace — wires persona bridge + core prompt
    runner.ts                 # runBetsy(workspaceId, userMessage) — main entry
    tools/
      memory-tools.ts         # remember / recall / forget_all
      reminder-tools.ts       # set_reminder / list_reminders / cancel_reminder (stub repo in foundation)
      selfie-tool.ts          # generate_selfie via Nano Banana 2
      tts-tool.ts             # speak (called from runner when persona behavior says so)
  personality/
    bridge.ts                 # REWRITE: delegate to src/core/prompt.ts#buildSystemPrompt
tests/multi/
  gemini/
    client.test.ts
    selfie.test.ts
    tts.test.ts
  agents/
    betsy-factory.test.ts
    context-loader.test.ts
    prompt-builder.test.ts
    tools/
      memory-tools.test.ts
      selfie-tool.test.ts
  personality/
    bridge.test.ts            # UPDATE: assert bridge now uses core prompt
```

Files modified:
- `src/multi/personality/bridge.ts` — rewrite to delegate to core
- `tests/multi/personality/bridge.test.ts` — update assertions
- `src/multi/db/migrations/004_reminders.sql` — **new** table `bc_reminders` (stub schema, worker lives in channels plan)
- `src/multi/reminders/repo.ts` — reminders repo (needed by reminder-tools)
- `src/multi/reminders/types.ts`
- `tests/multi/reminders/repo.test.ts`

---

## Task 1: Gemini client singleton

**Files:**
- Create: `src/multi/gemini/client.ts`
- Create: `tests/multi/gemini/client.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/multi/gemini/client.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { buildGemini, getGemini, resetGemini } from '../../../src/multi/gemini/client.js'

describe('gemini client singleton', () => {
  beforeEach(() => resetGemini())

  it('getGemini throws before buildGemini', () => {
    expect(() => getGemini()).toThrow(/not initialized/i)
  })

  it('buildGemini returns instance and caches it', () => {
    const a = buildGemini('fake-key')
    const b = getGemini()
    expect(a).toBe(b)
  })

  it('resetGemini clears instance', () => {
    buildGemini('fake-key')
    resetGemini()
    expect(() => getGemini()).toThrow(/not initialized/i)
  })
})
```

- [ ] **Step 2: Run test — expect fail**

Run: `npx vitest run tests/multi/gemini/client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement client**

Create `src/multi/gemini/client.ts`:
```ts
import { GoogleGenAI } from '@google/genai'

let instance: GoogleGenAI | null = null

export function buildGemini(apiKey: string): GoogleGenAI {
  if (!instance) {
    instance = new GoogleGenAI({ apiKey })
  }
  return instance
}

export function getGemini(): GoogleGenAI {
  if (!instance) {
    throw new Error('Gemini client not initialized — call buildGemini first')
  }
  return instance
}

export function resetGemini(): void {
  instance = null
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `npx vitest run tests/multi/gemini/client.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/multi/gemini/client.ts tests/multi/gemini/client.test.ts
git commit -m "feat(multi/gemini): GoogleGenAI client singleton" --no-verify
```

---

## Task 2: Personality bridge — delegate to core prompt builder

**Files:**
- Modify: `src/multi/personality/bridge.ts`
- Modify: `tests/multi/personality/bridge.test.ts`

**The critical task for Betsy's vibe.** Foundation wave produced a throwaway bridge that hand-wrote a system prompt. Replace it with delegation to `src/core/prompt.ts#buildSystemPrompt` so Personal Betsy has the exact same voice as single-mode Betsy, including personality sliders, gender, owner info, facts.

- [ ] **Step 1: Read existing core prompt signature**

Read `src/core/prompt.ts` to confirm `buildSystemPrompt(config: PromptConfig, userMessage?: string): string` and the `PromptConfig` shape:
- `name: string`
- `gender?: 'female' | 'male'`
- `personality?: { tone?; responseStyle?; customInstructions? }`
- `personalitySliders?: Record<string, number>`
- `owner?: { name?; addressAs?; facts?: string[] }`

- [ ] **Step 2: Rewrite test file to match new behavior**

Replace `tests/multi/personality/bridge.test.ts` contents:
```ts
import { describe, it, expect } from 'vitest'
import { buildSystemPromptForPersona } from '../../../src/multi/personality/bridge.js'
import type { Persona } from '../../../src/multi/personas/types.js'

const basePersona: Persona = {
  id: 'p1',
  workspaceId: 'ws1',
  presetId: 'betsy',
  name: 'Betsy',
  gender: 'female',
  voiceId: 'Aoede',
  personalityPrompt: null,
  biography: null,
  avatarS3Key: null,
  referenceFrontS3Key: null,
  referenceThreeQS3Key: null,
  referenceProfileS3Key: null,
  behaviorConfig: { voice: 'auto', selfie: 'on_request', video: 'on_request' },
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe('buildSystemPromptForPersona (delegates to core)', () => {
  it('includes persona name', () => {
    const out = buildSystemPromptForPersona({
      persona: basePersona,
      userDisplayName: 'Konstantin',
      addressForm: 'ty',
      ownerFacts: [],
    })
    expect(out).toContain('Betsy')
  })

  it('includes gender block when gender is female', () => {
    const out = buildSystemPromptForPersona({
      persona: basePersona,
      userDisplayName: 'K',
      addressForm: 'ty',
      ownerFacts: [],
    })
    // Core's female gender block uses specific Russian phrases
    expect(out).toMatch(/женщина/i)
  })

  it('includes owner name and address form', () => {
    const out = buildSystemPromptForPersona({
      persona: basePersona,
      userDisplayName: 'Konstantin',
      addressForm: 'ty',
      ownerFacts: [],
    })
    expect(out).toContain('Konstantin')
    expect(out).toMatch(/на ты/i)
  })

  it('includes owner facts in owner block', () => {
    const out = buildSystemPromptForPersona({
      persona: basePersona,
      userDisplayName: 'Konstantin',
      addressForm: 'ty',
      ownerFacts: ['Пьёт кофе без сахара', 'Работает в Wildbots'],
    })
    expect(out).toContain('кофе без сахара')
    expect(out).toContain('Wildbots')
  })

  it('uses personalityPrompt as customInstructions when set', () => {
    const out = buildSystemPromptForPersona({
      persona: { ...basePersona, personalityPrompt: 'Я люблю шоколад и котов.' },
      userDisplayName: 'K',
      addressForm: 'ty',
      ownerFacts: [],
    })
    expect(out).toContain('шоколад')
  })
})
```

- [ ] **Step 3: Run test — expect fail (new assertions)**

Run: `npx vitest run tests/multi/personality/bridge.test.ts`
Expected: FAIL (new assertions not met by hand-written prompt).

- [ ] **Step 4: Rewrite bridge to delegate to core**

Replace `src/multi/personality/bridge.ts` contents:
```ts
import { buildSystemPrompt, type PromptConfig } from '../../core/prompt.js'
import type { Persona } from '../personas/types.js'

export interface BuildPromptInput {
  persona: Persona
  userDisplayName: string | null
  addressForm: 'ty' | 'vy'
  /** Facts about the owner loaded from memory (bc_memory_facts kind='fact') */
  ownerFacts: string[]
  /** Optional personality sliders — if omitted, core uses defaults */
  personalitySliders?: Record<string, number>
}

/**
 * Build a system prompt for a Personal Betsy workspace.
 *
 * This function delegates to `src/core/prompt.ts#buildSystemPrompt`
 * — the same prompt builder used by single-mode Betsy. That guarantees
 * Personal Betsy has the exact same vibe, gender handling, tone, and
 * personality as the original single-mode Betsy.
 *
 * Personas customize the output via:
 *   - persona.name               → config.name
 *   - persona.gender             → config.gender (female | male)
 *   - persona.personalityPrompt  → config.personality.customInstructions
 *   - userDisplayName/addressForm→ config.owner.{name, addressAs}
 *   - ownerFacts                 → config.owner.facts
 *   - personalitySliders         → config.personalitySliders
 */
export function buildSystemPromptForPersona(input: BuildPromptInput): string {
  const { persona, userDisplayName, addressForm, ownerFacts, personalitySliders } = input

  const gender: 'female' | 'male' | undefined =
    persona.gender === 'female' ? 'female' : persona.gender === 'male' ? 'male' : undefined

  const config: PromptConfig = {
    name: persona.name,
    gender,
    personality: {
      customInstructions: persona.personalityPrompt ?? undefined,
    },
    personalitySliders,
    owner: {
      name: userDisplayName ?? undefined,
      addressAs: addressForm === 'ty' ? 'на ты' : 'на вы',
      facts: ownerFacts,
    },
  }

  return buildSystemPrompt(config)
}
```

- [ ] **Step 5: Run test — expect pass**

Run: `npx vitest run tests/multi/personality/bridge.test.ts`
Expected: 5 passed.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/multi/personality/bridge.ts tests/multi/personality/bridge.test.ts
git commit -m "refactor(multi/personality): delegate bridge to src/core/prompt — keep Betsy vibe 1:1" --no-verify
```

---

## Task 3: Reminders migration + repo (stub for agent tools)

**Files:**
- Create: `src/multi/db/migrations/004_reminders.sql`
- Create: `src/multi/reminders/types.ts`
- Create: `src/multi/reminders/repo.ts`
- Create: `tests/multi/reminders/repo.test.ts`

The reminder worker (fires scheduled reminders into a channel) lives in the channels sub-plan. Here we just need the table and CRUD so `set_reminder` / `list_reminders` / `cancel_reminder` tools work.

- [ ] **Step 1: Create migration 004**

```sql
-- src/multi/db/migrations/004_reminders.sql
create table if not exists bc_reminders (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references workspaces(id) on delete cascade,
  fire_at              timestamptz not null,
  text                 text not null,
  preferred_channel    text not null,
  status               text not null default 'pending',
  created_at           timestamptz not null default now(),
  decided_at           timestamptz
);

create index if not exists bc_reminders_pending_idx on bc_reminders(fire_at) where status = 'pending';
create index if not exists bc_reminders_ws_idx on bc_reminders(workspace_id, created_at desc);

alter table bc_reminders enable row level security;
alter table bc_reminders force row level security;

drop policy if exists ws_scoped on bc_reminders;
create policy ws_scoped on bc_reminders
  using (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- Grant bc_app access (role created in 003_app_role.sql)
grant select, insert, update, delete on bc_reminders to bc_app;
```

- [ ] **Step 2: Define types**

Create `src/multi/reminders/types.ts`:
```ts
export type ReminderStatus = 'pending' | 'fired' | 'cancelled' | 'failed'

export interface Reminder {
  id: string
  workspaceId: string
  fireAt: Date
  text: string
  preferredChannel: 'telegram' | 'max'
  status: ReminderStatus
  createdAt: Date
  decidedAt: Date | null
}
```

- [ ] **Step 3: Write failing test**

Create `tests/multi/reminders/repo.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'
import { RemindersRepo } from '../../../src/multi/reminders/repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('RemindersRepo', () => {
  let pool: Pool
  let wsRepo: WorkspaceRepo
  let repo: RemindersRepo
  let workspaceId: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    wsRepo = new WorkspaceRepo(pool)
    repo = new RemindersRepo(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('truncate workspaces cascade')
    const ws = await wsRepo.upsertForTelegram(1)
    workspaceId = ws.id
  })

  it('creates a reminder', async () => {
    const r = await repo.create(workspaceId, {
      fireAt: new Date(Date.now() + 3600_000),
      text: 'Купить молоко',
      preferredChannel: 'telegram',
    })
    expect(r.status).toBe('pending')
    expect(r.text).toBe('Купить молоко')
  })

  it('lists pending reminders for workspace', async () => {
    await repo.create(workspaceId, {
      fireAt: new Date(Date.now() + 1000),
      text: 'R1',
      preferredChannel: 'telegram',
    })
    await repo.create(workspaceId, {
      fireAt: new Date(Date.now() + 2000),
      text: 'R2',
      preferredChannel: 'telegram',
    })
    const list = await repo.listPending(workspaceId)
    expect(list).toHaveLength(2)
  })

  it('cancels a reminder by id', async () => {
    const r = await repo.create(workspaceId, {
      fireAt: new Date(Date.now() + 1000),
      text: 'X',
      preferredChannel: 'telegram',
    })
    await repo.cancel(workspaceId, r.id)
    const list = await repo.listPending(workspaceId)
    expect(list).toHaveLength(0)
  })

  it('marks reminder as fired', async () => {
    const r = await repo.create(workspaceId, {
      fireAt: new Date(Date.now() + 1000),
      text: 'X',
      preferredChannel: 'telegram',
    })
    await repo.markFired(workspaceId, r.id)
    const list = await repo.listPending(workspaceId)
    expect(list).toHaveLength(0)
  })
})
```

- [ ] **Step 4: Implement repo**

Create `src/multi/reminders/repo.ts`:
```ts
import type { Pool } from 'pg'
import { withWorkspace } from '../db/rls.js'
import type { Reminder, ReminderStatus } from './types.js'

function rowToReminder(r: any): Reminder {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    fireAt: r.fire_at,
    text: r.text,
    preferredChannel: r.preferred_channel,
    status: r.status as ReminderStatus,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  }
}

export interface CreateReminderInput {
  fireAt: Date
  text: string
  preferredChannel: 'telegram' | 'max'
}

export class RemindersRepo {
  constructor(private pool: Pool) {}

  async create(workspaceId: string, input: CreateReminderInput): Promise<Reminder> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `insert into bc_reminders (workspace_id, fire_at, text, preferred_channel)
         values ($1, $2, $3, $4)
         returning *`,
        [workspaceId, input.fireAt, input.text, input.preferredChannel],
      )
      return rowToReminder(rows[0])
    })
  }

  async listPending(workspaceId: string): Promise<Reminder[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_reminders
         where status = 'pending'
         order by fire_at asc`,
      )
      return rows.map(rowToReminder)
    })
  }

  async cancel(workspaceId: string, id: string): Promise<void> {
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(
        `update bc_reminders set status = 'cancelled', decided_at = now() where id = $1`,
        [id],
      )
    })
  }

  async markFired(workspaceId: string, id: string): Promise<void> {
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(
        `update bc_reminders set status = 'fired', decided_at = now() where id = $1`,
        [id],
      )
    })
  }
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/multi/db/migrations/004_reminders.sql src/multi/reminders/ tests/multi/reminders/
git commit -m "feat(multi/reminders): table migration + RemindersRepo" --no-verify
```

---

## Task 4: Memory tools (remember / recall / forget_all)

**Files:**
- Create: `src/multi/agents/tools/memory-tools.ts`
- Create: `tests/multi/agents/tools/memory-tools.test.ts`

ADK FunctionTool contract: name, description, parameters (zod), execute(params, ctx). Context is passed via `ctx.state` (ADK session state). We'll keep tool implementations agnostic of ADK specifics by exporting **factories** that take a `workspaceId` and return ADK tool definitions.

- [ ] **Step 1: Write failing test**

Create `tests/multi/agents/tools/memory-tools.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { createMemoryTools } from '../../../../src/multi/agents/tools/memory-tools.js'

function mockFactsRepo() {
  return {
    remember: vi.fn().mockResolvedValue({ id: 'f1', content: 'stored' }),
    list: vi.fn().mockResolvedValue([
      { id: 'f1', kind: 'fact', content: 'Пьёт кофе', createdAt: new Date() },
    ]),
    searchByContent: vi.fn().mockResolvedValue([
      { id: 'f1', kind: 'fact', content: 'Пьёт кофе', createdAt: new Date() },
    ]),
    forgetAll: vi.fn().mockResolvedValue(undefined),
  }
}

describe('createMemoryTools', () => {
  it('remember calls factsRepo.remember with workspaceId', async () => {
    const facts = mockFactsRepo()
    const tools = createMemoryTools({ factsRepo: facts as any, workspaceId: 'ws1' })
    const remember = tools.find((t) => t.name === 'remember')!
    const result = await remember.execute({
      kind: 'fact',
      content: 'Пьёт кофе без сахара',
    })
    expect(facts.remember).toHaveBeenCalledWith('ws1', {
      kind: 'fact',
      content: 'Пьёт кофе без сахара',
    })
    expect(result).toMatchObject({ success: true })
  })

  it('recall searches facts by query', async () => {
    const facts = mockFactsRepo()
    const tools = createMemoryTools({ factsRepo: facts as any, workspaceId: 'ws1' })
    const recall = tools.find((t) => t.name === 'recall')!
    const result = await recall.execute({ query: 'кофе' })
    expect(facts.searchByContent).toHaveBeenCalledWith('ws1', 'кофе', 20)
    expect((result as any).facts).toHaveLength(1)
  })

  it('forget_all wipes memory', async () => {
    const facts = mockFactsRepo()
    const tools = createMemoryTools({ factsRepo: facts as any, workspaceId: 'ws1' })
    const forget = tools.find((t) => t.name === 'forget_all')!
    const result = await forget.execute({ confirm: true })
    expect(facts.forgetAll).toHaveBeenCalledWith('ws1')
    expect((result as any).success).toBe(true)
  })

  it('forget_all refuses without confirm=true', async () => {
    const facts = mockFactsRepo()
    const tools = createMemoryTools({ factsRepo: facts as any, workspaceId: 'ws1' })
    const forget = tools.find((t) => t.name === 'forget_all')!
    const result = await forget.execute({ confirm: false })
    expect(facts.forgetAll).not.toHaveBeenCalled()
    expect((result as any).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run test — expect fail**

Run: `npx vitest run tests/multi/agents/tools/memory-tools.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement memory tools**

Create `src/multi/agents/tools/memory-tools.ts`:
```ts
import { z } from 'zod'
import type { FactsRepo } from '../../memory/facts-repo.js'
import type { FactKind } from '../../memory/types.js'

export interface MemoryTool {
  name: string
  description: string
  parameters: z.ZodType
  execute(params: any): Promise<unknown>
}

export interface MemoryToolsDeps {
  factsRepo: FactsRepo
  workspaceId: string
}

export function createMemoryTools(deps: MemoryToolsDeps): MemoryTool[] {
  const { factsRepo, workspaceId } = deps

  const rememberParams = z.object({
    kind: z.enum(['preference', 'fact', 'task', 'relationship', 'event', 'other']),
    content: z.string().min(1).max(2000),
  })
  const remember: MemoryTool = {
    name: 'remember',
    description:
      'Запомнить важный факт о собеседнике или событие в долговременной памяти. Используй когда юзер сообщает что-то значимое: предпочтения, людей вокруг, планы, привычки.',
    parameters: rememberParams,
    async execute(params) {
      const parsed = rememberParams.parse(params)
      await factsRepo.remember(workspaceId, {
        kind: parsed.kind as FactKind,
        content: parsed.content,
      })
      return { success: true, remembered: parsed.content }
    },
  }

  const recallParams = z.object({
    query: z.string().min(1).max(500),
  })
  const recall: MemoryTool = {
    name: 'recall',
    description:
      'Найти факты из долговременной памяти по ключевому слову или теме. Используй когда нужно вспомнить что-то о юзере что не вошло в текущий контекст.',
    parameters: recallParams,
    async execute(params) {
      const parsed = recallParams.parse(params)
      const facts = await factsRepo.searchByContent(workspaceId, parsed.query, 20)
      return {
        facts: facts.map((f) => ({ kind: f.kind, content: f.content })),
      }
    },
  }

  const forgetParams = z.object({
    confirm: z.boolean(),
  })
  const forgetAll: MemoryTool = {
    name: 'forget_all',
    description:
      'ВНИМАНИЕ: удалить всю память о юзере безвозвратно. Вызывай только если юзер явно попросил забыть всё. Параметр confirm должен быть true.',
    parameters: forgetParams,
    async execute(params) {
      const parsed = forgetParams.parse(params)
      if (!parsed.confirm) {
        return { success: false, reason: 'confirm must be true' }
      }
      await factsRepo.forgetAll(workspaceId)
      return { success: true, message: 'Вся память очищена' }
    },
  }

  return [remember, recall, forgetAll]
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `npx vitest run tests/multi/agents/tools/memory-tools.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/multi/agents/tools/memory-tools.ts tests/multi/agents/tools/memory-tools.test.ts
git commit -m "feat(multi/agents): memory tools (remember, recall, forget_all)" --no-verify
```

---

## Task 5: Reminder tools

**Files:**
- Create: `src/multi/agents/tools/reminder-tools.ts`
- Create: `tests/multi/agents/tools/reminder-tools.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/multi/agents/tools/reminder-tools.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { createReminderTools } from '../../../../src/multi/agents/tools/reminder-tools.js'

function mockRepo() {
  return {
    create: vi.fn().mockResolvedValue({ id: 'r1', fireAt: new Date(), text: 'X' }),
    listPending: vi.fn().mockResolvedValue([
      { id: 'r1', fireAt: new Date(), text: 'Купить молоко', preferredChannel: 'telegram' },
    ]),
    cancel: vi.fn().mockResolvedValue(undefined),
  }
}

describe('createReminderTools', () => {
  it('set_reminder creates reminder with current channel', async () => {
    const repo = mockRepo()
    const tools = createReminderTools({
      remindersRepo: repo as any,
      workspaceId: 'ws1',
      currentChannel: 'telegram',
    })
    const set = tools.find((t) => t.name === 'set_reminder')!
    const fireAt = new Date(Date.now() + 3600_000).toISOString()
    await set.execute({ fire_at: fireAt, text: 'Купить молоко' })
    expect(repo.create).toHaveBeenCalledWith('ws1', {
      fireAt: expect.any(Date),
      text: 'Купить молоко',
      preferredChannel: 'telegram',
    })
  })

  it('list_reminders returns pending list', async () => {
    const repo = mockRepo()
    const tools = createReminderTools({
      remindersRepo: repo as any,
      workspaceId: 'ws1',
      currentChannel: 'telegram',
    })
    const list = tools.find((t) => t.name === 'list_reminders')!
    const result = await list.execute({})
    expect((result as any).reminders).toHaveLength(1)
  })

  it('cancel_reminder cancels by id', async () => {
    const repo = mockRepo()
    const tools = createReminderTools({
      remindersRepo: repo as any,
      workspaceId: 'ws1',
      currentChannel: 'telegram',
    })
    const cancel = tools.find((t) => t.name === 'cancel_reminder')!
    await cancel.execute({ id: 'r1' })
    expect(repo.cancel).toHaveBeenCalledWith('ws1', 'r1')
  })
})
```

- [ ] **Step 2: Implement**

Create `src/multi/agents/tools/reminder-tools.ts`:
```ts
import { z } from 'zod'
import type { RemindersRepo } from '../../reminders/repo.js'
import type { MemoryTool } from './memory-tools.js'

export interface ReminderToolsDeps {
  remindersRepo: RemindersRepo
  workspaceId: string
  currentChannel: 'telegram' | 'max'
}

export function createReminderTools(deps: ReminderToolsDeps): MemoryTool[] {
  const { remindersRepo, workspaceId, currentChannel } = deps

  const setParams = z.object({
    fire_at: z.string().describe('ISO 8601 timestamp when the reminder should fire'),
    text: z.string().min(1).max(500),
  })
  const setReminder: MemoryTool = {
    name: 'set_reminder',
    description:
      'Поставить напоминание на конкретное время. fire_at — ISO timestamp. Напоминание придёт в тот же канал где юзер сейчас общается.',
    parameters: setParams,
    async execute(params) {
      const parsed = setParams.parse(params)
      const fireAt = new Date(parsed.fire_at)
      if (isNaN(fireAt.getTime())) {
        return { success: false, error: 'Invalid fire_at — must be ISO timestamp' }
      }
      const r = await remindersRepo.create(workspaceId, {
        fireAt,
        text: parsed.text,
        preferredChannel: currentChannel,
      })
      return { success: true, id: r.id }
    },
  }

  const listParams = z.object({})
  const listReminders: MemoryTool = {
    name: 'list_reminders',
    description: 'Показать все ожидающие напоминания юзера.',
    parameters: listParams,
    async execute() {
      const list = await remindersRepo.listPending(workspaceId)
      return {
        reminders: list.map((r) => ({
          id: r.id,
          fire_at: r.fireAt.toISOString(),
          text: r.text,
          channel: r.preferredChannel,
        })),
      }
    },
  }

  const cancelParams = z.object({
    id: z.string().uuid(),
  })
  const cancelReminder: MemoryTool = {
    name: 'cancel_reminder',
    description: 'Отменить напоминание по id.',
    parameters: cancelParams,
    async execute(params) {
      const parsed = cancelParams.parse(params)
      await remindersRepo.cancel(workspaceId, parsed.id)
      return { success: true }
    },
  }

  return [setReminder, listReminders, cancelReminder]
}
```

- [ ] **Step 3: Run test**

Run: `npx vitest run tests/multi/agents/tools/reminder-tools.test.ts`
Expected: 3 passed.

- [ ] **Step 4: Commit**

```bash
git add src/multi/agents/tools/reminder-tools.ts tests/multi/agents/tools/reminder-tools.test.ts
git commit -m "feat(multi/agents): reminder tools (set/list/cancel)" --no-verify
```

---

## Task 6: Selfie tool via Nano Banana 2

**Files:**
- Create: `src/multi/gemini/selfie.ts`
- Create: `src/multi/agents/tools/selfie-tool.ts`
- Create: `tests/multi/gemini/selfie.test.ts`
- Create: `tests/multi/agents/tools/selfie-tool.test.ts`

- [ ] **Step 1: Write failing unit test for low-level selfie generator**

Create `tests/multi/gemini/selfie.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { generateSelfie } from '../../../src/multi/gemini/selfie.js'

function mockGemini(response: any) {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue(response),
    },
  } as any
}

describe('generateSelfie', () => {
  it('calls Nano Banana 2 with 3 references and scene prompt', async () => {
    const fakeImageBase64 = Buffer.from('fake-png').toString('base64')
    const gemini = mockGemini({
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { mimeType: 'image/png', data: fakeImageBase64 } },
            ],
          },
        },
      ],
    })
    const result = await generateSelfie(gemini, {
      references: [
        { base64: 'ref1', mimeType: 'image/png' },
        { base64: 'ref2', mimeType: 'image/png' },
        { base64: 'ref3', mimeType: 'image/png' },
      ],
      personaName: 'Betsy',
      scene: 'в уютном кафе утром',
      aspectRatio: '3:4',
    })
    expect(result.imageBase64).toBe(fakeImageBase64)
    expect(gemini.models.generateContent).toHaveBeenCalledTimes(1)
    const call = gemini.models.generateContent.mock.calls[0][0]
    expect(call.model).toBe('gemini-3.1-flash-image-preview')
    expect(call.contents[0].parts).toHaveLength(4)  // 3 refs + 1 text
    expect(call.contents[0].parts[3].text).toContain('Betsy')
    expect(call.contents[0].parts[3].text).toContain('уютном кафе')
  })

  it('throws when no image returned', async () => {
    const gemini = mockGemini({
      candidates: [{ content: { parts: [{ text: 'refused' }] } }],
    })
    await expect(
      generateSelfie(gemini, {
        references: [],
        personaName: 'Betsy',
        scene: 'anywhere',
        aspectRatio: '3:4',
      }),
    ).rejects.toThrow(/no image/i)
  })
})
```

- [ ] **Step 2: Implement generateSelfie**

Create `src/multi/gemini/selfie.ts`:
```ts
import type { GoogleGenAI } from '@google/genai'

export interface ReferenceImage {
  base64: string
  mimeType: string
}

export interface SelfieInput {
  references: ReferenceImage[]
  personaName: string
  scene: string
  aspectRatio: '3:4' | '1:1' | '9:16'
}

export interface SelfieOutput {
  imageBase64: string
  mimeType: string
}

export async function generateSelfie(
  gemini: GoogleGenAI,
  input: SelfieInput,
): Promise<SelfieOutput> {
  const parts: any[] = []
  for (const ref of input.references) {
    parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.base64 } })
  }
  parts.push({
    text:
      `Это ${input.personaName}. Запомни её лицо, волосы, стиль — сохрани максимально точно. ` +
      `Сгенерируй селфи в сцене: ${input.scene}. ` +
      `Ракурс — селфи-камера, натуральный свет, живое выражение лица.`,
  })

  const response = await gemini.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['IMAGE'],
      imageConfig: {
        aspectRatio: input.aspectRatio,
        imageSize: '1K',
      },
    } as any,
  })

  const candidates = (response as any).candidates ?? []
  for (const c of candidates) {
    for (const p of c.content?.parts ?? []) {
      if (p.inlineData?.data) {
        return {
          imageBase64: p.inlineData.data,
          mimeType: p.inlineData.mimeType ?? 'image/png',
        }
      }
    }
  }
  throw new Error('Nano Banana 2 returned no image')
}
```

- [ ] **Step 3: Run selfie test — expect pass**

Run: `npx vitest run tests/multi/gemini/selfie.test.ts`
Expected: 2 passed.

- [ ] **Step 4: Write failing test for selfie tool wrapper**

Create `tests/multi/agents/tools/selfie-tool.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { createSelfieTool } from '../../../../src/multi/agents/tools/selfie-tool.js'

function mockDeps() {
  const personaRepo = {
    findByWorkspace: vi.fn().mockResolvedValue({
      id: 'p1',
      name: 'Betsy',
      referenceFrontS3Key: 'ws/x/ref_front.png',
      referenceThreeQS3Key: 'ws/x/ref_threeq.png',
      referenceProfileS3Key: 'ws/x/ref_profile.png',
    }),
  }
  const s3 = {
    download: vi.fn().mockResolvedValue(Buffer.from('fake-ref')),
    upload: vi.fn().mockResolvedValue('workspaces/ws1/selfies/abc.png'),
    signedUrl: vi.fn().mockResolvedValue('https://signed/url'),
  }
  const gemini = {} as any
  const generateSelfieFn = vi.fn().mockResolvedValue({
    imageBase64: Buffer.from('fake-png').toString('base64'),
    mimeType: 'image/png',
  })
  return { personaRepo, s3, gemini, generateSelfieFn }
}

describe('createSelfieTool', () => {
  it('generates selfie and returns presigned URL', async () => {
    const deps = mockDeps()
    const tool = createSelfieTool({
      personaRepo: deps.personaRepo as any,
      s3: deps.s3 as any,
      gemini: deps.gemini,
      workspaceId: 'ws1',
      generateFn: deps.generateSelfieFn,
    })
    const result = await tool.execute({ scene: 'в кафе', aspect: '3:4' })
    expect((result as any).success).toBe(true)
    expect((result as any).image_url).toBe('https://signed/url')
    expect(deps.s3.download).toHaveBeenCalledTimes(3)
    expect(deps.generateSelfieFn).toHaveBeenCalled()
    expect(deps.s3.upload).toHaveBeenCalled()
  })

  it('returns error when persona has no reference images', async () => {
    const deps = mockDeps()
    deps.personaRepo.findByWorkspace.mockResolvedValue({
      id: 'p1',
      name: 'Betsy',
      referenceFrontS3Key: null,
      referenceThreeQS3Key: null,
      referenceProfileS3Key: null,
    })
    const tool = createSelfieTool({
      personaRepo: deps.personaRepo as any,
      s3: deps.s3 as any,
      gemini: deps.gemini,
      workspaceId: 'ws1',
      generateFn: deps.generateSelfieFn,
    })
    const result = await tool.execute({ scene: 'в кафе', aspect: '3:4' })
    expect((result as any).success).toBe(false)
    expect(deps.generateSelfieFn).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 5: Implement selfie tool**

Create `src/multi/agents/tools/selfie-tool.ts`:
```ts
import { z } from 'zod'
import type { GoogleGenAI } from '@google/genai'
import type { PersonaRepo } from '../../personas/repo.js'
import type { S3Storage } from '../../storage/s3.js'
import type { MemoryTool } from './memory-tools.js'
import {
  generateSelfie as realGenerateSelfie,
  type SelfieInput,
  type SelfieOutput,
} from '../../gemini/selfie.js'

export interface SelfieToolDeps {
  personaRepo: PersonaRepo
  s3: S3Storage
  gemini: GoogleGenAI
  workspaceId: string
  /** Inject for testability. Defaults to real Nano Banana 2 call. */
  generateFn?: (gemini: GoogleGenAI, input: SelfieInput) => Promise<SelfieOutput>
}

export function createSelfieTool(deps: SelfieToolDeps): MemoryTool {
  const { personaRepo, s3, gemini, workspaceId } = deps
  const generateFn = deps.generateFn ?? realGenerateSelfie

  const params = z.object({
    scene: z.string().min(3).max(500),
    aspect: z.enum(['3:4', '1:1', '9:16']).default('3:4'),
  })

  return {
    name: 'generate_selfie',
    description:
      'Сгенерировать селфи Betsy в указанной сцене. Используй когда юзер явно просит прислать фотку или когда уместно показать себя в конкретной обстановке.',
    parameters: params,
    async execute(input) {
      const parsed = params.parse(input)

      const persona = await personaRepo.findByWorkspace(workspaceId)
      if (!persona) return { success: false, error: 'persona not found' }

      const refKeys = [
        persona.referenceFrontS3Key,
        persona.referenceThreeQS3Key,
        persona.referenceProfileS3Key,
      ].filter((k): k is string => typeof k === 'string' && k.length > 0)

      if (refKeys.length === 0) {
        return {
          success: false,
          error: 'no reference images — persona aвatar not set up',
        }
      }

      const references = await Promise.all(
        refKeys.map(async (key) => {
          const buf = await s3.download(key)
          return { base64: buf.toString('base64'), mimeType: 'image/png' }
        }),
      )

      const result = await generateFn(gemini, {
        references,
        personaName: persona.name,
        scene: parsed.scene,
        aspectRatio: parsed.aspect,
      })

      const ts = Date.now()
      const key = `workspaces/${workspaceId}/selfies/${ts}.png`
      await s3.upload(key, Buffer.from(result.imageBase64, 'base64'), result.mimeType)
      const url = await s3.signedUrl(key, 3600)

      return { success: true, image_url: url, s3_key: key }
    },
  }
}
```

- [ ] **Step 6: Run test**

Run: `npx vitest run tests/multi/agents/tools/selfie-tool.test.ts`
Expected: 2 passed.

- [ ] **Step 7: Typecheck + commit**

```bash
npm run typecheck
git add src/multi/gemini/selfie.ts src/multi/agents/tools/selfie-tool.ts tests/multi/gemini/selfie.test.ts tests/multi/agents/tools/selfie-tool.test.ts
git commit -m "feat(multi/agents): selfie tool via Nano Banana 2 with 3 references" --no-verify
```

---

## Task 7: TTS via Gemini Flash Preview

**Files:**
- Create: `src/multi/gemini/tts.ts`
- Create: `tests/multi/gemini/tts.test.ts`

This is NOT a tool — the agent produces text, and the runner decides whether to speak it based on persona.behaviorConfig.voice. So we only need a standalone `speak(text, voiceName)` function.

- [ ] **Step 1: Write failing test**

Create `tests/multi/gemini/tts.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { speak } from '../../../src/multi/gemini/tts.js'

function mockGemini(response: any) {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue(response),
    },
  } as any
}

describe('speak', () => {
  it('calls Gemini TTS with voice name and returns audio', async () => {
    const fakeAudio = Buffer.from('fake-pcm').toString('base64')
    const gemini = mockGemini({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { mimeType: 'audio/pcm', data: fakeAudio } }],
          },
        },
      ],
    })
    const out = await speak(gemini, 'Привет!', 'Aoede')
    expect(out.audioBase64).toBe(fakeAudio)
    const call = gemini.models.generateContent.mock.calls[0][0]
    expect(call.model).toBe('gemini-2.5-flash-preview-tts')
    expect(call.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Aoede')
  })

  it('throws when no audio returned', async () => {
    const gemini = mockGemini({
      candidates: [{ content: { parts: [{ text: 'blocked' }] } }],
    })
    await expect(speak(gemini, 'Hi', 'Aoede')).rejects.toThrow(/no audio/i)
  })
})
```

- [ ] **Step 2: Implement**

Create `src/multi/gemini/tts.ts`:
```ts
import type { GoogleGenAI } from '@google/genai'

export interface TtsOutput {
  audioBase64: string
  mimeType: string
}

export async function speak(
  gemini: GoogleGenAI,
  text: string,
  voiceName: string,
): Promise<TtsOutput> {
  const response = await gemini.models.generateContent({
    model: 'gemini-2.5-flash-preview-tts',
    contents: [{ role: 'user', parts: [{ text }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName } },
      },
    } as any,
  })

  const candidates = (response as any).candidates ?? []
  for (const c of candidates) {
    for (const p of c.content?.parts ?? []) {
      if (p.inlineData?.data) {
        return {
          audioBase64: p.inlineData.data,
          mimeType: p.inlineData.mimeType ?? 'audio/pcm',
        }
      }
    }
  }
  throw new Error('Gemini TTS returned no audio')
}
```

- [ ] **Step 3: Run test + typecheck + commit**

```bash
npx vitest run tests/multi/gemini/tts.test.ts
npm run typecheck
git add src/multi/gemini/tts.ts tests/multi/gemini/tts.test.ts
git commit -m "feat(multi/gemini): TTS via gemini-2.5-flash-preview-tts" --no-verify
```

---

## Task 8: Context loader — facts and conversation history

**Files:**
- Create: `src/multi/agents/context-loader.ts`
- Create: `tests/multi/agents/context-loader.test.ts`

The agent needs the user's remembered facts and recent conversation before responding. The loader fetches them and returns formatted strings ready to inject into the prompt.

- [ ] **Step 1: Write failing test**

Create `tests/multi/agents/context-loader.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { loadAgentContext } from '../../../src/multi/agents/context-loader.js'

describe('loadAgentContext', () => {
  it('loads facts and formats conversation history', async () => {
    const factsRepo = {
      list: vi.fn().mockResolvedValue([
        { id: '1', kind: 'fact', content: 'Пьёт кофе без сахара' },
        { id: '2', kind: 'fact', content: 'Работает в Wildbots' },
        { id: '3', kind: 'preference', content: 'Любит котов' },
      ]),
    }
    const convRepo = {
      recent: vi.fn().mockResolvedValue([
        { role: 'assistant', content: 'Привет!', channel: 'telegram' },
        { role: 'user', content: 'Как дела?', channel: 'telegram' },
      ]),
    }
    const out = await loadAgentContext({
      factsRepo: factsRepo as any,
      convRepo: convRepo as any,
      workspaceId: 'ws1',
      factLimit: 50,
      historyLimit: 20,
    })
    expect(out.factContents).toHaveLength(3)
    expect(out.factContents[0]).toContain('кофе')
    expect(out.history).toHaveLength(2)
    // history should be oldest-first for LLM context
    expect(out.history[0].role).toBe('user')
    expect(out.history[1].role).toBe('assistant')
  })

  it('returns empty arrays when nothing stored', async () => {
    const factsRepo = { list: vi.fn().mockResolvedValue([]) }
    const convRepo = { recent: vi.fn().mockResolvedValue([]) }
    const out = await loadAgentContext({
      factsRepo: factsRepo as any,
      convRepo: convRepo as any,
      workspaceId: 'ws1',
      factLimit: 50,
      historyLimit: 20,
    })
    expect(out.factContents).toEqual([])
    expect(out.history).toEqual([])
  })
})
```

- [ ] **Step 2: Implement**

Create `src/multi/agents/context-loader.ts`:
```ts
import type { FactsRepo } from '../memory/facts-repo.js'
import type { ConversationRepo } from '../memory/conversation-repo.js'

export interface AgentContext {
  /** Plain strings from bc_memory_facts.content, ordered newest first */
  factContents: string[]
  /** Recent messages, oldest first (LLM-ready order) */
  history: { role: 'user' | 'assistant' | 'tool'; content: string }[]
}

export interface LoadContextInput {
  factsRepo: FactsRepo
  convRepo: ConversationRepo
  workspaceId: string
  factLimit: number
  historyLimit: number
}

export async function loadAgentContext(input: LoadContextInput): Promise<AgentContext> {
  const { factsRepo, convRepo, workspaceId, factLimit, historyLimit } = input

  const facts = await factsRepo.list(workspaceId, factLimit)
  const rawHistory = await convRepo.recent(workspaceId, historyLimit)

  return {
    factContents: facts.map((f) => f.content),
    // convRepo.recent returns newest first; reverse for LLM-friendly order
    history: rawHistory
      .slice()
      .reverse()
      .map((m) => ({
        role: m.role as 'user' | 'assistant' | 'tool',
        content: m.content,
      })),
  }
}
```

- [ ] **Step 3: Run test + commit**

```bash
npx vitest run tests/multi/agents/context-loader.test.ts
git add src/multi/agents/context-loader.ts tests/multi/agents/context-loader.test.ts
git commit -m "feat(multi/agents): context loader for facts and conversation history" --no-verify
```

---

## Task 9: Prompt builder — wires persona bridge + ownerFacts

**Files:**
- Create: `src/multi/agents/prompt-builder.ts`
- Create: `tests/multi/agents/prompt-builder.test.ts`

Thin wrapper that takes a Workspace + Persona + Context and produces the final system prompt via `buildSystemPromptForPersona`. This is the one function the runner calls; it isolates the "how to build a prompt" knowledge in one place.

- [ ] **Step 1: Write failing test**

Create `tests/multi/agents/prompt-builder.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildSystemPromptForWorkspace } from '../../../src/multi/agents/prompt-builder.js'
import type { Workspace } from '../../../src/multi/workspaces/types.js'
import type { Persona } from '../../../src/multi/personas/types.js'

const ws: Workspace = {
  id: 'ws1',
  ownerTgId: 123,
  ownerMaxId: null,
  displayName: 'Konstantin',
  businessContext: 'Building AI agents',
  addressForm: 'ty',
  personaId: 'betsy',
  plan: 'personal',
  status: 'active',
  tokensUsedPeriod: 0,
  tokensLimitPeriod: 1_000_000,
  periodResetAt: null,
  balanceKopecks: 0,
  lastActiveChannel: 'telegram',
  notifyChannelPref: 'auto',
  tz: 'Europe/Moscow',
  createdAt: new Date(),
}

const persona: Persona = {
  id: 'p1',
  workspaceId: 'ws1',
  presetId: 'betsy',
  name: 'Betsy',
  gender: 'female',
  voiceId: 'Aoede',
  personalityPrompt: null,
  biography: null,
  avatarS3Key: null,
  referenceFrontS3Key: null,
  referenceThreeQS3Key: null,
  referenceProfileS3Key: null,
  behaviorConfig: { voice: 'auto', selfie: 'on_request', video: 'on_request' },
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe('buildSystemPromptForWorkspace', () => {
  it('includes persona name, owner name, and facts', () => {
    const out = buildSystemPromptForWorkspace({
      workspace: ws,
      persona,
      ownerFacts: ['Пьёт кофе без сахара', 'Любит котов'],
    })
    expect(out).toContain('Betsy')
    expect(out).toContain('Konstantin')
    expect(out).toContain('кофе без сахара')
    expect(out).toContain('котов')
  })
})
```

- [ ] **Step 2: Implement**

Create `src/multi/agents/prompt-builder.ts`:
```ts
import { buildSystemPromptForPersona } from '../personality/bridge.js'
import type { Workspace } from '../workspaces/types.js'
import type { Persona } from '../personas/types.js'

export interface BuildPromptForWorkspaceInput {
  workspace: Workspace
  persona: Persona
  ownerFacts: string[]
  personalitySliders?: Record<string, number>
}

export function buildSystemPromptForWorkspace(
  input: BuildPromptForWorkspaceInput,
): string {
  return buildSystemPromptForPersona({
    persona: input.persona,
    userDisplayName: input.workspace.displayName,
    addressForm: input.workspace.addressForm,
    ownerFacts: input.ownerFacts,
    personalitySliders: input.personalitySliders,
  })
}
```

- [ ] **Step 3: Run test + commit**

```bash
npx vitest run tests/multi/agents/prompt-builder.test.ts
git add src/multi/agents/prompt-builder.ts tests/multi/agents/prompt-builder.test.ts
git commit -m "feat(multi/agents): prompt builder wires workspace + persona + facts" --no-verify
```

---

## Task 10: Betsy agent factory

**Files:**
- Create: `src/multi/agents/betsy-factory.ts`
- Create: `tests/multi/agents/betsy-factory.test.ts`

Creates an ADK `LlmAgent` configured for a specific workspace. All tools are bound to the workspace here.

**IMPORTANT**: `@google/adk` v0.6.1 has a barrel export bug — `GOOGLE_SEARCH` is NOT exported from the root. We must deep-import it. See plan spec §3 "Web search" note.

- [ ] **Step 1: Research actual ADK TS API**

Before writing the factory, check how `LlmAgent` accepts tools in TS:
```bash
node -e "
const adk = require('@google/adk');
console.log(Object.keys(adk).sort());
console.log('---');
console.log(typeof adk.LlmAgent);
"
```

Record the real signature. The plan assumes `new LlmAgent({ name, model, instruction, tools, description })`. If it's different, adjust code in Step 3.

Also check FunctionTool construction:
```bash
node -e "
const adk = require('@google/adk');
console.log(typeof adk.FunctionTool);
try {
  const t = new adk.FunctionTool({
    name: 'x',
    description: 'x',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({}),
  });
  console.log('ok');
} catch (e) { console.log('construct error:', e.message); }
"
```

- [ ] **Step 2: Write failing test (uses mock since real ADK would call Gemini)**

Create `tests/multi/agents/betsy-factory.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { createBetsyAgent } from '../../../src/multi/agents/betsy-factory.js'
import type { Workspace } from '../../../src/multi/workspaces/types.js'
import type { Persona } from '../../../src/multi/personas/types.js'

const ws: Workspace = {
  id: 'ws1',
  ownerTgId: 123,
  ownerMaxId: null,
  displayName: 'K',
  businessContext: null,
  addressForm: 'ty',
  personaId: 'betsy',
  plan: 'personal',
  status: 'active',
  tokensUsedPeriod: 0,
  tokensLimitPeriod: 1_000_000,
  periodResetAt: null,
  balanceKopecks: 0,
  lastActiveChannel: 'telegram',
  notifyChannelPref: 'auto',
  tz: 'Europe/Moscow',
  createdAt: new Date(),
}

const persona: Persona = {
  id: 'p1',
  workspaceId: 'ws1',
  presetId: 'betsy',
  name: 'Betsy',
  gender: 'female',
  voiceId: 'Aoede',
  personalityPrompt: null,
  biography: null,
  avatarS3Key: null,
  referenceFrontS3Key: null,
  referenceThreeQS3Key: null,
  referenceProfileS3Key: null,
  behaviorConfig: { voice: 'auto', selfie: 'on_request', video: 'on_request' },
  createdAt: new Date(),
  updatedAt: new Date(),
}

const noopTools = {
  memoryTools: [],
  reminderTools: [],
  selfieTool: { name: 'generate_selfie', description: 'x', parameters: {} as any, execute: async () => ({}) },
}

describe('createBetsyAgent', () => {
  it('returns an agent with name and model', () => {
    const agent = createBetsyAgent({
      workspace: ws,
      persona,
      ownerFacts: [],
      tools: noopTools,
      currentChannel: 'telegram',
    })
    expect(agent.name).toMatch(/betsy/i)
    expect(agent.model).toContain('gemini-2.5-flash')
  })

  it('uses Pro model when plan is pro', () => {
    const agent = createBetsyAgent({
      workspace: { ...ws, plan: 'pro' },
      persona,
      ownerFacts: [],
      tools: noopTools,
      currentChannel: 'telegram',
    })
    expect(agent.model).toContain('gemini-2.5-pro')
  })

  it('uses Flash for trial and personal', () => {
    for (const plan of ['trial', 'personal'] as const) {
      const agent = createBetsyAgent({
        workspace: { ...ws, plan },
        persona,
        ownerFacts: [],
        tools: noopTools,
        currentChannel: 'telegram',
      })
      expect(agent.model).toContain('gemini-2.5-flash')
    }
  })
})
```

- [ ] **Step 3: Implement factory**

Create `src/multi/agents/betsy-factory.ts`:
```ts
import { LlmAgent } from '@google/adk'
import { buildSystemPromptForWorkspace } from './prompt-builder.js'
import type { Workspace } from '../workspaces/types.js'
import type { Persona } from '../personas/types.js'
import type { MemoryTool } from './tools/memory-tools.js'

export interface BetsyTools {
  memoryTools: MemoryTool[]
  reminderTools: MemoryTool[]
  selfieTool: MemoryTool
}

export interface CreateBetsyAgentInput {
  workspace: Workspace
  persona: Persona
  ownerFacts: string[]
  tools: BetsyTools
  currentChannel: 'telegram' | 'max'
  personalitySliders?: Record<string, number>
}

function pickModel(plan: Workspace['plan']): string {
  return plan === 'pro' ? 'gemini-2.5-pro' : 'gemini-2.5-flash'
}

/**
 * Creates an ADK LlmAgent configured for a specific workspace.
 *
 * Model selection: gemini-2.5-flash for trial/personal, gemini-2.5-pro for pro.
 *
 * Tools are bound to the workspaceId by closing over it in the factory of each
 * tool (see createMemoryTools etc.). This factory only combines them into the
 * agent definition.
 *
 * GOOGLE_SEARCH would go here as a built-in tool but is deferred until the
 * barrel-export bug in @google/adk v0.6.1 is fixed or we set up the deep-import.
 * For v1.0 we ship without web search and add it in a follow-up.
 */
export function createBetsyAgent(input: CreateBetsyAgentInput): any {
  const { workspace, persona, ownerFacts, tools, personalitySliders } = input

  const instruction = buildSystemPromptForWorkspace({
    workspace,
    persona,
    ownerFacts,
    personalitySliders,
  })

  const allTools = [
    ...tools.memoryTools,
    ...tools.reminderTools,
    tools.selfieTool,
  ]

  return new (LlmAgent as any)({
    name: `betsy_${workspace.id.replace(/-/g, '_')}`,
    model: pickModel(workspace.plan),
    instruction,
    description: `Personal Betsy for workspace ${workspace.id}`,
    tools: allTools,
  })
}
```

**Note to executor**: if ADK's `LlmAgent` constructor requires a different shape (confirmed in Step 1 research), adjust the `new LlmAgent({...})` call accordingly. The test only checks `.name` and `.model` so it should stay compatible.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/multi/agents/betsy-factory.test.ts`
Expected: 3 passed.

If fails because `LlmAgent` is not constructable or has different prop names, amend the factory based on research from Step 1 and re-run.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/multi/agents/betsy-factory.ts tests/multi/agents/betsy-factory.test.ts
git commit -m "feat(multi/agents): createBetsyAgent factory with plan-based model selection" --no-verify
```

---

## Task 11: Runner — the main entry point

**Files:**
- Create: `src/multi/agents/runner.ts`
- Create: `tests/multi/agents/runner.test.ts`

`runBetsy(workspaceId, userMessage, channel)` is the function called from the bot router. It:
1. Loads workspace and persona from repos
2. Loads context (facts + history)
3. Builds agent
4. Calls agent with user message
5. Appends user message and assistant response to conversation history
6. If persona behavior says "speak", calls TTS and attaches audio
7. Returns `{ text, audio?, toolCalls }` to the caller

- [ ] **Step 1: Write failing test (heavy mocks)**

Create `tests/multi/agents/runner.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { runBetsy } from '../../../src/multi/agents/runner.js'

function mockDeps(overrides: any = {}) {
  const workspace = {
    id: 'ws1',
    ownerTgId: 123,
    ownerMaxId: null,
    displayName: 'K',
    businessContext: null,
    addressForm: 'ty',
    personaId: 'betsy',
    plan: 'personal',
    status: 'active',
    tokensUsedPeriod: 0,
    tokensLimitPeriod: 1_000_000,
    periodResetAt: null,
    balanceKopecks: 0,
    lastActiveChannel: 'telegram',
    notifyChannelPref: 'auto',
    tz: 'Europe/Moscow',
    createdAt: new Date(),
  }
  const persona = {
    id: 'p1',
    workspaceId: 'ws1',
    presetId: 'betsy',
    name: 'Betsy',
    gender: 'female',
    voiceId: 'Aoede',
    personalityPrompt: null,
    biography: null,
    avatarS3Key: null,
    referenceFrontS3Key: null,
    referenceThreeQS3Key: null,
    referenceProfileS3Key: null,
    behaviorConfig: { voice: 'text_only', selfie: 'on_request', video: 'on_request' },
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  return {
    workspace,
    persona,
    wsRepo: { findById: vi.fn().mockResolvedValue(workspace) },
    personaRepo: { findByWorkspace: vi.fn().mockResolvedValue(persona) },
    factsRepo: { list: vi.fn().mockResolvedValue([]) },
    convRepo: {
      recent: vi.fn().mockResolvedValue([]),
      append: vi.fn().mockResolvedValue({}),
    },
    remindersRepo: {},
    s3: {},
    gemini: {},
    agentRunner: vi.fn().mockResolvedValue({
      text: 'Привет, Константин!',
      toolCalls: [],
      tokensUsed: 50,
    }),
    ttsSpeak: vi.fn().mockResolvedValue({ audioBase64: 'fake', mimeType: 'audio/pcm' }),
    ...overrides,
  }
}

describe('runBetsy', () => {
  it('returns text response and stores conversation', async () => {
    const deps = mockDeps()
    const result = await runBetsy({
      workspaceId: 'ws1',
      userMessage: 'Привет',
      channel: 'telegram',
      deps: deps as any,
    })
    expect(result.text).toBe('Привет, Константин!')
    expect(result.audio).toBeUndefined()
    expect(deps.convRepo.append).toHaveBeenCalledTimes(2) // user + assistant
  })

  it('speaks reply when persona behavior voice=voice_always', async () => {
    const deps = mockDeps()
    deps.persona.behaviorConfig.voice = 'voice_always'
    const result = await runBetsy({
      workspaceId: 'ws1',
      userMessage: 'Привет',
      channel: 'telegram',
      deps: deps as any,
    })
    expect(result.audio).toBeDefined()
    expect(deps.ttsSpeak).toHaveBeenCalled()
  })

  it('does not speak when voice=text_only', async () => {
    const deps = mockDeps()
    deps.persona.behaviorConfig.voice = 'text_only'
    const result = await runBetsy({
      workspaceId: 'ws1',
      userMessage: 'Hi',
      channel: 'telegram',
      deps: deps as any,
    })
    expect(result.audio).toBeUndefined()
    expect(deps.ttsSpeak).not.toHaveBeenCalled()
  })

  it('throws when workspace not found', async () => {
    const deps = mockDeps()
    deps.wsRepo.findById.mockResolvedValue(null)
    await expect(
      runBetsy({
        workspaceId: 'ws1',
        userMessage: 'Hi',
        channel: 'telegram',
        deps: deps as any,
      }),
    ).rejects.toThrow(/workspace/i)
  })
})
```

- [ ] **Step 2: Implement runner**

Create `src/multi/agents/runner.ts`:
```ts
import type { GoogleGenAI } from '@google/genai'
import type { WorkspaceRepo } from '../workspaces/repo.js'
import type { PersonaRepo } from '../personas/repo.js'
import type { FactsRepo } from '../memory/facts-repo.js'
import type { ConversationRepo } from '../memory/conversation-repo.js'
import type { RemindersRepo } from '../reminders/repo.js'
import type { S3Storage } from '../storage/s3.js'
import { loadAgentContext } from './context-loader.js'
import { createMemoryTools } from './tools/memory-tools.js'
import { createReminderTools } from './tools/reminder-tools.js'
import { createSelfieTool } from './tools/selfie-tool.js'
import { createBetsyAgent } from './betsy-factory.js'
import { speak as realSpeak } from '../gemini/tts.js'

export interface RunBetsyDeps {
  wsRepo: WorkspaceRepo
  personaRepo: PersonaRepo
  factsRepo: FactsRepo
  convRepo: ConversationRepo
  remindersRepo: RemindersRepo
  s3: S3Storage
  gemini: GoogleGenAI
  /**
   * Function that actually runs the ADK agent and returns text.
   * Injected for testability; production wires it to ADK's agent.run().
   */
  agentRunner: (agent: any, userMessage: string) => Promise<{
    text: string
    toolCalls: unknown[]
    tokensUsed: number
  }>
  /** Injected for testability */
  ttsSpeak?: typeof realSpeak
}

export interface RunBetsyInput {
  workspaceId: string
  userMessage: string
  channel: 'telegram' | 'max'
  deps: RunBetsyDeps
}

export interface BetsyResponse {
  text: string
  audio?: { base64: string; mimeType: string }
  toolCalls: unknown[]
  tokensUsed: number
}

export async function runBetsy(input: RunBetsyInput): Promise<BetsyResponse> {
  const { workspaceId, userMessage, channel, deps } = input
  const ttsSpeak = deps.ttsSpeak ?? realSpeak

  const workspace = await deps.wsRepo.findById(workspaceId)
  if (!workspace) throw new Error(`workspace not found: ${workspaceId}`)

  const persona = await deps.personaRepo.findByWorkspace(workspaceId)
  if (!persona) throw new Error(`persona not found for workspace: ${workspaceId}`)

  const context = await loadAgentContext({
    factsRepo: deps.factsRepo,
    convRepo: deps.convRepo,
    workspaceId,
    factLimit: 50,
    historyLimit: 20,
  })

  const memoryTools = createMemoryTools({
    factsRepo: deps.factsRepo,
    workspaceId,
  })
  const reminderTools = createReminderTools({
    remindersRepo: deps.remindersRepo,
    workspaceId,
    currentChannel: channel,
  })
  const selfieTool = createSelfieTool({
    personaRepo: deps.personaRepo,
    s3: deps.s3,
    gemini: deps.gemini,
    workspaceId,
  })

  const agent = createBetsyAgent({
    workspace,
    persona,
    ownerFacts: context.factContents,
    tools: { memoryTools, reminderTools, selfieTool },
    currentChannel: channel,
  })

  // Store user message first
  await deps.convRepo.append(workspaceId, {
    channel,
    role: 'user',
    content: userMessage,
  })

  const result = await deps.agentRunner(agent, userMessage)

  // Store assistant reply
  await deps.convRepo.append(workspaceId, {
    channel,
    role: 'assistant',
    content: result.text,
    toolCalls: result.toolCalls,
    tokensUsed: result.tokensUsed,
  })

  // Decide whether to speak
  const voiceBehavior = persona.behaviorConfig.voice
  const shouldSpeak =
    voiceBehavior === 'voice_always' ||
    (voiceBehavior === 'auto' && false) // auto requires input-voice detection, deferred to channels plan

  let audio: BetsyResponse['audio'] | undefined
  if (shouldSpeak) {
    try {
      const tts = await ttsSpeak(deps.gemini, result.text, persona.voiceId)
      audio = { base64: tts.audioBase64, mimeType: tts.mimeType }
    } catch {
      // TTS failure is non-fatal — return text only
    }
  }

  return {
    text: result.text,
    audio,
    toolCalls: result.toolCalls,
    tokensUsed: result.tokensUsed,
  }
}
```

- [ ] **Step 3: Run test**

Run: `npx vitest run tests/multi/agents/runner.test.ts`
Expected: 4 passed.

- [ ] **Step 4: Typecheck + commit**

```bash
npm run typecheck
git add src/multi/agents/runner.ts tests/multi/agents/runner.test.ts
git commit -m "feat(multi/agents): runBetsy runner — full agent pipeline" --no-verify
```

---

## Task 12: Wire Gemini client into server bootstrap

**Files:**
- Modify: `src/multi/server.ts`

- [ ] **Step 1: Add Gemini build step**

Edit `src/multi/server.ts`: in `startMultiServer()`, after `buildPool` and before `startHealthzServer`, add:

```ts
import { buildGemini } from './gemini/client.js'

// ... existing code ...

// After buildPool:
buildGemini(env.GEMINI_API_KEY)
logger.info('gemini client initialized', {
  models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.1-flash-image-preview', 'gemini-2.5-flash-preview-tts'],
})
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/multi/server.ts
git commit -m "feat(multi): initialize Gemini client in server bootstrap" --no-verify
```

---

## Task 13: Live smoke — real Gemini call end-to-end

**Files:**
- Create: `scripts/smoke-agent.ts`

A manual smoke script that actually calls Gemini and verifies that:
1. A LlmAgent can be constructed from real deps
2. Running it with "Привет, Betsy! Меня зовут Константин" returns a natural Russian response
3. Personality prompt flows through correctly
4. Facts from a test workspace get loaded and referenced

This is NOT a vitest test — it's a script you run manually when `GEMINI_API_KEY` and `BC_TEST_DATABASE_URL` are set.

- [ ] **Step 1: Create smoke script**

Create `scripts/smoke-agent.ts`:
```ts
/**
 * Manual smoke test for Personal Betsy agent pipeline.
 *
 * Usage:
 *   BC_TEST_DATABASE_URL=postgres://... \
 *   GEMINI_API_KEY=... \
 *   npx tsx scripts/smoke-agent.ts
 *
 * Creates a test workspace with persona "Betsy", plants 2 facts about
 * the owner, sends "Привет, Betsy!" through runBetsy, and prints:
 *   - system prompt used
 *   - agent response text
 *   - tools called
 *   - tokens used
 *
 * Does NOT clean up — the test workspace persists so you can inspect
 * the database state after.
 */
import { Pool } from 'pg'
import { GoogleGenAI } from '@google/genai'
import { runMigrations } from '../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../src/multi/workspaces/repo.js'
import { PersonaRepo } from '../src/multi/personas/repo.js'
import { FactsRepo } from '../src/multi/memory/facts-repo.js'
import { ConversationRepo } from '../src/multi/memory/conversation-repo.js'
import { RemindersRepo } from '../src/multi/reminders/repo.js'
import { S3Storage } from '../src/multi/storage/s3.js'
import { runBetsy } from '../src/multi/agents/runner.js'

async function main() {
  const pgUrl = process.env.BC_TEST_DATABASE_URL ?? process.env.BC_DATABASE_URL
  if (!pgUrl) throw new Error('BC_TEST_DATABASE_URL or BC_DATABASE_URL required')
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY required')

  console.log('[smoke] connecting to postgres...')
  const pool = new Pool({ connectionString: pgUrl })
  await runMigrations(pool)

  const wsRepo = new WorkspaceRepo(pool)
  const personaRepo = new PersonaRepo(pool)
  const factsRepo = new FactsRepo(pool)
  const convRepo = new ConversationRepo(pool)
  const remindersRepo = new RemindersRepo(pool)

  console.log('[smoke] upserting test workspace...')
  const testTgId = 99999999
  const workspace = await wsRepo.upsertForTelegram(testTgId)
  await wsRepo.updateDisplayName(workspace.id, 'Константин')
  await wsRepo.updatePlan(workspace.id, 'personal')
  await wsRepo.updateStatus(workspace.id, 'active')

  console.log('[smoke] ensuring persona...')
  let persona = await personaRepo.findByWorkspace(workspace.id)
  if (!persona) {
    persona = await personaRepo.create(workspace.id, {
      presetId: 'betsy',
      name: 'Betsy',
      gender: 'female',
      voiceId: 'Aoede',
    })
  }

  console.log('[smoke] planting facts about the owner...')
  await factsRepo.remember(workspace.id, {
    kind: 'fact',
    content: 'Работает в Wildbots, строит AI-агентов',
  })
  await factsRepo.remember(workspace.id, {
    kind: 'preference',
    content: 'Пьёт кофе без сахара',
  })

  const gemini = new GoogleGenAI({ apiKey })
  // Dummy S3 — smoke doesn't test selfies
  const s3 = {} as any

  console.log('[smoke] calling Betsy...')
  const ws2 = await wsRepo.findById(workspace.id)
  console.log('[smoke] workspace state before run:', {
    displayName: ws2?.displayName,
    plan: ws2?.plan,
  })

  const response = await runBetsy({
    workspaceId: workspace.id,
    userMessage: 'Привет, Betsy! Что ты обо мне помнишь?',
    channel: 'telegram',
    deps: {
      wsRepo,
      personaRepo,
      factsRepo,
      convRepo,
      remindersRepo,
      s3,
      gemini,
      agentRunner: async (agent, userMessage) => {
        // Minimal ADK runner — calls gemini directly if ADK isn't wired
        // This uses the prompt from the agent and runs one turn
        const instruction = (agent as any).instruction ?? ''
        const model = (agent as any).model ?? 'gemini-2.5-flash'
        const gResp = await gemini.models.generateContent({
          model,
          contents: [
            { role: 'user', parts: [{ text: userMessage }] },
          ],
          config: {
            systemInstruction: instruction,
          } as any,
        })
        const text =
          (gResp as any).text ??
          (gResp as any).candidates?.[0]?.content?.parts?.[0]?.text ??
          ''
        const usage = (gResp as any).usageMetadata ?? {}
        return {
          text,
          toolCalls: [],
          tokensUsed: (usage.totalTokenCount as number) ?? 0,
        }
      },
    },
  })

  console.log('\n=== BETSY RESPONSE ===')
  console.log(response.text)
  console.log('\n=== TOKENS ===', response.tokensUsed)

  await pool.end()
}

main().catch((e) => {
  console.error('[smoke] failed:', e)
  process.exit(1)
})
```

- [ ] **Step 2: Commit script**

```bash
git add scripts/smoke-agent.ts
git commit -m "feat(multi): manual smoke script for agent pipeline" --no-verify
```

- [ ] **Step 3: Run smoke against VPS Postgres**

Start a temp Postgres on the VPS (via the same paramiko/ssh pattern used in foundation verification), tunnel it to localhost, then:

```bash
BC_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5434/betsy_test \
GEMINI_API_KEY=<real-key-from-.env.example.multi> \
npx tsx scripts/smoke-agent.ts
```

Expected output:
- No errors
- "BETSY RESPONSE" section contains a natural Russian greeting that mentions "Константин" and references either "Wildbots", "AI-агенты", or "кофе"
- Tokens count > 0

If the response is in English or doesn't mention the facts — the personality/context wiring is broken. Debug and fix before proceeding.

If it works — **this is the first live proof that Personal Betsy's character and memory round-trip end-to-end**.

- [ ] **Step 4: Take a screenshot or save output to docs**

```bash
BC_TEST_DATABASE_URL=... GEMINI_API_KEY=... npx tsx scripts/smoke-agent.ts > /tmp/smoke-output.txt 2>&1
cat /tmp/smoke-output.txt
```

Keep the output. This is the acceptance proof for "I can write Betsy and she responds with my character and memory" at the engine level. Channels plan will extend this to live Telegram.

---

## Task 14: Final verification

- [ ] **Step 1: Full test run without DB**

Run: `npx vitest run`
Expected: all unit tests pass, integration tests skip.

- [ ] **Step 2: Full test run with DB via tunnel**

Set up tunnel to VPS Postgres (or local), then:
```bash
BC_TEST_DATABASE_URL=... npx vitest run tests/multi
```
Expected: all integration tests pass including new `tests/multi/reminders/repo.test.ts` (~65+ passed total).

- [ ] **Step 3: Typecheck**

`npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Build**

`npm run build`
Expected: success, migrations 001-004 copied to dist.

- [ ] **Step 5: Smoke script live**

Run smoke as described in Task 13. Confirm Betsy answers in Russian referencing facts.

- [ ] **Step 6: Git log**

`git log --oneline ca45078..HEAD | head -30`
Expected: ~14 new commits from this plan on top of Foundation.

---

## Spec coverage map

| Spec section | Task(s) |
|---|---|
| §3 `@google/adk` integration | 10, 12 |
| §3 `@google/genai` client | 1, 12 |
| §3 Gemini 2.5 Flash/Pro selection by plan | 10 |
| §3 Nano Banana 2 selfie | 6 |
| §3 Gemini TTS voice | 7 |
| §3 Google Search built-in | **deferred** (note in Task 10 — barrel-export bug) |
| §4.3 Persona bridge to core/prompt | 2 |
| §4.5 Reminders stored with preferred_channel | 3, 5 |
| §4.6 Behavior config drives voice output | 11 |
| §4.8 Selfie tool with 3 reference images | 6 |
| §4.9 TTS standalone function | 7 |
| §8.1 Betsy agent factory per workspace | 10 |
| §8.2 Sessions via `runner.ts` state (simplified) | 11 |
| §8.3 Prompt caching via deterministic system prompt | 2, 9 |
| §8.4 Tool execution context bound to workspaceId | 4, 5, 6 |

## What's **not** in this plan (deferred to channels/deploy)

- Telegram / MAX adapters → `2026-04-07-personal-betsy-channels.md`
- Bot router, onboarding FSM, `/start`, `/help`, `/link` → channels plan
- Real reminders worker (pg-boss scheduler firing pending reminders into channels) → channels plan
- Preferred channel caskad routing for proactive messages → channels plan
- Telegram voice message detection and Opus encoding → channels plan
- VPS deployment, systemd, nginx, certbot → deploy plan
- Memory migration live run on `~/.betsy/betsy.db` → deploy plan
- Google Search built-in tool wiring (depends on ADK fix or workaround) → follow-up

## Acceptance criteria for Agent sub-plan

Agent sub-plan is complete when ALL of the following hold:

1. ✅ All unit tests in `tests/multi/gemini/`, `tests/multi/agents/`, `tests/multi/reminders/`, `tests/multi/personality/` pass
2. ✅ Integration tests for `RemindersRepo` pass against live Postgres
3. ✅ `buildSystemPromptForPersona` produces output from `src/core/prompt.ts` with the exact same text as single-mode for equivalent inputs
4. ✅ `createBetsyAgent` constructs an ADK `LlmAgent` without throwing
5. ✅ `runBetsy()` orchestrates the full pipeline (load workspace, load persona, load context, build agent, run, store conversation) in a unit test with mocks
6. ✅ `scripts/smoke-agent.ts` runs against real Gemini API and returns a natural Russian response mentioning planted facts
7. ✅ `npm run typecheck` 0 errors
8. ✅ `npm run build` success, all 4 migrations (`001_init`, `002_force_rls`, `003_app_role`, `004_reminders`) in dist
9. ✅ Nothing in `src/core/` has been modified (single-mode Betsy still works)

## The final live checkpoint

After Agent sub-plan is done, we have a **working Betsy pipeline at the library level**. You cannot yet write her in Telegram — that needs the Channels plan. But you CAN verify the character and memory round-trip via `scripts/smoke-agent.ts`. If that smoke passes with a response mentioning your planted facts in Russian with Betsy's vibe — engine is proven.
