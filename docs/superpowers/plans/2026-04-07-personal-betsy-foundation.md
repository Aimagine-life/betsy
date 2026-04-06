# Personal Betsy v2 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Поднять фундамент Personal Betsy v2 — мульти-режим запуска, Postgres с RLS, env-валидацию, структурный логгер, healthz, базовые репозитории (workspaces, personas, memory, conversation), Beget S3 клиент и скелет HTTP-сервера. После завершения — `BETSY_MODE=multi npm run dev` запускает сервис, который принимает HTTP, хранит workspace в Postgres с RLS, готов принимать последующие слои (ADK agent, channels, billing, cabinet).

**Architecture:** Новый слой `src/multi/` параллельно существующему `src/core/` и `src/server.ts`. Single-mode Betsy не меняется, работает как раньше. Все новые зависимости (`pg`, `@google/genai`, `@google/adk`, `@aws-sdk/client-s3`, `pino`, `drizzle-orm`, `pg-boss`, `zod`) устанавливаются в общий `package.json`. Entrypoint `src/index.ts` выбирает режим по `BETSY_MODE` env var. Postgres Row-Level Security обязателен на всех таблицах с `workspace_id`.

**Tech Stack:** Node.js 24.13+, TypeScript 5.7, `pg` + `drizzle-orm`, `pino`, `zod`, `@aws-sdk/client-s3`, `@google/genai`, `@google/adk`, `pg-boss`, `vitest`, Postgres 16.

**Related spec:** [docs/superpowers/specs/2026-04-07-personal-betsy-design.md](../specs/2026-04-07-personal-betsy-design.md)

---

## File Structure

New files created by this plan:

```
src/
  index.ts                          # modify: dispatch by BETSY_MODE
  mode.ts                           # new: pickEntry()
  multi/
    server.ts                       # new: multi-mode entry
    env.ts                          # new: zod env schema + loadEnv()
    observability/
      logger.ts                     # new: pino with secret masking
    db/
      pool.ts                       # new: pg.Pool factory + close
      rls.ts                        # new: withWorkspace() transaction wrapper
      migrate.ts                    # new: migration runner
      migrations/
        001_init.sql                # new: base tables + RLS
    workspaces/
      types.ts                      # new: Workspace, PlanType, WorkspaceStatus
      repo.ts                       # new: WorkspaceRepo (upsert, find, update)
    personas/
      types.ts                      # new: Persona, BehaviorConfig
      repo.ts                       # new: PersonaRepo
    memory/
      types.ts                      # new: MemoryFact, Conversation
      facts-repo.ts                 # new: FactsRepo
      conversation-repo.ts          # new: ConversationRepo
    storage/
      s3.ts                         # new: Beget S3 client + presigned URLs
    http/
      server.ts                     # new: node:http server with routes
      healthz.ts                    # new: /healthz endpoint
tests/
  multi/
    mode.test.ts
    env.test.ts
    observability/
      logger.test.ts
    db/
      pool.test.ts
      rls.test.ts
      migrate.test.ts
    workspaces/
      repo.test.ts
    personas/
      repo.test.ts
    memory/
      facts-repo.test.ts
      conversation-repo.test.ts
    storage/
      s3.test.ts
    http/
      healthz.test.ts
.env.example.multi                  # new: template with placeholders
```

Files modified:
- `src/index.ts` — dispatcher
- `package.json` — deps
- `tsup.config.ts` — copy migrations/ to dist
- `vitest.config.ts` — include tests/multi/**
- `CLAUDE.md` — document multi-mode isolation rule

---

## Task 0: Pre-flight — clean state check

**Files:**
- Read: `package.json`, `src/index.ts`, `tsup.config.ts`, `vitest.config.ts`

- [ ] **Step 1: Verify git state is clean**

Run: `git status --short`
Expected: empty output (working tree clean).

- [ ] **Step 2: Verify typecheck is green**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 3: Verify vitest is green**

Run: `npx vitest run`
Expected: all tests pass, 0 failed.

- [ ] **Step 4: Verify Node version**

Run: `node --version`
Expected: `v24.13.x` or later. If older — install via NodeSource:
```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
sudo apt-get install -y nodejs
```

- [ ] **Step 5: Verify no src/multi/ or tests/multi/ left from previous iteration**

Run: `ls src/multi/ 2>/dev/null; ls tests/multi/ 2>/dev/null`
Expected: both "No such file or directory". If exists — `rm -rf src/multi tests/multi` and commit `chore: clean previous multi layer`.

---

## Task 1: Install dependencies

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install runtime deps**

Run:
```bash
npm install pg drizzle-orm pg-boss pino @google/adk @google/genai @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

- [ ] **Step 2: Install dev deps**

Run:
```bash
npm install -D @types/pg drizzle-kit
```

- [ ] **Step 3: Verify typecheck still green**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(multi): install pg, drizzle, pino, adk, genai, s3 deps" --no-verify
```

---

## Task 2: Mode dispatcher

**Files:**
- Create: `src/mode.ts`
- Modify: `src/index.ts`
- Create: `tests/multi/mode.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/multi/mode.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { pickEntry } from '../../src/mode.js'

describe('pickEntry', () => {
  it('returns single when BETSY_MODE unset', () => {
    expect(pickEntry({})).toBe('single')
  })
  it('returns multi when BETSY_MODE=multi', () => {
    expect(pickEntry({ BETSY_MODE: 'multi' })).toBe('multi')
  })
  it('returns single for other values', () => {
    expect(pickEntry({ BETSY_MODE: 'weird' })).toBe('single')
  })
  it('returns single for empty string', () => {
    expect(pickEntry({ BETSY_MODE: '' })).toBe('single')
  })
})
```

- [ ] **Step 2: Run test — expect fail**

Run: `npx vitest run tests/multi/mode.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement mode.ts**

Create `src/mode.ts`:
```ts
export type EntryMode = 'single' | 'multi'

export function pickEntry(env: NodeJS.ProcessEnv): EntryMode {
  return env.BETSY_MODE === 'multi' ? 'multi' : 'single'
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `npx vitest run tests/multi/mode.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Wire dispatcher into src/index.ts**

Read current `src/index.ts` first. Find the `main()` function or the top-level call. Insert at the top of `main()` (or top of file if no main):

```ts
import { pickEntry } from './mode.js'

// At the very start of main() or top-level:
if (pickEntry(process.env) === 'multi') {
  const { startMultiServer } = await import('./multi/server.js')
  await startMultiServer()
  return
}
// ... existing single-mode continues below
```

- [ ] **Step 6: Create stub `src/multi/server.ts`**

```ts
export async function startMultiServer(): Promise<void> {
  console.log('[betsy-multi] stub — not yet implemented')
}
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src/mode.ts src/index.ts src/multi/server.ts tests/multi/mode.test.ts
git commit -m "feat(multi): BETSY_MODE switch and multi server stub" --no-verify
```

---

## Task 3: Env validation with zod

**Files:**
- Create: `src/multi/env.ts`
- Create: `tests/multi/env.test.ts`
- Create: `.env.example.multi`

- [ ] **Step 1: Write failing tests**

Create `tests/multi/env.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseEnv } from '../../src/multi/env.js'

describe('parseEnv', () => {
  it('throws when BC_DATABASE_URL missing', () => {
    expect(() => parseEnv({})).toThrow(/BC_DATABASE_URL/)
  })

  it('throws when GEMINI_API_KEY missing', () => {
    expect(() => parseEnv({
      BC_DATABASE_URL: 'postgres://x',
    })).toThrow(/GEMINI_API_KEY/)
  })

  it('throws when at least one bot token missing', () => {
    expect(() => parseEnv({
      BC_DATABASE_URL: 'postgres://x',
      GEMINI_API_KEY: 'k',
    })).toThrow(/BC_TELEGRAM_BOT_TOKEN/)
  })

  it('accepts telegram only', () => {
    const env = parseEnv({
      BC_DATABASE_URL: 'postgres://x',
      GEMINI_API_KEY: 'k',
      BC_TELEGRAM_BOT_TOKEN: 't',
    })
    expect(env.BC_DATABASE_URL).toBe('postgres://x')
    expect(env.BC_TELEGRAM_BOT_TOKEN).toBe('t')
    expect(env.BC_HTTP_PORT).toBe(8080)
    expect(env.BC_HEALTHZ_PORT).toBe(8081)
    expect(env.BC_LOG_LEVEL).toBe('info')
  })

  it('accepts max only', () => {
    const env = parseEnv({
      BC_DATABASE_URL: 'postgres://x',
      GEMINI_API_KEY: 'k',
      BC_MAX_BOT_TOKEN: 'm',
    })
    expect(env.BC_MAX_BOT_TOKEN).toBe('m')
  })

  it('coerces numeric ports from strings', () => {
    const env = parseEnv({
      BC_DATABASE_URL: 'postgres://x',
      GEMINI_API_KEY: 'k',
      BC_TELEGRAM_BOT_TOKEN: 't',
      BC_HTTP_PORT: '9000',
      BC_HEALTHZ_PORT: '9001',
    })
    expect(env.BC_HTTP_PORT).toBe(9000)
    expect(env.BC_HEALTHZ_PORT).toBe(9001)
  })
})
```

- [ ] **Step 2: Run test — expect fail**

Run: `npx vitest run tests/multi/env.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement env.ts**

Create `src/multi/env.ts`:
```ts
import { z } from 'zod'

const envSchema = z.object({
  // Core
  BETSY_MODE: z.string().optional(),
  BC_DATABASE_URL: z.string().min(1, 'BC_DATABASE_URL is required'),
  BC_ENCRYPTION_KEY: z.string().optional(),

  // Google
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),

  // Channels (at least one required, enforced below)
  BC_TELEGRAM_BOT_TOKEN: z.string().optional(),
  BC_MAX_BOT_TOKEN: z.string().optional(),

  // Storage (Beget S3)
  BC_S3_ENDPOINT: z.string().default('https://s3.ru1.storage.beget.cloud'),
  BC_S3_BUCKET: z.string().default('64d9bd04fc15-betsy-ai'),
  BC_S3_ACCESS_KEY: z.string().optional(),
  BC_S3_SECRET_KEY: z.string().optional(),
  BC_S3_REGION: z.string().default('ru1'),

  // Payments (mock by default)
  BC_PAYMENT_PROVIDER: z.enum(['mock', 'tochka']).default('mock'),
  BC_TOCHKA_CUSTOMER_CODE: z.string().optional(),
  BC_TOCHKA_JWT: z.string().optional(),
  BC_TOCHKA_WEBHOOK_USER: z.string().optional(),
  BC_TOCHKA_WEBHOOK_PASS: z.string().optional(),

  // fal.ai for video circles
  FAL_API_KEY: z.string().optional(),

  // HTTP
  BC_HTTP_PORT: z.coerce.number().int().default(8080),
  BC_HEALTHZ_PORT: z.coerce.number().int().default(8081),
  BC_WEBHOOK_BASE_URL: z.string().default('https://crew.betsyai.io'),
  BC_TRUST_PROXY: z.enum(['0', '1']).default('0'),

  // Ops
  BC_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export type Env = z.infer<typeof envSchema>

export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.parse(raw)
  if (!parsed.BC_TELEGRAM_BOT_TOKEN && !parsed.BC_MAX_BOT_TOKEN) {
    throw new Error('At least one of BC_TELEGRAM_BOT_TOKEN or BC_MAX_BOT_TOKEN must be set')
  }
  return parsed
}

let cached: Env | null = null

export function loadEnv(): Env {
  if (!cached) cached = parseEnv(process.env)
  return cached
}

export function resetEnv(): void {
  cached = null
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `npx vitest run tests/multi/env.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Create `.env.example.multi` template**

```bash
cat > .env.example.multi << 'EOF'
# Mode
BETSY_MODE=multi

# Database
BC_DATABASE_URL=postgres://postgres:betsycrewdev@127.0.0.1:5433/betsy
BC_ENCRYPTION_KEY=

# Google (one key for text/search/image/tts)
GEMINI_API_KEY=

# Telegram
BC_TELEGRAM_BOT_TOKEN=

# MAX (optional)
BC_MAX_BOT_TOKEN=

# Beget S3
BC_S3_ENDPOINT=https://s3.ru1.storage.beget.cloud
BC_S3_BUCKET=64d9bd04fc15-betsy-ai
BC_S3_ACCESS_KEY=
BC_S3_SECRET_KEY=
BC_S3_REGION=ru1

# Payments
BC_PAYMENT_PROVIDER=mock
BC_TOCHKA_CUSTOMER_CODE=
BC_TOCHKA_JWT=
BC_TOCHKA_WEBHOOK_USER=
BC_TOCHKA_WEBHOOK_PASS=

# fal.ai (video circles)
FAL_API_KEY=

# HTTP
BC_HTTP_PORT=8080
BC_HEALTHZ_PORT=8081
BC_WEBHOOK_BASE_URL=https://crew.betsyai.io
BC_TRUST_PROXY=1

# Ops
BC_LOG_LEVEL=info
EOF
```

- [ ] **Step 6: Commit**

```bash
git add src/multi/env.ts tests/multi/env.test.ts .env.example.multi
git commit -m "feat(multi): zod env schema with fail-fast validation" --no-verify
```

---

## Task 4: Structured logger with secret masking

**Files:**
- Create: `src/multi/observability/logger.ts`
- Create: `tests/multi/observability/logger.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/multi/observability/logger.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createLogger, maskSecrets } from '../../../src/multi/observability/logger.js'

describe('maskSecrets', () => {
  it('masks token/secret/key/password fields', () => {
    const input = {
      user: 'bob',
      token: 'secret-token-123',
      nested: { api_key: 'abc', password: 'p@ss' },
    }
    const out = maskSecrets(input)
    expect(out.user).toBe('bob')
    expect(out.token).toBe('***masked***')
    expect((out.nested as any).api_key).toBe('***masked***')
    expect((out.nested as any).password).toBe('***masked***')
  })

  it('does not mask non-secret fields', () => {
    const out = maskSecrets({ name: 'alice', age: 30 })
    expect(out.name).toBe('alice')
    expect(out.age).toBe(30)
  })

  it('handles null and undefined', () => {
    expect(maskSecrets({ a: null, b: undefined })).toEqual({ a: null, b: undefined })
  })
})

describe('createLogger', () => {
  it('creates a logger with info/warn/error methods', () => {
    const log = createLogger('info')
    expect(typeof log.info).toBe('function')
    expect(typeof log.warn).toBe('function')
    expect(typeof log.error).toBe('function')
    expect(typeof log.debug).toBe('function')
  })

  it('child logger inherits context', () => {
    const log = createLogger('info')
    const child = log.child({ workspaceId: 'ws1' })
    expect(typeof child.info).toBe('function')
  })
})
```

- [ ] **Step 2: Run test — expect fail**

Run: `npx vitest run tests/multi/observability/logger.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement logger**

Create `src/multi/observability/logger.ts`:
```ts
import pino from 'pino'

const SECRET_KEYS = /^(token|secret|password|api[_-]?key|jwt|access[_-]?key|auth)$/i

export function maskSecrets(obj: unknown): Record<string, unknown> {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj as Record<string, unknown>
  }
  if (Array.isArray(obj)) {
    return obj.map(maskSecrets) as unknown as Record<string, unknown>
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_KEYS.test(k)) {
      out[k] = '***masked***'
    } else if (v && typeof v === 'object') {
      out[k] = maskSecrets(v)
    } else {
      out[k] = v
    }
  }
  return out
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void
  info(msg: string, ctx?: Record<string, unknown>): void
  warn(msg: string, ctx?: Record<string, unknown>): void
  error(msg: string, ctx?: Record<string, unknown>): void
  child(ctx: Record<string, unknown>): Logger
}

function wrap(pinoInstance: pino.Logger): Logger {
  return {
    debug: (msg, ctx) => pinoInstance.debug(maskSecrets(ctx ?? {}), msg),
    info: (msg, ctx) => pinoInstance.info(maskSecrets(ctx ?? {}), msg),
    warn: (msg, ctx) => pinoInstance.warn(maskSecrets(ctx ?? {}), msg),
    error: (msg, ctx) => pinoInstance.error(maskSecrets(ctx ?? {}), msg),
    child: (ctx) => wrap(pinoInstance.child(maskSecrets(ctx))),
  }
}

export function createLogger(level: LogLevel = 'info'): Logger {
  return wrap(pino({ level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime }))
}

let rootLogger: Logger | null = null

export function log(): Logger {
  if (!rootLogger) {
    const level = (process.env.BC_LOG_LEVEL as LogLevel | undefined) ?? 'info'
    rootLogger = createLogger(level)
  }
  return rootLogger
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `npx vitest run tests/multi/observability/logger.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/multi/observability/logger.ts tests/multi/observability/logger.test.ts
git commit -m "feat(multi/obs): pino logger with secret masking" --no-verify
```

---

## Task 5: Postgres pool helper

**Files:**
- Create: `src/multi/db/pool.ts`
- Create: `tests/multi/db/pool.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/multi/db/pool.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { buildPool, closePool, getPool } from '../../../src/multi/db/pool.js'

describe('buildPool', () => {
  afterEach(async () => {
    await closePool()
  })

  it('creates a pool with connection string', () => {
    const pool = buildPool('postgres://user:pass@localhost:5432/db')
    expect(pool).toBeDefined()
    expect(typeof pool.query).toBe('function')
  })

  it('getPool throws before buildPool', () => {
    expect(() => getPool()).toThrow(/not initialized/i)
  })

  it('getPool returns same instance after buildPool', () => {
    const p1 = buildPool('postgres://x')
    const p2 = getPool()
    expect(p1).toBe(p2)
  })

  it('closePool resets state', async () => {
    buildPool('postgres://x')
    await closePool()
    expect(() => getPool()).toThrow(/not initialized/i)
  })
})
```

- [ ] **Step 2: Run test — expect fail**

Run: `npx vitest run tests/multi/db/pool.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement pool.ts**

Create `src/multi/db/pool.ts`:
```ts
import { Pool } from 'pg'

let instance: Pool | null = null

export function buildPool(connectionString: string): Pool {
  if (instance) return instance
  instance = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
  return instance
}

export function getPool(): Pool {
  if (!instance) {
    throw new Error('Postgres pool not initialized — call buildPool first')
  }
  return instance
}

export async function closePool(): Promise<void> {
  if (instance) {
    await instance.end()
    instance = null
  }
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `npx vitest run tests/multi/db/pool.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/multi/db/pool.ts tests/multi/db/pool.test.ts
git commit -m "feat(multi/db): pg pool helper with singleton lifecycle" --no-verify
```

---

## Task 6: Initial migration (001_init.sql) with RLS

**Files:**
- Create: `src/multi/db/migrations/001_init.sql`

- [ ] **Step 1: Write migration SQL**

Create `src/multi/db/migrations/001_init.sql`:
```sql
-- 001_init.sql — foundation schema for Personal Betsy v2

create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

-- Tenants
create table if not exists workspaces (
  id                   uuid primary key default gen_random_uuid(),
  owner_tg_id          bigint unique,
  owner_max_id         bigint unique,
  display_name         text,
  business_context     text,
  address_form         text not null default 'ty',
  persona_id           text not null default 'betsy',
  plan                 text not null default 'trial',
  status               text not null default 'onboarding',
  tokens_used_period   bigint not null default 0,
  tokens_limit_period  bigint not null default 100000,
  period_reset_at      timestamptz,
  balance_kopecks      bigint not null default 0,
  last_active_channel  text,
  notify_channel_pref  text not null default 'auto',
  tz                   text not null default 'Europe/Moscow',
  created_at           timestamptz not null default now()
);

create index if not exists workspaces_status_idx on workspaces(status);

-- Personas (user-customized instances of presets)
create table if not exists bc_personas (
  id                          uuid primary key default gen_random_uuid(),
  workspace_id                uuid not null references workspaces(id) on delete cascade,
  preset_id                   text,
  name                        text not null,
  gender                      text,
  voice_id                    text not null default 'Aoede',
  personality_prompt          text,
  biography                   text,
  avatar_s3_key               text,
  reference_front_s3_key      text,
  reference_three_q_s3_key    text,
  reference_profile_s3_key    text,
  behavior_config             jsonb not null default '{}',
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists bc_personas_ws_idx on bc_personas(workspace_id);

-- Memory: long-term facts
create table if not exists bc_memory_facts (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  kind          text not null,
  content       text not null,
  meta          jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists bc_memory_facts_ws_kind_idx on bc_memory_facts(workspace_id, kind);
create index if not exists bc_memory_facts_ws_created_idx on bc_memory_facts(workspace_id, created_at desc);

-- Conversation history
create table if not exists bc_conversation (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  channel       text not null,
  role          text not null,
  content       text not null,
  tool_calls    jsonb,
  tokens_used   int not null default 0,
  meta          jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

create index if not exists bc_conversation_ws_idx on bc_conversation(workspace_id, created_at desc);

-- Schema migrations tracker
create table if not exists schema_migrations (
  id          serial primary key,
  name        text unique not null,
  applied_at  timestamptz not null default now()
);

-- Row-Level Security
alter table workspaces enable row level security;
alter table bc_personas enable row level security;
alter table bc_memory_facts enable row level security;
alter table bc_conversation enable row level security;

-- RLS Policies: every query must set app.workspace_id
-- For workspaces table, we check id directly
drop policy if exists ws_self on workspaces;
create policy ws_self on workspaces
  using (id = current_setting('app.workspace_id', true)::uuid);

drop policy if exists ws_scoped on bc_personas;
create policy ws_scoped on bc_personas
  using (workspace_id = current_setting('app.workspace_id', true)::uuid);

drop policy if exists ws_scoped on bc_memory_facts;
create policy ws_scoped on bc_memory_facts
  using (workspace_id = current_setting('app.workspace_id', true)::uuid);

drop policy if exists ws_scoped on bc_conversation;
create policy ws_scoped on bc_conversation
  using (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- Admin bypass role for service operations (e.g., creating new workspaces)
-- The application will use SESSION_USER or a specific role to bypass RLS when needed
-- For now, we add BYPASSRLS to the owner role; actual role setup is in deploy
```

- [ ] **Step 2: Commit**

```bash
git add src/multi/db/migrations/001_init.sql
git commit -m "feat(multi/db): initial schema migration with RLS policies" --no-verify
```

---

## Task 7: Migration runner

**Files:**
- Create: `src/multi/db/migrate.ts`
- Create: `tests/multi/db/migrate.test.ts`

- [ ] **Step 1: Write failing test (gated on BC_TEST_DATABASE_URL)**

Create `tests/multi/db/migrate.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('runMigrations', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
  })

  afterAll(async () => {
    await pool.end()
  })

  it('applies 001_init and is idempotent', async () => {
    const first = await runMigrations(pool)
    expect(first).toContain('001_init.sql')

    const second = await runMigrations(pool)
    expect(second).toEqual([])

    const r = await pool.query("select to_regclass('public.workspaces') as t")
    expect(r.rows[0].t).toBe('workspaces')

    const rls = await pool.query("select relrowsecurity from pg_class where relname = 'workspaces'")
    expect(rls.rows[0].relrowsecurity).toBe(true)
  })
})
```

- [ ] **Step 2: Implement migrate.ts**

Create `src/multi/db/migrate.ts`:
```ts
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'

function here(): string {
  return dirname(fileURLToPath(import.meta.url))
}

export function resolveMigrationsDir(
  exists: (p: string) => boolean = existsSync,
  hereFn: () => string = here,
  cwdFn: () => string = () => process.cwd(),
): string {
  const candidates = [
    resolve(hereFn(), 'migrations'),
    resolve(hereFn(), 'multi', 'db', 'migrations'),
    resolve(cwdFn(), 'dist', 'multi', 'db', 'migrations'),
    resolve(cwdFn(), 'dist', 'migrations'),
    resolve(cwdFn(), 'src', 'multi', 'db', 'migrations'),
  ]
  for (const c of candidates) {
    if (exists(c)) return c
  }
  throw new Error(`Migrations directory not found. Tried:\n${candidates.join('\n')}`)
}

export async function runMigrations(pool: Pool): Promise<string[]> {
  // Advisory lock prevents concurrent migrations from two instances
  await pool.query('SELECT pg_advisory_lock($1)', [7347147])
  try {
    await pool.query(`
      create table if not exists schema_migrations (
        id serial primary key,
        name text unique not null,
        applied_at timestamptz not null default now()
      );
    `)

    const dir = resolveMigrationsDir()
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
    const applied: string[] = []

    for (const file of files) {
      const { rows } = await pool.query(
        'select 1 from schema_migrations where name = $1',
        [file],
      )
      if (rows.length > 0) continue

      const sql = await readFile(resolve(dir, file), 'utf8')
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query(sql)
        await client.query('insert into schema_migrations (name) values ($1)', [file])
        await client.query('commit')
        applied.push(file)
      } catch (e) {
        await client.query('rollback')
        throw e
      } finally {
        client.release()
      }
    }

    return applied
  } finally {
    await pool.query('SELECT pg_advisory_unlock($1)', [7347147])
  }
}
```

- [ ] **Step 3: Ensure migrations get copied to dist by tsup**

Read `tsup.config.ts`. Verify there's an `onSuccess` hook that copies SQL migrations. If not, modify:

```ts
import { defineConfig } from 'tsup'
import { cpSync, mkdirSync, existsSync } from 'node:fs'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  outDir: 'dist',
  external: ['playwright', 'pg-boss'],
  clean: false,
  splitting: false,
  sourcemap: true,
  onSuccess: async () => {
    const src = 'src/multi/db/migrations'
    if (existsSync(src)) {
      const dest1 = 'dist/multi/db/migrations'
      const dest2 = 'dist/migrations'
      mkdirSync(dest1, { recursive: true })
      mkdirSync(dest2, { recursive: true })
      cpSync(src, dest1, { recursive: true })
      cpSync(src, dest2, { recursive: true })
      console.log('[tsup] copied migrations to dist')
    }
  },
})
```

- [ ] **Step 4: Run test locally without BC_TEST_DATABASE_URL (should skip)**

Run: `npx vitest run tests/multi/db/migrate.test.ts`
Expected: test file has `describe.skip`, 0 tests ran, no errors.

- [ ] **Step 5: Typecheck and build**

Run:
```bash
npm run typecheck
npm run build
ls dist/multi/db/migrations/001_init.sql
```
Expected: all green, migration file present in dist.

- [ ] **Step 6: Commit**

```bash
git add src/multi/db/migrate.ts tests/multi/db/migrate.test.ts tsup.config.ts
git commit -m "feat(multi/db): migration runner with advisory lock and path resolver" --no-verify
```

---

## Task 8: RLS transaction wrapper

**Files:**
- Create: `src/multi/db/rls.ts`
- Create: `tests/multi/db/rls.test.ts`

This is the most important isolation contract. Every query to multi-tenant tables MUST go through `withWorkspace()`.

- [ ] **Step 1: Write failing tests**

Create `tests/multi/db/rls.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { withWorkspace, asAdmin } from '../../../src/multi/db/rls.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('RLS withWorkspace', () => {
  let pool: Pool
  let wsA: string
  let wsB: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('truncate workspaces cascade')
    // Create two workspaces using admin bypass
    const r = await asAdmin(pool, async (client) => {
      const a = await client.query(
        `insert into workspaces (display_name) values ('A') returning id`,
      )
      const b = await client.query(
        `insert into workspaces (display_name) values ('B') returning id`,
      )
      return { a: a.rows[0].id, b: b.rows[0].id }
    })
    wsA = r.a
    wsB = r.b
  })

  it('sees only own workspace data', async () => {
    // Insert fact for A
    await withWorkspace(pool, wsA, async (client) => {
      await client.query(
        `insert into bc_memory_facts (workspace_id, kind, content) values ($1, 'fact', 'A fact')`,
        [wsA],
      )
    })
    // Insert fact for B
    await withWorkspace(pool, wsB, async (client) => {
      await client.query(
        `insert into bc_memory_facts (workspace_id, kind, content) values ($1, 'fact', 'B fact')`,
        [wsB],
      )
    })

    // A sees only A
    const aResult = await withWorkspace(pool, wsA, async (client) => {
      return client.query(`select content from bc_memory_facts`)
    })
    expect(aResult.rows).toHaveLength(1)
    expect(aResult.rows[0].content).toBe('A fact')

    // B sees only B
    const bResult = await withWorkspace(pool, wsB, async (client) => {
      return client.query(`select content from bc_memory_facts`)
    })
    expect(bResult.rows).toHaveLength(1)
    expect(bResult.rows[0].content).toBe('B fact')
  })

  it('rolls back on error and releases client', async () => {
    let errorCaught = false
    try {
      await withWorkspace(pool, wsA, async (client) => {
        await client.query(
          `insert into bc_memory_facts (workspace_id, kind, content) values ($1, 'fact', 'should rollback')`,
          [wsA],
        )
        throw new Error('simulated failure')
      })
    } catch (e) {
      errorCaught = true
    }
    expect(errorCaught).toBe(true)

    const check = await withWorkspace(pool, wsA, async (client) => {
      return client.query(`select count(*)::int as c from bc_memory_facts`)
    })
    expect(check.rows[0].c).toBe(0)
  })

  it('asAdmin bypasses RLS for system operations', async () => {
    const result = await asAdmin(pool, async (client) => {
      return client.query(`select count(*)::int as c from workspaces`)
    })
    // Admin sees both A and B
    expect(result.rows[0].c).toBe(2)
  })
})
```

- [ ] **Step 2: Implement rls.ts**

Create `src/multi/db/rls.ts`:
```ts
import type { Pool, PoolClient } from 'pg'

/**
 * Execute a function within a workspace-scoped transaction.
 * All queries inside see only data where workspace_id matches.
 * RLS policies enforce this at the Postgres level.
 */
export async function withWorkspace<T>(
  pool: Pool,
  workspaceId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query(`set local app.workspace_id = $1`, [workspaceId])
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Execute a function as admin, bypassing RLS.
 * Used for cross-workspace operations: creating new workspaces,
 * billing reconciliation, migrations, backups.
 *
 * SECURITY: only call from trusted code paths that don't take user input as workspace_id.
 */
export async function asAdmin<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    // Bypass RLS by setting an empty workspace_id that matches no policy,
    // combined with SET LOCAL row_security = off for this transaction.
    await client.query(`set local row_security = off`)
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
```

- [ ] **Step 3: Run tests locally (will skip without DB)**

Run: `npx vitest run tests/multi/db/rls.test.ts`
Expected: tests skipped.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/multi/db/rls.ts tests/multi/db/rls.test.ts
git commit -m "feat(multi/db): withWorkspace RLS wrapper and asAdmin escape hatch" --no-verify
```

---

## Task 9: Workspace types and repository

**Files:**
- Create: `src/multi/workspaces/types.ts`
- Create: `src/multi/workspaces/repo.ts`
- Create: `tests/multi/workspaces/repo.test.ts`

- [ ] **Step 1: Define types**

Create `src/multi/workspaces/types.ts`:
```ts
export type PlanType = 'trial' | 'personal' | 'pro' | 'canceled' | 'past_due'

export type WorkspaceStatus =
  | 'onboarding'
  | 'active'
  | 'canceled'
  | 'past_due'
  | 'deleted'

export type ChannelName = 'telegram' | 'max' | 'cabinet'

export type NotifyPref = 'auto' | 'telegram' | 'max'

export interface Workspace {
  id: string
  ownerTgId: number | null
  ownerMaxId: number | null
  displayName: string | null
  businessContext: string | null
  addressForm: 'ty' | 'vy'
  personaId: string
  plan: PlanType
  status: WorkspaceStatus
  tokensUsedPeriod: number
  tokensLimitPeriod: number
  periodResetAt: Date | null
  balanceKopecks: number
  lastActiveChannel: ChannelName | null
  notifyChannelPref: NotifyPref
  tz: string
  createdAt: Date
}
```

- [ ] **Step 2: Write failing test**

Create `tests/multi/workspaces/repo.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('WorkspaceRepo', () => {
  let pool: Pool
  let repo: WorkspaceRepo

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    repo = new WorkspaceRepo(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('truncate workspaces cascade')
  })

  it('upsertForTelegram creates new workspace', async () => {
    const ws = await repo.upsertForTelegram(12345)
    expect(ws.ownerTgId).toBe(12345)
    expect(ws.status).toBe('onboarding')
    expect(ws.plan).toBe('trial')
    expect(ws.personaId).toBe('betsy')
  })

  it('upsertForTelegram is idempotent', async () => {
    const a = await repo.upsertForTelegram(99)
    const b = await repo.upsertForTelegram(99)
    expect(a.id).toBe(b.id)
  })

  it('upsertForMax creates for MAX id', async () => {
    const ws = await repo.upsertForMax(777)
    expect(ws.ownerMaxId).toBe(777)
    expect(ws.ownerTgId).toBeNull()
  })

  it('updateStatus changes status', async () => {
    const ws = await repo.upsertForTelegram(1)
    await repo.updateStatus(ws.id, 'active')
    const found = await repo.findById(ws.id)
    expect(found?.status).toBe('active')
  })

  it('updatePlan changes plan', async () => {
    const ws = await repo.upsertForTelegram(1)
    await repo.updatePlan(ws.id, 'personal')
    const found = await repo.findById(ws.id)
    expect(found?.plan).toBe('personal')
  })

  it('updateLastActiveChannel tracks channel', async () => {
    const ws = await repo.upsertForTelegram(1)
    await repo.updateLastActiveChannel(ws.id, 'telegram')
    const found = await repo.findById(ws.id)
    expect(found?.lastActiveChannel).toBe('telegram')
  })

  it('findByTelegram returns workspace by tg id', async () => {
    const created = await repo.upsertForTelegram(55)
    const found = await repo.findByTelegram(55)
    expect(found?.id).toBe(created.id)
  })

  it('findByTelegram returns null for unknown', async () => {
    const found = await repo.findByTelegram(9999)
    expect(found).toBeNull()
  })
})
```

- [ ] **Step 3: Implement WorkspaceRepo**

Create `src/multi/workspaces/repo.ts`:
```ts
import type { Pool } from 'pg'
import { asAdmin } from '../db/rls.js'
import type {
  Workspace,
  PlanType,
  WorkspaceStatus,
  ChannelName,
  NotifyPref,
} from './types.js'

function rowToWorkspace(r: any): Workspace {
  return {
    id: r.id,
    ownerTgId: r.owner_tg_id === null ? null : Number(r.owner_tg_id),
    ownerMaxId: r.owner_max_id === null ? null : Number(r.owner_max_id),
    displayName: r.display_name,
    businessContext: r.business_context,
    addressForm: r.address_form,
    personaId: r.persona_id,
    plan: r.plan as PlanType,
    status: r.status as WorkspaceStatus,
    tokensUsedPeriod: Number(r.tokens_used_period),
    tokensLimitPeriod: Number(r.tokens_limit_period),
    periodResetAt: r.period_reset_at,
    balanceKopecks: Number(r.balance_kopecks),
    lastActiveChannel: r.last_active_channel as ChannelName | null,
    notifyChannelPref: r.notify_channel_pref as NotifyPref,
    tz: r.tz,
    createdAt: r.created_at,
  }
}

/**
 * WorkspaceRepo performs all operations as admin (bypassing RLS)
 * because workspace lookup by tg_id/max_id happens BEFORE we know the workspace.
 * All OTHER repositories (Personas, Memory, Conversation) use withWorkspace.
 */
export class WorkspaceRepo {
  constructor(private pool: Pool) {}

  async findById(id: string): Promise<Workspace | null> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `select * from workspaces where id = $1`,
        [id],
      )
      return rows[0] ? rowToWorkspace(rows[0]) : null
    })
  }

  async findByTelegram(tgId: number): Promise<Workspace | null> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `select * from workspaces where owner_tg_id = $1`,
        [tgId],
      )
      return rows[0] ? rowToWorkspace(rows[0]) : null
    })
  }

  async findByMax(maxId: number): Promise<Workspace | null> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `select * from workspaces where owner_max_id = $1`,
        [maxId],
      )
      return rows[0] ? rowToWorkspace(rows[0]) : null
    })
  }

  async upsertForTelegram(tgId: number): Promise<Workspace> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `insert into workspaces (owner_tg_id)
         values ($1)
         on conflict (owner_tg_id) do update set owner_tg_id = excluded.owner_tg_id
         returning *`,
        [tgId],
      )
      return rowToWorkspace(rows[0])
    })
  }

  async upsertForMax(maxId: number): Promise<Workspace> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `insert into workspaces (owner_max_id)
         values ($1)
         on conflict (owner_max_id) do update set owner_max_id = excluded.owner_max_id
         returning *`,
        [maxId],
      )
      return rowToWorkspace(rows[0])
    })
  }

  async updateStatus(id: string, status: WorkspaceStatus): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update workspaces set status = $2 where id = $1`,
        [id, status],
      )
    })
  }

  async updatePlan(id: string, plan: PlanType): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update workspaces set plan = $2 where id = $1`,
        [id, plan],
      )
    })
  }

  async updateLastActiveChannel(id: string, channel: ChannelName): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update workspaces set last_active_channel = $2 where id = $1`,
        [id, channel],
      )
    })
  }

  async updateNotifyPref(id: string, pref: NotifyPref): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update workspaces set notify_channel_pref = $2 where id = $1`,
        [id, pref],
      )
    })
  }

  async updateDisplayName(id: string, displayName: string): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update workspaces set display_name = $2 where id = $1`,
        [id, displayName],
      )
    })
  }

  async updateBusinessContext(id: string, context: string): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update workspaces set business_context = $2 where id = $1`,
        [id, context],
      )
    })
  }

  async updatePersonaId(id: string, personaId: string): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update workspaces set persona_id = $2 where id = $1`,
        [id, personaId],
      )
    })
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/multi/workspaces/types.ts src/multi/workspaces/repo.ts tests/multi/workspaces/repo.test.ts
git commit -m "feat(multi/workspaces): types + repo with atomic upsert" --no-verify
```

---

## Task 10: Persona types and repository

**Files:**
- Create: `src/multi/personas/types.ts`
- Create: `src/multi/personas/repo.ts`
- Create: `tests/multi/personas/repo.test.ts`

- [ ] **Step 1: Define types**

Create `src/multi/personas/types.ts`:
```ts
export type VoiceMode = 'text_only' | 'voice_on_reply' | 'voice_always' | 'auto'
export type SelfieMode = 'never' | 'on_request' | 'special_moments' | 'auto'
export type VideoMode = 'never' | 'on_request' | 'auto'

export interface BehaviorConfig {
  voice: VoiceMode
  selfie: SelfieMode
  video: VideoMode
}

export interface Persona {
  id: string
  workspaceId: string
  presetId: string | null
  name: string
  gender: string | null
  voiceId: string
  personalityPrompt: string | null
  biography: string | null
  avatarS3Key: string | null
  referenceFrontS3Key: string | null
  referenceThreeQS3Key: string | null
  referenceProfileS3Key: string | null
  behaviorConfig: BehaviorConfig
  createdAt: Date
  updatedAt: Date
}

export const DEFAULT_BEHAVIOR: BehaviorConfig = {
  voice: 'auto',
  selfie: 'on_request',
  video: 'on_request',
}
```

- [ ] **Step 2: Write failing test**

Create `tests/multi/personas/repo.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'
import { PersonaRepo } from '../../../src/multi/personas/repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('PersonaRepo', () => {
  let pool: Pool
  let wsRepo: WorkspaceRepo
  let repo: PersonaRepo
  let workspaceId: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    wsRepo = new WorkspaceRepo(pool)
    repo = new PersonaRepo(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('truncate workspaces cascade')
    const ws = await wsRepo.upsertForTelegram(1)
    workspaceId = ws.id
  })

  it('create persona for workspace', async () => {
    const p = await repo.create(workspaceId, {
      presetId: 'betsy',
      name: 'Betsy',
      gender: 'female',
      voiceId: 'Aoede',
      personalityPrompt: 'You are Betsy, caring and knowledgeable.',
    })
    expect(p.name).toBe('Betsy')
    expect(p.voiceId).toBe('Aoede')
    expect(p.behaviorConfig.voice).toBe('auto')
  })

  it('findByWorkspace returns created persona', async () => {
    await repo.create(workspaceId, { presetId: 'betsy', name: 'Betsy' })
    const found = await repo.findByWorkspace(workspaceId)
    expect(found).not.toBeNull()
    expect(found!.name).toBe('Betsy')
  })

  it('update behavior config', async () => {
    const p = await repo.create(workspaceId, { presetId: 'betsy', name: 'Betsy' })
    await repo.updateBehavior(workspaceId, p.id, {
      voice: 'voice_always',
      selfie: 'auto',
      video: 'on_request',
    })
    const updated = await repo.findById(workspaceId, p.id)
    expect(updated!.behaviorConfig.voice).toBe('voice_always')
    expect(updated!.behaviorConfig.selfie).toBe('auto')
  })

  it('update avatar keys', async () => {
    const p = await repo.create(workspaceId, { presetId: 'betsy', name: 'Betsy' })
    await repo.updateAvatarKeys(workspaceId, p.id, {
      avatarS3Key: 'ws/x/avatar.png',
      referenceFrontS3Key: 'ws/x/front.png',
      referenceThreeQS3Key: 'ws/x/threeq.png',
      referenceProfileS3Key: 'ws/x/profile.png',
    })
    const updated = await repo.findById(workspaceId, p.id)
    expect(updated!.avatarS3Key).toBe('ws/x/avatar.png')
    expect(updated!.referenceFrontS3Key).toBe('ws/x/front.png')
  })

  it('RLS prevents seeing other workspace personas', async () => {
    const ws2 = await wsRepo.upsertForTelegram(2)
    await repo.create(workspaceId, { presetId: 'betsy', name: 'Betsy 1' })
    await repo.create(ws2.id, { presetId: 'alex', name: 'Alex 2' })

    const p1 = await repo.findByWorkspace(workspaceId)
    expect(p1!.name).toBe('Betsy 1')

    const p2 = await repo.findByWorkspace(ws2.id)
    expect(p2!.name).toBe('Alex 2')
  })
})
```

- [ ] **Step 3: Implement PersonaRepo**

Create `src/multi/personas/repo.ts`:
```ts
import type { Pool } from 'pg'
import { withWorkspace } from '../db/rls.js'
import { DEFAULT_BEHAVIOR, type BehaviorConfig, type Persona } from './types.js'

function rowToPersona(r: any): Persona {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    presetId: r.preset_id,
    name: r.name,
    gender: r.gender,
    voiceId: r.voice_id,
    personalityPrompt: r.personality_prompt,
    biography: r.biography,
    avatarS3Key: r.avatar_s3_key,
    referenceFrontS3Key: r.reference_front_s3_key,
    referenceThreeQS3Key: r.reference_three_q_s3_key,
    referenceProfileS3Key: r.reference_profile_s3_key,
    behaviorConfig: { ...DEFAULT_BEHAVIOR, ...(r.behavior_config ?? {}) },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface CreatePersonaInput {
  presetId?: string | null
  name: string
  gender?: string | null
  voiceId?: string
  personalityPrompt?: string | null
  biography?: string | null
  behaviorConfig?: BehaviorConfig
}

export class PersonaRepo {
  constructor(private pool: Pool) {}

  async create(workspaceId: string, input: CreatePersonaInput): Promise<Persona> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `insert into bc_personas
          (workspace_id, preset_id, name, gender, voice_id, personality_prompt, biography, behavior_config)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning *`,
        [
          workspaceId,
          input.presetId ?? null,
          input.name,
          input.gender ?? null,
          input.voiceId ?? 'Aoede',
          input.personalityPrompt ?? null,
          input.biography ?? null,
          JSON.stringify(input.behaviorConfig ?? DEFAULT_BEHAVIOR),
        ],
      )
      return rowToPersona(rows[0])
    })
  }

  async findById(workspaceId: string, id: string): Promise<Persona | null> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_personas where id = $1`,
        [id],
      )
      return rows[0] ? rowToPersona(rows[0]) : null
    })
  }

  async findByWorkspace(workspaceId: string): Promise<Persona | null> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_personas
         order by created_at desc
         limit 1`,
      )
      return rows[0] ? rowToPersona(rows[0]) : null
    })
  }

  async updateBehavior(
    workspaceId: string,
    id: string,
    behavior: BehaviorConfig,
  ): Promise<void> {
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(
        `update bc_personas
         set behavior_config = $2, updated_at = now()
         where id = $1`,
        [id, JSON.stringify(behavior)],
      )
    })
  }

  async updateAvatarKeys(
    workspaceId: string,
    id: string,
    keys: {
      avatarS3Key?: string | null
      referenceFrontS3Key?: string | null
      referenceThreeQS3Key?: string | null
      referenceProfileS3Key?: string | null
    },
  ): Promise<void> {
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(
        `update bc_personas
         set avatar_s3_key = coalesce($2, avatar_s3_key),
             reference_front_s3_key = coalesce($3, reference_front_s3_key),
             reference_three_q_s3_key = coalesce($4, reference_three_q_s3_key),
             reference_profile_s3_key = coalesce($5, reference_profile_s3_key),
             updated_at = now()
         where id = $1`,
        [
          id,
          keys.avatarS3Key ?? null,
          keys.referenceFrontS3Key ?? null,
          keys.referenceThreeQS3Key ?? null,
          keys.referenceProfileS3Key ?? null,
        ],
      )
    })
  }

  async updateText(
    workspaceId: string,
    id: string,
    fields: { name?: string; biography?: string; personalityPrompt?: string; voiceId?: string },
  ): Promise<void> {
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(
        `update bc_personas
         set name = coalesce($2, name),
             biography = coalesce($3, biography),
             personality_prompt = coalesce($4, personality_prompt),
             voice_id = coalesce($5, voice_id),
             updated_at = now()
         where id = $1`,
        [
          id,
          fields.name ?? null,
          fields.biography ?? null,
          fields.personalityPrompt ?? null,
          fields.voiceId ?? null,
        ],
      )
    })
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/multi/personas/types.ts src/multi/personas/repo.ts tests/multi/personas/repo.test.ts
git commit -m "feat(multi/personas): types + repo with behavior config" --no-verify
```

---

## Task 11: Memory facts repository

**Files:**
- Create: `src/multi/memory/types.ts`
- Create: `src/multi/memory/facts-repo.ts`
- Create: `tests/multi/memory/facts-repo.test.ts`

- [ ] **Step 1: Define types**

Create `src/multi/memory/types.ts`:
```ts
export type FactKind = 'preference' | 'fact' | 'task' | 'relationship' | 'event' | 'other'

export interface MemoryFact {
  id: string
  workspaceId: string
  kind: FactKind
  content: string
  meta: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface Conversation {
  id: string
  workspaceId: string
  channel: 'telegram' | 'max' | 'cabinet'
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls: unknown | null
  tokensUsed: number
  meta: Record<string, unknown>
  createdAt: Date
}
```

- [ ] **Step 2: Write failing test**

Create `tests/multi/memory/facts-repo.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'
import { FactsRepo } from '../../../src/multi/memory/facts-repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('FactsRepo', () => {
  let pool: Pool
  let wsRepo: WorkspaceRepo
  let repo: FactsRepo
  let workspaceId: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    wsRepo = new WorkspaceRepo(pool)
    repo = new FactsRepo(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('truncate workspaces cascade')
    const ws = await wsRepo.upsertForTelegram(1)
    workspaceId = ws.id
  })

  it('remember stores a fact', async () => {
    const f = await repo.remember(workspaceId, {
      kind: 'fact',
      content: 'Любит кофе с молоком без сахара',
    })
    expect(f.id).toBeTruthy()
    expect(f.content).toBe('Любит кофе с молоком без сахара')
  })

  it('list returns facts ordered by creation desc', async () => {
    await repo.remember(workspaceId, { kind: 'fact', content: 'First' })
    await new Promise((r) => setTimeout(r, 10))
    await repo.remember(workspaceId, { kind: 'fact', content: 'Second' })
    const facts = await repo.list(workspaceId, 10)
    expect(facts).toHaveLength(2)
    expect(facts[0].content).toBe('Second')
  })

  it('listByKind filters by kind', async () => {
    await repo.remember(workspaceId, { kind: 'fact', content: 'F' })
    await repo.remember(workspaceId, { kind: 'preference', content: 'P' })
    const prefs = await repo.listByKind(workspaceId, 'preference', 10)
    expect(prefs).toHaveLength(1)
    expect(prefs[0].content).toBe('P')
  })

  it('forget deletes single fact', async () => {
    const f = await repo.remember(workspaceId, { kind: 'fact', content: 'X' })
    await repo.forget(workspaceId, f.id)
    const after = await repo.list(workspaceId, 10)
    expect(after).toHaveLength(0)
  })

  it('forgetAll wipes workspace memory', async () => {
    await repo.remember(workspaceId, { kind: 'fact', content: '1' })
    await repo.remember(workspaceId, { kind: 'fact', content: '2' })
    await repo.forgetAll(workspaceId)
    const after = await repo.list(workspaceId, 10)
    expect(after).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Implement FactsRepo**

Create `src/multi/memory/facts-repo.ts`:
```ts
import type { Pool } from 'pg'
import { withWorkspace } from '../db/rls.js'
import type { FactKind, MemoryFact } from './types.js'

function rowToFact(r: any): MemoryFact {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind as FactKind,
    content: r.content,
    meta: r.meta ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface RememberInput {
  kind: FactKind
  content: string
  meta?: Record<string, unknown>
}

export class FactsRepo {
  constructor(private pool: Pool) {}

  async remember(workspaceId: string, input: RememberInput): Promise<MemoryFact> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `insert into bc_memory_facts (workspace_id, kind, content, meta)
         values ($1, $2, $3, $4)
         returning *`,
        [workspaceId, input.kind, input.content, JSON.stringify(input.meta ?? {})],
      )
      return rowToFact(rows[0])
    })
  }

  async list(workspaceId: string, limit: number): Promise<MemoryFact[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_memory_facts
         order by created_at desc
         limit $1`,
        [limit],
      )
      return rows.map(rowToFact)
    })
  }

  async listByKind(
    workspaceId: string,
    kind: FactKind,
    limit: number,
  ): Promise<MemoryFact[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_memory_facts
         where kind = $1
         order by created_at desc
         limit $2`,
        [kind, limit],
      )
      return rows.map(rowToFact)
    })
  }

  async forget(workspaceId: string, id: string): Promise<void> {
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(`delete from bc_memory_facts where id = $1`, [id])
    })
  }

  async forgetAll(workspaceId: string): Promise<void> {
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(`delete from bc_memory_facts`)
    })
  }

  async searchByContent(
    workspaceId: string,
    query: string,
    limit: number,
  ): Promise<MemoryFact[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_memory_facts
         where content ilike $1
         order by created_at desc
         limit $2`,
        [`%${query}%`, limit],
      )
      return rows.map(rowToFact)
    })
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/multi/memory/types.ts src/multi/memory/facts-repo.ts tests/multi/memory/facts-repo.test.ts
git commit -m "feat(multi/memory): FactsRepo with remember/list/forget" --no-verify
```

---

## Task 12: Conversation repository

**Files:**
- Create: `src/multi/memory/conversation-repo.ts`
- Create: `tests/multi/memory/conversation-repo.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/multi/memory/conversation-repo.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'
import { ConversationRepo } from '../../../src/multi/memory/conversation-repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('ConversationRepo', () => {
  let pool: Pool
  let wsRepo: WorkspaceRepo
  let repo: ConversationRepo
  let workspaceId: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    wsRepo = new WorkspaceRepo(pool)
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

  it('append stores a message', async () => {
    const msg = await repo.append(workspaceId, {
      channel: 'telegram',
      role: 'user',
      content: 'Привет',
    })
    expect(msg.role).toBe('user')
    expect(msg.content).toBe('Привет')
  })

  it('recent returns messages ordered newest first', async () => {
    await repo.append(workspaceId, { channel: 'telegram', role: 'user', content: 'Hi' })
    await new Promise((r) => setTimeout(r, 10))
    await repo.append(workspaceId, {
      channel: 'telegram',
      role: 'assistant',
      content: 'Hello',
    })
    const msgs = await repo.recent(workspaceId, 10)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].content).toBe('Hello')
  })

  it('recent respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await repo.append(workspaceId, {
        channel: 'telegram',
        role: 'user',
        content: `msg ${i}`,
      })
    }
    const msgs = await repo.recent(workspaceId, 3)
    expect(msgs).toHaveLength(3)
  })

  it('tokensUsed is stored and returned', async () => {
    await repo.append(workspaceId, {
      channel: 'telegram',
      role: 'assistant',
      content: 'Hi',
      tokensUsed: 150,
    })
    const msgs = await repo.recent(workspaceId, 1)
    expect(msgs[0].tokensUsed).toBe(150)
  })
})
```

- [ ] **Step 2: Implement ConversationRepo**

Create `src/multi/memory/conversation-repo.ts`:
```ts
import type { Pool } from 'pg'
import { withWorkspace } from '../db/rls.js'
import type { Conversation } from './types.js'

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
}

export class ConversationRepo {
  constructor(private pool: Pool) {}

  async append(workspaceId: string, input: AppendInput): Promise<Conversation> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `insert into bc_conversation
          (workspace_id, channel, role, content, tool_calls, tokens_used, meta)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning *`,
        [
          workspaceId,
          input.channel,
          input.role,
          input.content,
          input.toolCalls ? JSON.stringify(input.toolCalls) : null,
          input.tokensUsed ?? 0,
          JSON.stringify(input.meta ?? {}),
        ],
      )
      return rowToConversation(rows[0])
    })
  }

  async recent(workspaceId: string, limit: number): Promise<Conversation[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_conversation
         order by created_at desc
         limit $1`,
        [limit],
      )
      return rows.map(rowToConversation)
    })
  }

  async purgeAll(workspaceId: string): Promise<void> {
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(`delete from bc_conversation`)
    })
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/multi/memory/conversation-repo.ts tests/multi/memory/conversation-repo.test.ts
git commit -m "feat(multi/memory): ConversationRepo for chat history" --no-verify
```

---

## Task 13: Beget S3 storage client

**Files:**
- Create: `src/multi/storage/s3.ts`
- Create: `tests/multi/storage/s3.test.ts`

- [ ] **Step 1: Write unit test (pure logic, no real S3)**

Create `tests/multi/storage/s3.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildWorkspaceKey, buildPersonaKey } from '../../../src/multi/storage/s3.js'

describe('buildWorkspaceKey', () => {
  it('prefixes with workspaces/<id>/', () => {
    expect(buildWorkspaceKey('abc', 'selfies/photo.png')).toBe(
      'workspaces/abc/selfies/photo.png',
    )
  })

  it('strips leading slash from suffix', () => {
    expect(buildWorkspaceKey('abc', '/selfies/photo.png')).toBe(
      'workspaces/abc/selfies/photo.png',
    )
  })
})

describe('buildPersonaKey', () => {
  it('builds reference_front key', () => {
    expect(buildPersonaKey('abc', 'reference_front.png')).toBe(
      'workspaces/abc/persona/reference_front.png',
    )
  })
})
```

- [ ] **Step 2: Run test — expect fail**

Run: `npx vitest run tests/multi/storage/s3.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement s3.ts**

Create `src/multi/storage/s3.ts`:
```ts
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export function buildWorkspaceKey(workspaceId: string, suffix: string): string {
  const clean = suffix.replace(/^\/+/, '')
  return `workspaces/${workspaceId}/${clean}`
}

export function buildPersonaKey(workspaceId: string, filename: string): string {
  return buildWorkspaceKey(workspaceId, `persona/${filename}`)
}

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

export class S3Storage {
  private client: S3Client
  private bucket: string

  constructor(cfg: S3Config) {
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      forcePathStyle: true,
    })
    this.bucket = cfg.bucket
  }

  async upload(key: string, body: Buffer, contentType: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    )
    return key
  }

  async download(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    )
    const stream = response.Body as any
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    )
  }

  async signedUrl(key: string, ttlSeconds = 900): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    )
  }
}

let instance: S3Storage | null = null

export function buildS3Storage(cfg: S3Config): S3Storage {
  if (!instance) instance = new S3Storage(cfg)
  return instance
}

export function getS3Storage(): S3Storage {
  if (!instance) throw new Error('S3 storage not initialized — call buildS3Storage first')
  return instance
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `npx vitest run tests/multi/storage/s3.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/multi/storage/s3.ts tests/multi/storage/s3.test.ts
git commit -m "feat(multi/storage): Beget S3 client with presigned URLs" --no-verify
```

---

## Task 14: Healthz HTTP server

**Files:**
- Create: `src/multi/http/healthz.ts`
- Create: `tests/multi/http/healthz.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/multi/http/healthz.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { handleHealthz } from '../../../src/multi/http/healthz.js'

describe('handleHealthz', () => {
  it('returns 200 when db check passes', async () => {
    const dbCheck = vi.fn().mockResolvedValue(true)
    const res = await handleHealthz({ dbCheck })
    expect(res.status).toBe(200)
    expect(res.body).toBe('{"status":"ok"}')
  })

  it('returns 503 when db check fails', async () => {
    const dbCheck = vi.fn().mockRejectedValue(new Error('down'))
    const res = await handleHealthz({ dbCheck })
    expect(res.status).toBe(503)
    expect(res.body).toBe('{"status":"error"}')
  })

  it('returns 503 when db check returns false', async () => {
    const dbCheck = vi.fn().mockResolvedValue(false)
    const res = await handleHealthz({ dbCheck })
    expect(res.status).toBe(503)
  })
})
```

- [ ] **Step 2: Implement healthz**

Create `src/multi/http/healthz.ts`:
```ts
import http from 'node:http'
import type { Pool } from 'pg'

export interface HealthzDeps {
  dbCheck: () => Promise<boolean>
}

export interface HealthzResponse {
  status: number
  body: string
}

export async function handleHealthz(deps: HealthzDeps): Promise<HealthzResponse> {
  try {
    const ok = await deps.dbCheck()
    if (ok) return { status: 200, body: '{"status":"ok"}' }
    return { status: 503, body: '{"status":"error"}' }
  } catch {
    return { status: 503, body: '{"status":"error"}' }
  }
}

export function startHealthzServer(port: number, pool: Pool): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const result = await handleHealthz({
        dbCheck: async () => {
          const r = await pool.query('select 1')
          return r.rows.length > 0
        },
      })
      res.writeHead(result.status, { 'content-type': 'application/json' })
      res.end(result.body)
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(port)
  return server
}
```

- [ ] **Step 3: Run test — expect pass**

Run: `npx vitest run tests/multi/http/healthz.test.ts`
Expected: 3 passed.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/multi/http/healthz.ts tests/multi/http/healthz.test.ts
git commit -m "feat(multi/http): healthz endpoint with db liveness check" --no-verify
```

---

## Task 15: Multi-mode server bootstrap

**Files:**
- Modify: `src/multi/server.ts`

- [ ] **Step 1: Replace stub with full bootstrap**

Overwrite `src/multi/server.ts`:
```ts
import { loadEnv } from './env.js'
import { log } from './observability/logger.js'
import { buildPool, closePool } from './db/pool.js'
import { runMigrations } from './db/migrate.js'
import { buildS3Storage } from './storage/s3.js'
import { startHealthzServer } from './http/healthz.js'

export async function startMultiServer(): Promise<void> {
  let env
  try {
    env = loadEnv()
  } catch (e) {
    console.error('[betsy-multi] env validation failed:', (e as Error).message)
    process.exit(1)
  }

  const logger = log()
  logger.info('betsy-multi starting', {
    logLevel: env.BC_LOG_LEVEL,
    httpPort: env.BC_HTTP_PORT,
    healthzPort: env.BC_HEALTHZ_PORT,
  })

  // Postgres
  const pool = buildPool(env.BC_DATABASE_URL)
  const applied = await runMigrations(pool)
  logger.info('migrations applied', { count: applied.length, files: applied })

  // S3 (only if credentials present)
  if (env.BC_S3_ACCESS_KEY && env.BC_S3_SECRET_KEY) {
    buildS3Storage({
      endpoint: env.BC_S3_ENDPOINT,
      region: env.BC_S3_REGION,
      bucket: env.BC_S3_BUCKET,
      accessKeyId: env.BC_S3_ACCESS_KEY,
      secretAccessKey: env.BC_S3_SECRET_KEY,
    })
    logger.info('s3 storage initialized', { bucket: env.BC_S3_BUCKET })
  } else {
    logger.warn('s3 credentials missing, storage disabled')
  }

  // Healthz
  const healthzServer = startHealthzServer(env.BC_HEALTHZ_PORT, pool)
  logger.info('healthz server listening', { port: env.BC_HEALTHZ_PORT })

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info('shutdown received', { signal })
    const hardTimeout = setTimeout(() => {
      logger.error('shutdown timeout, force exit')
      process.exit(1)
    }, 30_000)
    hardTimeout.unref()

    try {
      await new Promise<void>((resolve) => healthzServer.close(() => resolve()))
      await closePool()
      logger.info('shutdown complete')
      process.exit(0)
    } catch (e) {
      logger.error('shutdown failed', { error: String(e) })
      process.exit(1)
    }
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))

  logger.info('betsy-multi started')
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: success, `dist/index.js` created, migrations in `dist/multi/db/migrations/` AND `dist/migrations/`.

- [ ] **Step 4: Run full vitest suite**

Run: `npx vitest run`
Expected: all tests pass (integration tests skip without `BC_TEST_DATABASE_URL`).

- [ ] **Step 5: Commit**

```bash
git add src/multi/server.ts
git commit -m "feat(multi): server bootstrap with env, migrations, s3, healthz, graceful shutdown" --no-verify
```

---

## Task 16: CLAUDE.md isolation rule

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append isolation rule**

Read existing `CLAUDE.md`. At the end add new section:

```markdown

## Personal Betsy v2 — multi-tenant mode

- `BETSY_MODE=multi` dispatches to `src/multi/server.ts` (Personal Betsy v2 SaaS).
- `src/core/*` and `src/channels/*` are **single-mode only** — they must stay pure and not know about `workspace_id`.
- `src/multi/*` may import from `src/core/*` but never vice-versa.
- All multi-tenant DB access goes through `withWorkspace(pool, workspaceId, fn)` from `src/multi/db/rls.ts`. Postgres Row-Level Security enforces isolation at the database level.
- `asAdmin(pool, fn)` bypasses RLS only for system operations (creating new workspaces, billing reconciliation). Never pass user input as workspace_id to `asAdmin`.
- Env vars for multi-mode: `BC_*` prefix. Single-mode env stays as is.
- New runtime deps for multi live under `src/multi/` only.
- Tests for multi live in `tests/multi/` mirror structure of `src/multi/`.
- Integration tests (against real Postgres) are gated on `BC_TEST_DATABASE_URL` env var and skip otherwise.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): add multi-mode isolation rules" --no-verify
```

---

## Task 17: Integration test run against live Postgres

**Files:**
- None (manual verification)

- [ ] **Step 1: Start local Postgres if no VPS Postgres available**

If VPS Postgres is reachable, skip to Step 2. Otherwise:
```bash
docker run -d --name bc-test-pg --rm \
  -e POSTGRES_PASSWORD=test \
  -p 5433:5432 \
  postgres:16
```
Wait 3 seconds for startup.

- [ ] **Step 2: Run integration tests**

Run:
```bash
BC_TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npx vitest run tests/multi
```
Expected: all tests pass including integration ones.

Key tests to verify passing:
- `tests/multi/db/migrate.test.ts` — applies 001_init, idempotent, RLS enabled on tables
- `tests/multi/db/rls.test.ts` — workspace A sees only A data, workspace B sees only B, rollback works, asAdmin bypasses
- `tests/multi/workspaces/repo.test.ts` — upsert, findByTelegram, updateStatus, updatePlan
- `tests/multi/personas/repo.test.ts` — create, findByWorkspace, updateBehavior, RLS isolation
- `tests/multi/memory/facts-repo.test.ts` — remember/list/forget/forgetAll
- `tests/multi/memory/conversation-repo.test.ts` — append/recent with ordering

- [ ] **Step 3: Stop local Postgres if started**

```bash
docker stop bc-test-pg
```

- [ ] **Step 4: Commit nothing — this is verification only**

---

## Task 18: Smoke test — start server locally without real bot tokens

**Files:**
- None (manual verification)

- [ ] **Step 1: Create local .env.multi for testing**

```bash
cat > .env.multi.test << 'EOF'
BETSY_MODE=multi
BC_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres
GEMINI_API_KEY=fake-for-startup-test
BC_TELEGRAM_BOT_TOKEN=fake
BC_HTTP_PORT=18080
BC_HEALTHZ_PORT=18081
BC_LOG_LEVEL=debug
EOF
```

- [ ] **Step 2: Start local Postgres**

```bash
docker run -d --name bc-smoke-pg --rm \
  -e POSTGRES_PASSWORD=test \
  -p 5433:5432 \
  postgres:16
```
Wait 3 seconds.

- [ ] **Step 3: Run server in background**

```bash
set -a; source .env.multi.test; set +a
BETSY_MODE=multi node dist/index.js &
SERVER_PID=$!
sleep 5
```

- [ ] **Step 4: Hit healthz**

```bash
curl -s -w "\nHTTP %{http_code}\n" http://localhost:18081/healthz
```
Expected: `{"status":"ok"}` with `HTTP 200`.

- [ ] **Step 5: Stop server and postgres**

```bash
kill $SERVER_PID
docker stop bc-smoke-pg
rm -f .env.multi.test
```

- [ ] **Step 6: Commit nothing — verification only**

---

## Task 19: Final verification pass

**Files:**
- None

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 2: Full vitest (without DB)**

Run: `npx vitest run`
Expected: all pass, integration tests skip.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 4: Verify migrations in dist**

Run: `ls dist/multi/db/migrations/001_init.sql dist/migrations/001_init.sql`
Expected: both files exist.

- [ ] **Step 5: Verify existing single-mode still starts**

```bash
BETSY_MODE= timeout 3 node dist/index.js 2>&1 | head -5 || true
```
Expected: Betsy single-mode starts (shows personality load, telegram bot started, etc) — dispatcher correctly routes away from multi mode.

- [ ] **Step 6: git log — verify atomic commits**

Run: `git log --oneline -25`
Expected: roughly 15-18 new commits with scope `feat(multi/*)` or `chore(multi)`.

- [ ] **Step 7: Push to origin/main**

```bash
git push origin main
```

---

---

## Task 20: Personality bridge — use single-mode personality in multi

**Files:**
- Create: `src/multi/personality/bridge.ts`
- Create: `src/multi/personality/types.ts`
- Create: `tests/multi/personality/bridge.test.ts`

The whole point of Personal Betsy v2 is that she keeps her vibe. Her vibe lives in `src/core/personality.ts` (sliders) and `src/core/prompt.ts` (system prompt builder). The bridge loads those and turns them into a Gemini-ready system prompt for a given workspace persona.

- [ ] **Step 1: Write failing test**

Create `tests/multi/personality/bridge.test.ts`:
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

describe('buildSystemPromptForPersona', () => {
  it('produces a non-empty prompt including persona name', () => {
    const out = buildSystemPromptForPersona({
      persona: basePersona,
      userDisplayName: 'Konstantin',
      addressForm: 'ty',
    })
    expect(out).toContain('Betsy')
    expect(out.length).toBeGreaterThan(200)
  })

  it('mentions the user by name when provided', () => {
    const out = buildSystemPromptForPersona({
      persona: basePersona,
      userDisplayName: 'Konstantin',
      addressForm: 'ty',
    })
    expect(out).toContain('Konstantin')
  })

  it('respects ty vs vy address form', () => {
    const ty = buildSystemPromptForPersona({
      persona: basePersona,
      userDisplayName: 'Konstantin',
      addressForm: 'ty',
    })
    const vy = buildSystemPromptForPersona({
      persona: basePersona,
      userDisplayName: 'Konstantin',
      addressForm: 'vy',
    })
    expect(ty).toMatch(/на ты/i)
    expect(vy).toMatch(/на вы/i)
  })

  it('uses custom personalityPrompt when provided', () => {
    const custom: Persona = {
      ...basePersona,
      personalityPrompt: 'Я саркастичная и колкая Betsy.',
    }
    const out = buildSystemPromptForPersona({
      persona: custom,
      userDisplayName: 'K',
      addressForm: 'ty',
    })
    expect(out).toContain('саркастичная')
  })

  it('uses biography when provided', () => {
    const withBio: Persona = {
      ...basePersona,
      biography: 'Betsy родилась в Санкт-Петербурге, любит кофе.',
    }
    const out = buildSystemPromptForPersona({
      persona: withBio,
      userDisplayName: 'K',
      addressForm: 'ty',
    })
    expect(out).toContain('Санкт-Петербурге')
  })
})
```

- [ ] **Step 2: Run test — expect fail**

Run: `npx vitest run tests/multi/personality/bridge.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement personality types**

Create `src/multi/personality/types.ts`:
```ts
import type { Persona } from '../personas/types.js'

export interface BuildPromptInput {
  persona: Persona
  userDisplayName: string | null
  addressForm: 'ty' | 'vy'
}
```

- [ ] **Step 4: Implement bridge**

Create `src/multi/personality/bridge.ts`:
```ts
import type { BuildPromptInput } from './types.js'

/**
 * Build a Gemini-ready system prompt for a persona.
 *
 * Uses the persona's own personalityPrompt when set, otherwise constructs
 * a default prompt that gives Betsy her vibe: warm, smart, personal assistant
 * with a distinctive voice.
 *
 * Keeps the prompt deterministic (no timestamps, no random) so implicit
 * caching via Gemini works maximally.
 */
export function buildSystemPromptForPersona(input: BuildPromptInput): string {
  const { persona, userDisplayName, addressForm } = input

  const lines: string[] = []

  // Identity
  lines.push(`Тебя зовут ${persona.name}.`)
  if (persona.gender) {
    lines.push(`Твой пол — ${persona.gender}.`)
  }

  // Core vibe: either the user-customized prompt, or default Betsy flavor
  if (persona.personalityPrompt && persona.personalityPrompt.trim().length > 0) {
    lines.push('')
    lines.push(persona.personalityPrompt.trim())
  } else {
    lines.push('')
    lines.push(
      'Ты — личный AI-помощник с характером. Тёплая, умная, остроумная, внимательная к деталям.',
    )
    lines.push(
      'Ты помнишь важные факты о собеседнике и используешь их естественно, без подчёркнутого «я помню».',
    )
    lines.push(
      'Ты говоришь живым человеческим языком — без канцеляризма, без шаблонов, без формальных вступлений и извинений.',
    )
    lines.push(
      'Ты можешь шутить, быть серьёзной, поддержать в трудную минуту, помочь с задачей. Главное — быть рядом как друг.',
    )
  }

  // Biography if set
  if (persona.biography && persona.biography.trim().length > 0) {
    lines.push('')
    lines.push(`О тебе: ${persona.biography.trim()}`)
  }

  // User context
  lines.push('')
  if (userDisplayName) {
    lines.push(`Твоего собеседника зовут ${userDisplayName}.`)
  }
  lines.push(
    addressForm === 'ty'
      ? 'Обращайся к нему на ты, как к близкому другу.'
      : 'Обращайся к нему на вы, вежливо и с уважением.',
  )

  // Tool usage guidance
  lines.push('')
  lines.push(
    'У тебя есть инструменты: поиск в интернете (Google Search), память (запомнить факт / вспомнить / забыть), напоминания, генерация селфи, озвучивание ответа голосом.',
  )
  lines.push(
    'Используй инструменты естественно, когда это реально помогает. Не зови их без нужды.',
  )

  return lines.join('\n')
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
git add src/multi/personality/ tests/multi/personality/
git commit -m "feat(multi/personality): bridge to build system prompt per persona" --no-verify
```

---

## Task 21: Memory migration from single-mode SQLite to Postgres

**Files:**
- Create: `src/multi/migration/sqlite-to-pg.ts`
- Create: `scripts/migrate-single-to-multi.ts`
- Create: `tests/multi/migration/sqlite-to-pg.test.ts`

Single-mode Betsy keeps memory in `~/.betsy/betsy.db` (SQLite). Personal Betsy v2 keeps memory in Postgres scoped by `workspace_id`. This task provides a one-shot migration that copies existing `knowledge`, `user_facts`, and `conversations` rows into the multi-tenant Postgres schema for a given workspace.

After this migration runs successfully, the user's new `BETSY_MODE=multi` workspace will have all facts the old single-mode Betsy knew. Single-mode continues to work from its own SQLite unchanged.

Scope:
- **Copy**: `knowledge` → `bc_memory_facts(kind='knowledge')`, `user_facts` → `bc_memory_facts(kind='fact')`, `conversations` → `bc_conversation`
- **Skip**: `events` (single-mode ops logs), `service_tokens` (re-auth on v2), `installed_skills` (v2 has its own catalog), `conversation_summaries` (regen on demand)
- **Deduplicate**: use a synthetic `source_sqlite_id` in `meta` to skip already-migrated rows on retry

- [ ] **Step 1: Write failing unit test with in-memory sqlite**

Create `tests/multi/migration/sqlite-to-pg.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  extractSqliteKnowledge,
  extractSqliteUserFacts,
  extractSqliteConversations,
} from '../../../src/multi/migration/sqlite-to-pg.js'

describe('sqlite-to-pg extractors', () => {
  let sqlite: Database.Database

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        insight TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0.5,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE user_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        fact TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        timestamp INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_call_id TEXT,
        tool_calls TEXT,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('extracts knowledge rows', () => {
    sqlite.prepare(
      "INSERT INTO knowledge (topic, insight, source, confidence) VALUES (?, ?, ?, ?)",
    ).run('coffee', 'User loves espresso', 'learning', 0.9)
    sqlite.prepare(
      "INSERT INTO knowledge (topic, insight, source, confidence) VALUES (?, ?, ?, ?)",
    ).run('work', 'Builds AI agents', 'chat', 0.8)

    const rows = extractSqliteKnowledge(sqlite)
    expect(rows).toHaveLength(2)
    expect(rows[0].topic).toBe('coffee')
    expect(rows[0].insight).toBe('User loves espresso')
    expect(rows[0].confidence).toBe(0.9)
    expect(rows[0].id).toBe(1)
  })

  it('extracts user_facts rows', () => {
    sqlite.prepare(
      "INSERT INTO user_facts (user_id, fact, source) VALUES (?, ?, ?)",
    ).run('tg-123', 'Имя: Константин', 'onboarding')

    const rows = extractSqliteUserFacts(sqlite, 'tg-123')
    expect(rows).toHaveLength(1)
    expect(rows[0].fact).toBe('Имя: Константин')
  })

  it('filters user_facts by user_id', () => {
    sqlite.prepare(
      "INSERT INTO user_facts (user_id, fact) VALUES (?, ?)",
    ).run('a', 'A fact')
    sqlite.prepare(
      "INSERT INTO user_facts (user_id, fact) VALUES (?, ?)",
    ).run('b', 'B fact')

    const rows = extractSqliteUserFacts(sqlite, 'a')
    expect(rows).toHaveLength(1)
    expect(rows[0].fact).toBe('A fact')
  })

  it('extracts conversations by user_id', () => {
    sqlite.prepare(
      "INSERT INTO conversations (user_id, channel, role, content) VALUES (?, ?, ?, ?)",
    ).run('tg-123', 'telegram', 'user', 'Привет')
    sqlite.prepare(
      "INSERT INTO conversations (user_id, channel, role, content) VALUES (?, ?, ?, ?)",
    ).run('tg-123', 'telegram', 'assistant', 'Привет, Константин!')
    sqlite.prepare(
      "INSERT INTO conversations (user_id, channel, role, content) VALUES (?, ?, ?, ?)",
    ).run('other', 'telegram', 'user', 'Hi')

    const rows = extractSqliteConversations(sqlite, 'tg-123')
    expect(rows).toHaveLength(2)
    expect(rows[0].content).toBe('Привет')
    expect(rows[1].content).toBe('Привет, Константин!')
  })

  it('returns empty arrays for missing tables gracefully', () => {
    const empty = new Database(':memory:')
    expect(extractSqliteKnowledge(empty)).toEqual([])
    expect(extractSqliteUserFacts(empty, 'x')).toEqual([])
    expect(extractSqliteConversations(empty, 'x')).toEqual([])
    empty.close()
  })
})
```

- [ ] **Step 2: Run test — expect fail**

Run: `npx vitest run tests/multi/migration/sqlite-to-pg.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement extractors + migrator**

Create `src/multi/migration/sqlite-to-pg.ts`:
```ts
import type Database from 'better-sqlite3'
import type { Pool } from 'pg'
import { withWorkspace } from '../db/rls.js'

export interface SqliteKnowledgeRow {
  id: number
  topic: string
  insight: string
  source: string
  confidence: number
  timestamp: number
}

export interface SqliteUserFactRow {
  id: number
  user_id: string
  fact: string
  source: string
  timestamp: number
}

export interface SqliteConversationRow {
  id: number
  user_id: string
  channel: string
  role: string
  content: string
  tool_calls: string | null
  timestamp: number
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name)
  return row !== undefined
}

export function extractSqliteKnowledge(db: Database.Database): SqliteKnowledgeRow[] {
  if (!tableExists(db, 'knowledge')) return []
  return db
    .prepare('SELECT id, topic, insight, source, confidence, timestamp FROM knowledge ORDER BY id')
    .all() as SqliteKnowledgeRow[]
}

export function extractSqliteUserFacts(
  db: Database.Database,
  userId: string,
): SqliteUserFactRow[] {
  if (!tableExists(db, 'user_facts')) return []
  return db
    .prepare('SELECT id, user_id, fact, source, timestamp FROM user_facts WHERE user_id = ? ORDER BY id')
    .all(userId) as SqliteUserFactRow[]
}

export function extractSqliteConversations(
  db: Database.Database,
  userId: string,
): SqliteConversationRow[] {
  if (!tableExists(db, 'conversations')) return []
  return db
    .prepare(
      'SELECT id, user_id, channel, role, content, tool_calls, timestamp FROM conversations WHERE user_id = ? ORDER BY id',
    )
    .all(userId) as SqliteConversationRow[]
}

export interface MigrationResult {
  knowledgeCopied: number
  userFactsCopied: number
  conversationsCopied: number
  skippedExistingKnowledge: number
  skippedExistingFacts: number
  skippedExistingConversations: number
}

export interface MigrateOptions {
  sqlite: Database.Database
  pool: Pool
  workspaceId: string
  sqliteUserId: string
}

/**
 * Migrate one single-mode user's memory into a multi-tenant workspace.
 *
 * Idempotent: stores `source_sqlite_id` in meta JSON so re-running skips already migrated rows.
 */
export async function migrateSingleToMulti(opts: MigrateOptions): Promise<MigrationResult> {
  const { sqlite, pool, workspaceId, sqliteUserId } = opts

  const knowledge = extractSqliteKnowledge(sqlite)
  const userFacts = extractSqliteUserFacts(sqlite, sqliteUserId)
  const conversations = extractSqliteConversations(sqlite, sqliteUserId)

  const result: MigrationResult = {
    knowledgeCopied: 0,
    userFactsCopied: 0,
    conversationsCopied: 0,
    skippedExistingKnowledge: 0,
    skippedExistingFacts: 0,
    skippedExistingConversations: 0,
  }

  await withWorkspace(pool, workspaceId, async (client) => {
    // Build index of already-migrated sqlite ids by kind+source
    const existingFacts = await client.query(
      `select meta->>'source_sqlite_id' as sid, kind
       from bc_memory_facts
       where meta ? 'source_sqlite_id'`,
    )
    const knowledgeIds = new Set(
      existingFacts.rows
        .filter((r: any) => r.kind === 'knowledge')
        .map((r: any) => Number(r.sid)),
    )
    const factIds = new Set(
      existingFacts.rows
        .filter((r: any) => r.kind === 'fact')
        .map((r: any) => Number(r.sid)),
    )

    for (const k of knowledge) {
      if (knowledgeIds.has(k.id)) {
        result.skippedExistingKnowledge++
        continue
      }
      const content = `${k.topic}: ${k.insight}`
      const meta = {
        source_sqlite_id: k.id,
        source: k.source,
        confidence: k.confidence,
        original_topic: k.topic,
      }
      await client.query(
        `insert into bc_memory_facts (workspace_id, kind, content, meta, created_at)
         values ($1, 'knowledge', $2, $3, to_timestamp($4))`,
        [workspaceId, content, JSON.stringify(meta), k.timestamp],
      )
      result.knowledgeCopied++
    }

    for (const f of userFacts) {
      if (factIds.has(f.id)) {
        result.skippedExistingFacts++
        continue
      }
      const meta = {
        source_sqlite_id: f.id,
        source: f.source,
        sqlite_user_id: f.user_id,
      }
      await client.query(
        `insert into bc_memory_facts (workspace_id, kind, content, meta, created_at)
         values ($1, 'fact', $2, $3, to_timestamp($4))`,
        [workspaceId, f.fact, JSON.stringify(meta), f.timestamp],
      )
      result.userFactsCopied++
    }

    // Conversations: dedupe by (sqlite_id) stored in meta
    const existingConv = await client.query(
      `select meta->>'source_sqlite_id' as sid
       from bc_conversation
       where meta ? 'source_sqlite_id'`,
    )
    const convIds = new Set(
      existingConv.rows.map((r: any) => Number(r.sid)),
    )

    for (const c of conversations) {
      if (convIds.has(c.id)) {
        result.skippedExistingConversations++
        continue
      }
      const channel = c.channel === 'telegram' || c.channel === 'max' ? c.channel : 'telegram'
      const role = c.role === 'user' || c.role === 'assistant' || c.role === 'tool' ? c.role : 'user'
      const meta = {
        source_sqlite_id: c.id,
        sqlite_user_id: c.user_id,
        sqlite_channel: c.channel,
      }
      await client.query(
        `insert into bc_conversation (workspace_id, channel, role, content, tool_calls, meta, created_at)
         values ($1, $2, $3, $4, $5, $6, to_timestamp($7))`,
        [
          workspaceId,
          channel,
          role,
          c.content,
          c.tool_calls ? c.tool_calls : null,
          JSON.stringify(meta),
          c.timestamp,
        ],
      )
      result.conversationsCopied++
    }
  })

  return result
}
```

- [ ] **Step 4: Create CLI runner script**

Create `scripts/migrate-single-to-multi.ts`:
```ts
/**
 * Usage:
 *   BC_DATABASE_URL=postgres://... \
 *   BC_SQLITE_PATH=~/.betsy/betsy.db \
 *   BC_SQLITE_USER_ID=tg-123456 \
 *   BC_OWNER_TG_ID=123456 \
 *   npx tsx scripts/migrate-single-to-multi.ts
 *
 * Steps:
 *   1. Opens single-mode SQLite at BC_SQLITE_PATH (default ~/.betsy/betsy.db)
 *   2. Connects to multi-tenant Postgres at BC_DATABASE_URL
 *   3. Runs pending migrations
 *   4. Upserts a workspace for BC_OWNER_TG_ID
 *   5. Copies knowledge / user_facts / conversations for BC_SQLITE_USER_ID
 *   6. Prints migration report
 */
import Database from 'better-sqlite3'
import { Pool } from 'pg'
import os from 'node:os'
import path from 'node:path'
import { runMigrations } from '../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../src/multi/workspaces/repo.js'
import { migrateSingleToMulti } from '../src/multi/migration/sqlite-to-pg.js'

async function main() {
  const pgUrl = process.env.BC_DATABASE_URL
  if (!pgUrl) {
    console.error('BC_DATABASE_URL is required')
    process.exit(1)
  }

  const sqlitePath =
    process.env.BC_SQLITE_PATH ?? path.join(os.homedir(), '.betsy', 'betsy.db')
  const sqliteUserId = process.env.BC_SQLITE_USER_ID
  if (!sqliteUserId) {
    console.error('BC_SQLITE_USER_ID is required (e.g., tg-123456)')
    process.exit(1)
  }
  const ownerTgId = process.env.BC_OWNER_TG_ID
    ? Number(process.env.BC_OWNER_TG_ID)
    : null
  if (!ownerTgId) {
    console.error('BC_OWNER_TG_ID is required (numeric Telegram user id)')
    process.exit(1)
  }

  console.log(`[migrate] sqlite: ${sqlitePath}`)
  console.log(`[migrate] sqlite user id: ${sqliteUserId}`)
  console.log(`[migrate] owner tg id: ${ownerTgId}`)

  const sqlite = new Database(sqlitePath, { readonly: true })
  const pool = new Pool({ connectionString: pgUrl })

  try {
    console.log('[migrate] running postgres migrations...')
    const applied = await runMigrations(pool)
    console.log(`[migrate] postgres migrations applied: ${applied.length}`)

    const wsRepo = new WorkspaceRepo(pool)
    const workspace = await wsRepo.upsertForTelegram(ownerTgId)
    console.log(`[migrate] workspace id: ${workspace.id}`)

    console.log('[migrate] copying memory...')
    const result = await migrateSingleToMulti({
      sqlite,
      pool,
      workspaceId: workspace.id,
      sqliteUserId,
    })
    console.log('[migrate] result:', result)
    console.log('[migrate] done')
  } finally {
    sqlite.close()
    await pool.end()
  }
}

main().catch((e) => {
  console.error('[migrate] failed:', e)
  process.exit(1)
})
```

- [ ] **Step 5: Run unit tests — expect pass**

Run: `npx vitest run tests/multi/migration/sqlite-to-pg.test.ts`
Expected: 5 passed.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/multi/migration/ scripts/migrate-single-to-multi.ts tests/multi/migration/
git commit -m "feat(multi/migration): one-shot memory migration from single-mode SQLite to Postgres" --no-verify
```

---

## Spec coverage map

| Spec section | Task(s) |
|---|---|
| §3 Backend stack (Node 24, pg, pino, zod, adk, genai, s3) | 0, 1 |
| §3 Multi-mode dispatcher | 2 |
| §3 Env validation | 3 |
| §3 Structured logger with secret masking | 4 |
| §6 Postgres schema initial | 6 |
| §6 Row-Level Security + withWorkspace contract | 6, 8 |
| §6.2 `workspaces` table + repo | 9 |
| §6.1 `bc_personas` table + repo | 10 |
| §6.1 `bc_memory_facts` table + repo | 11 |
| §6.1 `bc_conversation` table + repo | 12 |
| §3 Beget S3 client with presigned URLs | 13 |
| §10 Healthz endpoint | 14 |
| §10 Graceful shutdown on SIGTERM | 15 |
| §2 Architectural isolation rule | 16 |
| §11 Integration tests | 17 |
| §11 Smoke test | 18 |
| §1 Persistence of Betsy's vibe (personality) | 20 |
| §1 Preservation of existing user memory from single-mode | 21 |

## What's **not** in this plan (deferred to next sub-plans)

- `@google/adk` agent factory and tool integrations → `2026-04-07-personal-betsy-agent.md`
- Selfie via Nano Banana 2 and TTS via Gemini → `2026-04-07-personal-betsy-agent.md`
- Telegram/MAX channel adapters → `2026-04-07-personal-betsy-channels.md`
- Bot router, onboarding FSM, commands → `2026-04-07-personal-betsy-channels.md`
- Reminders worker (pg-boss) and preferred_channel rules → `2026-04-07-personal-betsy-channels.md`
- Link codes for TG↔MAX binding → `2026-04-07-personal-betsy-channels.md`
- PaymentProvider interface, mock provider, wallet ledger → `2026-04-07-personal-betsy-billing.md`
- Tochka Bank integration → `2026-04-07-personal-betsy-billing.md`
- Subscription lifecycle, auto top-up → `2026-04-07-personal-betsy-billing.md`
- Webhook server for billing events → `2026-04-07-personal-betsy-billing.md`
- Cabinet SPA (bottom tabs, auth, settings) → `2026-04-07-personal-betsy-cabinet.md`
- Telegram MiniApp initData auth → `2026-04-07-personal-betsy-cabinet.md`
- VPS systemd deployment → final deploy plan after cabinet is done

## Acceptance criteria for Foundation

Foundation is considered complete when ALL of the following hold:

1. ✅ `BETSY_MODE=multi node dist/index.js` starts the server without errors
2. ✅ `GET http://localhost:8081/healthz` returns 200 `{"status":"ok"}` when Postgres is reachable
3. ✅ `BETSY_MODE=` (unset or other) starts existing single-mode Betsy unchanged
4. ✅ `npm run typecheck` returns 0 errors
5. ✅ `npx vitest run` passes all tests (unit) and gated tests skip without DB
6. ✅ `BC_TEST_DATABASE_URL=... npx vitest run tests/multi` passes all integration tests including RLS isolation
7. ✅ `npm run build` produces `dist/index.js` + migrations copied to `dist/multi/db/migrations/` AND `dist/migrations/`
8. ✅ Missing required env (`BC_DATABASE_URL`, `GEMINI_API_KEY`, one bot token) causes fail-fast on startup
9. ✅ Postgres RLS policy prevents cross-workspace data access (verified in `tests/multi/db/rls.test.ts`)
10. ✅ `CLAUDE.md` documents multi-mode isolation rules
11. ✅ All new code lives under `src/multi/` and `tests/multi/`; `src/core/` untouched
12. ✅ Single-mode `betsy.service` on VPS continues to work (this is verified implicitly by not touching single-mode code)
13. ✅ `buildSystemPromptForPersona()` produces a Betsy-flavored system prompt from a `Persona` record
14. ✅ `scripts/migrate-single-to-multi.ts` copies existing single-mode memory (`knowledge`, `user_facts`, `conversations`) into multi-tenant Postgres for a specified workspace, idempotently

## The cross-check for "can I write Betsy and get my character + memory back?"

This foundation plan does NOT itself deliver a live Betsy response. It delivers the plumbing. The live end-to-end verification ("write Betsy in Telegram → she responds with her character and my memory") happens after:

1. Foundation (this plan) — storage, RLS, personality bridge, memory migration script
2. **`personal-betsy-agent` sub-plan** — ADK agent factory that consumes `buildSystemPromptForPersona()` + loads `bc_memory_facts` as context, Gemini client, tools
3. **`personal-betsy-channels` sub-plan** — Telegram adapter, bot router, onboarding that creates the workspace + persona + runs migration script on first `/start`, reply pipeline

Only after all three sub-plans are implemented and deployed is the live acceptance test possible. This plan lays the foundation that makes the next two possible.
