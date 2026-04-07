# Personal Betsy v2 — Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Соединить Agent-layer c живыми каналами: Telegram, MAX, bot-router, онбординг, команды, `/link`-связывание, правила preferred_channel для напоминаний, reminders worker. После завершения: локально с реальным Gemini ключом и реальным Telegram bot token пользователь может написать `/start` боту, пройти короткий онбординг, получить ответ Betsy **с его памятью**, поставить напоминание, дождаться его в правильном канале, связать второй канал через `/link`.

**Architecture:**
- `src/multi/channels/` — `ChannelAdapter` interface + `TelegramAdapter` (grammy) + `MaxAdapter` (custom fetch with `Authorization: <token>` header, как проверяли в прошлой итерации)
- `src/multi/bot-router/` — главный dispatcher: принимает `InboundEvent`, резолвит workspace, роутит в onboarding FSM или runBetsy, обрабатывает команды
- `src/multi/onboarding/` — 3-шаговый FSM (name / business / address_form) + ensure persona
- `src/multi/linking/` — 6-значные коды с TTL + merge workspaces
- `src/multi/notify/` — каскад правил preferred_channel
- `src/multi/jobs/` — pg-boss reminders worker, запускает напоминания в правильный канал

**Tech Stack:** `grammy` (уже в deps single-mode), `pg-boss` (уже в deps Foundation), custom HTTP клиент для MAX (`fetch` + `Authorization` header).

**Related spec:** [docs/superpowers/specs/2026-04-07-personal-betsy-design.md](../specs/2026-04-07-personal-betsy-design.md)
**Depends on:**
- [Foundation plan](2026-04-07-personal-betsy-foundation.md)
- [Agent plan](2026-04-07-personal-betsy-agent.md)

---

## File Structure

New files:

```
src/multi/
  channels/
    base.ts                     # ChannelAdapter interface, InboundEvent, OutboundMessage
    telegram.ts                 # TelegramAdapter via grammy
    max.ts                      # MaxAdapter via custom fetch
  bot-router/
    router.ts                   # main dispatch: resolve workspace → onboarding or Betsy
    commands.ts                 # /start /help /status /plan /notify /link /forget /cancel
    onboarding-flow.ts          # 3-step FSM
  linking/
    types.ts                    # LinkCode
    repo.ts                     # LinkCodesRepo
    service.ts                  # generate/verify/merge workspaces
  notify/
    preferences.ts              # pickNotifyChannel(workspace, preferredChannel, availableChannels)
  jobs/
    reminders-worker.ts         # pg-boss worker that fires pending reminders
  db/migrations/
    005_link_codes.sql          # bc_link_codes table

tests/multi/
  channels/
    base.test.ts
    telegram.test.ts
    max.test.ts
  bot-router/
    router.test.ts
    commands.test.ts
    onboarding-flow.test.ts
  linking/
    service.test.ts
    repo.test.ts
  notify/
    preferences.test.ts
  jobs/
    reminders-worker.test.ts

scripts/
  smoke-channels.ts             # manual smoke: real Telegram bot, local Postgres, Gemini
```

Files modified:
- `src/multi/server.ts` — wire channels + router + reminders worker into bootstrap
- `src/multi/env.ts` — add `BC_REMINDERS_POLL_INTERVAL_MS` (default 30_000)

---

## Task 1: Channel adapter interface + base types

**Files:**
- Create: `src/multi/channels/base.ts`
- Create: `tests/multi/channels/base.test.ts`

- [ ] **Step 1: Write failing test for type exports**

Create `tests/multi/channels/base.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import type { InboundEvent, OutboundMessage, ChannelAdapter, ChannelName } from '../../../src/multi/channels/base.js'

describe('channel base types', () => {
  it('exports channel names', () => {
    const names: ChannelName[] = ['telegram', 'max']
    expect(names).toHaveLength(2)
  })

  it('InboundEvent shape compiles', () => {
    const ev: InboundEvent = {
      channel: 'telegram',
      chatId: '123',
      userId: '456',
      userDisplay: 'Константин',
      text: 'Привет',
      messageId: 'mid1',
      timestamp: new Date(),
      isVoiceMessage: false,
      raw: null,
    }
    expect(ev.channel).toBe('telegram')
  })

  it('OutboundMessage supports text and audio', () => {
    const textOnly: OutboundMessage = { chatId: '1', text: 'Hello' }
    const withAudio: OutboundMessage = {
      chatId: '1',
      text: 'Hello',
      audio: { base64: 'xxx', mimeType: 'audio/ogg' },
    }
    const withImage: OutboundMessage = {
      chatId: '1',
      text: 'Look',
      image: { url: 'https://x/y.png' },
    }
    expect(textOnly.chatId).toBe('1')
    expect(withAudio.audio?.mimeType).toBe('audio/ogg')
    expect(withImage.image?.url).toContain('https')
  })
})
```

- [ ] **Step 2: Implement base.ts**

Create `src/multi/channels/base.ts`:
```ts
export type ChannelName = 'telegram' | 'max'

export interface InboundEvent {
  channel: ChannelName
  chatId: string
  userId: string
  userDisplay: string
  text: string
  messageId: string
  timestamp: Date
  isVoiceMessage: boolean
  /** Raw platform-specific event, useful for diagnostics; never persist */
  raw: unknown
}

export interface OutboundMessage {
  chatId: string
  text: string
  audio?: { base64: string; mimeType: string }
  image?: { url: string } | { base64: string; mimeType: string }
  replyToMessageId?: string
}

export interface ChannelAdapter {
  readonly name: ChannelName
  start(): Promise<void>
  stop(): Promise<void>
  sendMessage(msg: OutboundMessage): Promise<void>
  onMessage(handler: (ev: InboundEvent) => Promise<void>): void
}
```

- [ ] **Step 3: Run test + commit**

```bash
npx vitest run tests/multi/channels/base.test.ts
git add src/multi/channels/base.ts tests/multi/channels/base.test.ts
git commit -m "feat(multi/channels): ChannelAdapter base interface and types" --no-verify
```

---

## Task 2: Telegram adapter (grammy)

**Files:**
- Create: `src/multi/channels/telegram.ts`
- Create: `tests/multi/channels/telegram.test.ts`

- [ ] **Step 1: Write failing test for inbound mapping**

Create `tests/multi/channels/telegram.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildInboundFromTelegramCtx } from '../../../src/multi/channels/telegram.js'

describe('buildInboundFromTelegramCtx', () => {
  it('maps text message to InboundEvent', () => {
    const ctx: any = {
      chat: { id: 12345 },
      from: { id: 7, first_name: 'Константин', last_name: 'P' },
      message: {
        message_id: 42,
        text: 'Привет',
        date: Math.floor(Date.now() / 1000),
      },
    }
    const ev = buildInboundFromTelegramCtx(ctx)
    expect(ev.channel).toBe('telegram')
    expect(ev.chatId).toBe('12345')
    expect(ev.userId).toBe('7')
    expect(ev.userDisplay).toBe('Константин')
    expect(ev.text).toBe('Привет')
    expect(ev.messageId).toBe('42')
    expect(ev.isVoiceMessage).toBe(false)
  })

  it('flags voice message', () => {
    const ctx: any = {
      chat: { id: 1 },
      from: { id: 2, first_name: 'K' },
      message: {
        message_id: 10,
        voice: { file_id: 'x', duration: 3 },
        date: Math.floor(Date.now() / 1000),
      },
    }
    const ev = buildInboundFromTelegramCtx(ctx)
    expect(ev.isVoiceMessage).toBe(true)
    expect(ev.text).toBe('')
  })

  it('uses username when first_name absent', () => {
    const ctx: any = {
      chat: { id: 1 },
      from: { id: 2, username: 'kostya' },
      message: { message_id: 10, text: 'hi', date: 0 },
    }
    expect(buildInboundFromTelegramCtx(ctx).userDisplay).toBe('kostya')
  })
})
```

- [ ] **Step 2: Implement TelegramAdapter**

Create `src/multi/channels/telegram.ts`:
```ts
import { Bot, type Context, InputFile } from 'grammy'
import type { InboundEvent, OutboundMessage, ChannelAdapter } from './base.js'

export function buildInboundFromTelegramCtx(ctx: Context): InboundEvent {
  const msg = ctx.message!
  const from = ctx.from!
  const chat = ctx.chat!
  const display =
    from.first_name?.trim() ||
    from.username ||
    String(from.id)
  const isVoice = msg.voice !== undefined
  return {
    channel: 'telegram',
    chatId: String(chat.id),
    userId: String(from.id),
    userDisplay: display,
    text: msg.text ?? '',
    messageId: String(msg.message_id),
    timestamp: new Date((msg.date ?? 0) * 1000),
    isVoiceMessage: isVoice,
    raw: ctx,
  }
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram' as const
  private bot: Bot
  private handler?: (ev: InboundEvent) => Promise<void>

  constructor(token: string) {
    this.bot = new Bot(token)
  }

  async start(): Promise<void> {
    this.bot.on('message', async (ctx) => {
      if (!ctx.message || !ctx.from || !ctx.chat) return
      if (!this.handler) return
      const ev = buildInboundFromTelegramCtx(ctx)
      try {
        await this.handler(ev)
      } catch (e) {
        console.error('[telegram] handler failed:', e)
      }
    })
    // Fire-and-forget bot start; long polling runs in background
    void this.bot.start()
  }

  async stop(): Promise<void> {
    await this.bot.stop()
  }

  async sendMessage(msg: OutboundMessage): Promise<void> {
    const chatId = Number(msg.chatId)

    // If image present — send as photo with caption
    if (msg.image) {
      if ('url' in msg.image) {
        await this.bot.api.sendPhoto(chatId, msg.image.url, {
          caption: msg.text,
        })
      } else {
        const buf = Buffer.from(msg.image.base64, 'base64')
        await this.bot.api.sendPhoto(chatId, new InputFile(buf, 'image.png'), {
          caption: msg.text,
        })
      }
      return
    }

    // Text always
    if (msg.text && msg.text.length > 0) {
      await this.bot.api.sendMessage(chatId, msg.text)
    }

    // Audio as voice message
    if (msg.audio) {
      const buf = Buffer.from(msg.audio.base64, 'base64')
      await this.bot.api.sendVoice(chatId, new InputFile(buf, 'voice.ogg'))
    }
  }

  onMessage(handler: (ev: InboundEvent) => Promise<void>): void {
    this.handler = handler
  }
}
```

- [ ] **Step 3: Run test + commit**

```bash
npx vitest run tests/multi/channels/telegram.test.ts
npm run typecheck
git add src/multi/channels/telegram.ts tests/multi/channels/telegram.test.ts
git commit -m "feat(multi/channels): TelegramAdapter via grammy (text + voice + photo)" --no-verify
```

---

## Task 3: MAX adapter (custom fetch)

**Files:**
- Create: `src/multi/channels/max.ts`
- Create: `tests/multi/channels/max.test.ts`

MAX Bot API details (verified live 2026-04-07):
- Base URL: `https://botapi.max.ru`
- Auth: `Authorization: <token>` header (NOT `Bearer`, NOT query param)
- Long polling: `GET /updates?marker=<n>&timeout=30&limit=100`
- Send: `POST /messages?chat_id=<id>` with JSON body `{text}`
- Update shape for incoming text: `{update_type: 'message_created', message: {body: {mid, text}, recipient: {chat_id}, sender: {user_id, name}}}`

- [ ] **Step 1: Write failing test**

Create `tests/multi/channels/max.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { buildInboundFromMaxUpdate, MaxAdapter } from '../../../src/multi/channels/max.js'

describe('buildInboundFromMaxUpdate', () => {
  it('maps message_created with chat recipient', () => {
    const update: any = {
      update_type: 'message_created',
      message: {
        body: { mid: 'm1', text: 'Привет' },
        recipient: { chat_id: 1001 },
        sender: { user_id: 500, name: 'Константин' },
      },
      timestamp: 1700000000000,
    }
    const ev = buildInboundFromMaxUpdate(update)
    expect(ev).not.toBeNull()
    expect(ev!.channel).toBe('max')
    expect(ev!.chatId).toBe('1001')
    expect(ev!.userId).toBe('500')
    expect(ev!.userDisplay).toBe('Константин')
    expect(ev!.text).toBe('Привет')
  })

  it('falls back to sender.user_id as chat when no recipient.chat_id', () => {
    const update: any = {
      update_type: 'message_created',
      message: {
        body: { mid: 'm1', text: 'Hi' },
        recipient: {},
        sender: { user_id: 500, name: 'K' },
      },
    }
    const ev = buildInboundFromMaxUpdate(update)
    expect(ev!.chatId).toBe('500')
  })

  it('returns null for non-message updates', () => {
    expect(buildInboundFromMaxUpdate({ update_type: 'something_else' } as any)).toBeNull()
  })
})

describe('MaxAdapter.sendMessage (via mocked fetch)', () => {
  it('POSTs to /messages with chat_id param and JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    })
    const adapter = new MaxAdapter('test-token', fetchMock as any)
    await adapter.sendMessage({ chatId: '42', text: 'Привет' })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, options] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/messages')
    expect(String(url)).toContain('chat_id=42')
    expect((options as any).method).toBe('POST')
    expect((options as any).headers['Authorization']).toBe('test-token')
    const body = JSON.parse((options as any).body)
    expect(body.text).toBe('Привет')
  })
})
```

- [ ] **Step 2: Implement**

Create `src/multi/channels/max.ts`:
```ts
import type { InboundEvent, OutboundMessage, ChannelAdapter } from './base.js'

const MAX_BASE = 'https://botapi.max.ru'
type FetchFn = typeof fetch

export function buildInboundFromMaxUpdate(update: any): InboundEvent | null {
  if (update?.update_type !== 'message_created') return null
  const m = update.message ?? {}
  const body = m.body ?? {}
  const recipient = m.recipient ?? {}
  const sender = m.sender ?? {}

  const chatId = recipient.chat_id ?? sender.user_id
  if (!chatId) return null

  return {
    channel: 'max',
    chatId: String(chatId),
    userId: String(sender.user_id ?? ''),
    userDisplay: sender.name ?? String(sender.user_id ?? ''),
    text: body.text ?? '',
    messageId: String(body.mid ?? ''),
    timestamp: new Date(update.timestamp ?? Date.now()),
    isVoiceMessage: false,
    raw: update,
  }
}

export class MaxAdapter implements ChannelAdapter {
  readonly name = 'max' as const
  private token: string
  private fetchFn: FetchFn
  private handler?: (ev: InboundEvent) => Promise<void>
  private marker: number | null = null
  private stopping = false
  private pollPromise: Promise<void> | null = null

  constructor(token: string, fetchFn: FetchFn = fetch) {
    this.token = token
    this.fetchFn = fetchFn
  }

  async start(): Promise<void> {
    this.stopping = false
    this.pollPromise = this.pollLoop()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.pollPromise) {
      await this.pollPromise.catch(() => {})
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const url = new URL(`${MAX_BASE}/updates`)
        url.searchParams.set('timeout', '30')
        url.searchParams.set('limit', '100')
        if (this.marker !== null) url.searchParams.set('marker', String(this.marker))
        const res = await this.fetchFn(url.toString(), {
          headers: { Authorization: this.token },
        })
        if (!res.ok) {
          await new Promise((r) => setTimeout(r, 2000))
          continue
        }
        const data = (await res.json()) as any
        const updates = data.updates ?? []
        for (const update of updates) {
          const ev = buildInboundFromMaxUpdate(update)
          if (ev && this.handler) {
            try {
              await this.handler(ev)
            } catch (e) {
              console.error('[max] handler failed:', e)
            }
          }
        }
        if (data.marker !== undefined) this.marker = data.marker
      } catch (e) {
        if (!this.stopping) {
          console.error('[max] poll error:', e)
          await new Promise((r) => setTimeout(r, 3000))
        }
      }
    }
  }

  async sendMessage(msg: OutboundMessage): Promise<void> {
    const url = new URL(`${MAX_BASE}/messages`)
    url.searchParams.set('chat_id', msg.chatId)
    const body: any = { text: msg.text }
    const res = await this.fetchFn(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: this.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`MAX sendMessage failed: ${res.status}`)
    }
  }

  onMessage(handler: (ev: InboundEvent) => Promise<void>): void {
    this.handler = handler
  }
}
```

- [ ] **Step 3: Run test + commit**

```bash
npx vitest run tests/multi/channels/max.test.ts
npm run typecheck
git add src/multi/channels/max.ts tests/multi/channels/max.test.ts
git commit -m "feat(multi/channels): MaxAdapter via fetch with Authorization header" --no-verify
```

---

## Task 4: Notify preferences (caskad rules for reminders)

**Files:**
- Create: `src/multi/notify/preferences.ts`
- Create: `tests/multi/notify/preferences.test.ts`

Implements the 5 rules from spec §4.5:
- Rule 0: preferred_channel stored at creation time
- Rule 1: notify_channel_pref override
- Rule 2: preferred_channel if available
- Rule 3: last_active_channel fallback
- Rule 4: any available channel with note
- Rule 5: one reminder = one channel

- [ ] **Step 1: Write failing test**

Create `tests/multi/notify/preferences.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { pickNotifyChannel } from '../../../src/multi/notify/preferences.js'

describe('pickNotifyChannel', () => {
  const baseWs = {
    ownerTgId: 1,
    ownerMaxId: 2,
    lastActiveChannel: 'telegram' as const,
    notifyChannelPref: 'auto' as const,
  }

  it('rule 1: notifyChannelPref override wins', () => {
    const result = pickNotifyChannel({
      workspace: { ...baseWs, notifyChannelPref: 'max' },
      preferredChannel: 'telegram',
      availableChannels: ['telegram', 'max'],
    })
    expect(result.channel).toBe('max')
    expect(result.reason).toBe('user_override')
  })

  it('rule 2: preferred_channel chosen when available', () => {
    const result = pickNotifyChannel({
      workspace: baseWs,
      preferredChannel: 'telegram',
      availableChannels: ['telegram', 'max'],
    })
    expect(result.channel).toBe('telegram')
    expect(result.reason).toBe('preferred_at_creation')
  })

  it('rule 3: fallback to last_active when preferred unavailable', () => {
    const result = pickNotifyChannel({
      workspace: { ...baseWs, lastActiveChannel: 'max' },
      preferredChannel: 'telegram',
      availableChannels: ['max'],
    })
    expect(result.channel).toBe('max')
    expect(result.reason).toBe('last_active')
  })

  it('rule 4: any available when neither preferred nor last_active works', () => {
    const result = pickNotifyChannel({
      workspace: { ...baseWs, lastActiveChannel: null },
      preferredChannel: 'telegram',
      availableChannels: ['max'],
    })
    expect(result.channel).toBe('max')
    expect(result.reason).toBe('any_available')
  })

  it('returns null when no channels at all', () => {
    const result = pickNotifyChannel({
      workspace: baseWs,
      preferredChannel: 'telegram',
      availableChannels: [],
    })
    expect(result.channel).toBeNull()
    expect(result.reason).toBe('no_channels')
  })

  it('does not pick telegram if ownerTgId is null', () => {
    const result = pickNotifyChannel({
      workspace: { ...baseWs, ownerTgId: null },
      preferredChannel: 'telegram',
      availableChannels: ['telegram', 'max'],
    })
    expect(result.channel).toBe('max')
  })

  it('does not pick max if ownerMaxId is null', () => {
    const result = pickNotifyChannel({
      workspace: { ...baseWs, ownerMaxId: null, notifyChannelPref: 'max' },
      preferredChannel: 'max',
      availableChannels: ['telegram', 'max'],
    })
    expect(result.channel).toBe('telegram')
  })
})
```

- [ ] **Step 2: Implement preferences**

Create `src/multi/notify/preferences.ts`:
```ts
import type { ChannelName } from '../channels/base.js'

export interface NotifyWorkspace {
  ownerTgId: number | null
  ownerMaxId: number | null
  lastActiveChannel: ChannelName | null
  notifyChannelPref: 'auto' | 'telegram' | 'max'
}

export interface PickInput {
  workspace: NotifyWorkspace
  preferredChannel: ChannelName
  availableChannels: ChannelName[]
}

export type PickReason =
  | 'user_override'
  | 'preferred_at_creation'
  | 'last_active'
  | 'any_available'
  | 'no_channels'

export interface PickResult {
  channel: ChannelName | null
  reason: PickReason
}

function ownerHasChannel(ws: NotifyWorkspace, channel: ChannelName): boolean {
  if (channel === 'telegram') return ws.ownerTgId !== null
  if (channel === 'max') return ws.ownerMaxId !== null
  return false
}

function isReady(
  ws: NotifyWorkspace,
  channel: ChannelName,
  available: ChannelName[],
): boolean {
  return ownerHasChannel(ws, channel) && available.includes(channel)
}

export function pickNotifyChannel(input: PickInput): PickResult {
  const { workspace, preferredChannel, availableChannels } = input

  // Rule 1: explicit user override
  if (workspace.notifyChannelPref !== 'auto') {
    if (isReady(workspace, workspace.notifyChannelPref, availableChannels)) {
      return { channel: workspace.notifyChannelPref, reason: 'user_override' }
    }
    // override unavailable — fall through to automatic rules
  }

  // Rule 2: preferred_channel (stored at creation) if available
  if (isReady(workspace, preferredChannel, availableChannels)) {
    return { channel: preferredChannel, reason: 'preferred_at_creation' }
  }

  // Rule 3: last_active_channel
  if (
    workspace.lastActiveChannel &&
    isReady(workspace, workspace.lastActiveChannel, availableChannels)
  ) {
    return { channel: workspace.lastActiveChannel, reason: 'last_active' }
  }

  // Rule 4: any available channel where owner has contact
  for (const channel of availableChannels) {
    if (ownerHasChannel(workspace, channel)) {
      return { channel, reason: 'any_available' }
    }
  }

  return { channel: null, reason: 'no_channels' }
}
```

- [ ] **Step 3: Run test + commit**

```bash
npx vitest run tests/multi/notify/preferences.test.ts
git add src/multi/notify/preferences.ts tests/multi/notify/preferences.test.ts
git commit -m "feat(multi/notify): preferred channel caskad rules for proactive messages" --no-verify
```

---

## Task 5: Linking codes (migration + types + repo)

**Files:**
- Create: `src/multi/db/migrations/005_link_codes.sql`
- Create: `src/multi/linking/types.ts`
- Create: `src/multi/linking/repo.ts`
- Create: `tests/multi/linking/repo.test.ts`

- [ ] **Step 1: Migration 005**

Create `src/multi/db/migrations/005_link_codes.sql`:
```sql
create table if not exists bc_link_codes (
  code            text primary key,
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now()
);

create index if not exists bc_link_codes_expires_idx on bc_link_codes(expires_at);
create index if not exists bc_link_codes_ws_idx on bc_link_codes(workspace_id);

alter table bc_link_codes enable row level security;
alter table bc_link_codes force row level security;

-- Link codes bypass per-workspace RLS because the target user doesn't know their
-- workspace_id yet. Reads happen via asAdmin.
-- But we still need a policy so withWorkspace (for cleanup inside a tenant) works:
drop policy if exists ws_scoped on bc_link_codes;
create policy ws_scoped on bc_link_codes
  using (workspace_id = current_setting('app.workspace_id', true)::uuid);

grant select, insert, update, delete on bc_link_codes to bc_app;
```

- [ ] **Step 2: Types**

Create `src/multi/linking/types.ts`:
```ts
export interface LinkCode {
  code: string
  workspaceId: string
  expiresAt: Date
  createdAt: Date
}
```

- [ ] **Step 3: Write failing test**

Create `tests/multi/linking/repo.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { runMigrations } from '../../../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../../../src/multi/workspaces/repo.js'
import { LinkCodesRepo } from '../../../src/multi/linking/repo.js'

const url = process.env.BC_TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('LinkCodesRepo', () => {
  let pool: Pool
  let wsRepo: WorkspaceRepo
  let repo: LinkCodesRepo
  let wsId: string

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query('drop schema public cascade; create schema public;')
    await runMigrations(pool)
    wsRepo = new WorkspaceRepo(pool)
    repo = new LinkCodesRepo(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('truncate workspaces cascade')
    const ws = await wsRepo.upsertForTelegram(1)
    wsId = ws.id
  })

  it('creates a code and finds it', async () => {
    const code = await repo.create(wsId, 10 * 60 * 1000)
    expect(code.code).toMatch(/^\d{6}$/)
    const found = await repo.findByCode(code.code)
    expect(found?.workspaceId).toBe(wsId)
  })

  it('consumes a code — returns it once and then gone', async () => {
    const code = await repo.create(wsId, 10 * 60 * 1000)
    const first = await repo.consume(code.code)
    expect(first?.workspaceId).toBe(wsId)
    const second = await repo.consume(code.code)
    expect(second).toBeNull()
  })

  it('findByCode returns null for expired codes', async () => {
    const code = await repo.create(wsId, -1000) // already expired
    const found = await repo.findByCode(code.code)
    expect(found).toBeNull()
  })

  it('countRecentForWorkspace returns number of codes in last hour', async () => {
    await repo.create(wsId, 10 * 60 * 1000)
    await repo.create(wsId, 10 * 60 * 1000)
    const count = await repo.countRecentForWorkspace(wsId, 60 * 60 * 1000)
    expect(count).toBe(2)
  })
})
```

- [ ] **Step 4: Implement repo**

Create `src/multi/linking/repo.ts`:
```ts
import type { Pool } from 'pg'
import { asAdmin } from '../db/rls.js'
import type { LinkCode } from './types.js'

function rowToLinkCode(r: any): LinkCode {
  return {
    code: r.code,
    workspaceId: r.workspace_id,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  }
}

function generateCode(): string {
  return String(Math.floor(Math.random() * 900000) + 100000)
}

/**
 * LinkCodesRepo uses asAdmin because the incoming user scans/types a code
 * without knowing the workspace_id — we need to look up the code globally.
 */
export class LinkCodesRepo {
  constructor(private pool: Pool) {}

  async create(workspaceId: string, ttlMs: number): Promise<LinkCode> {
    return asAdmin(this.pool, async (client) => {
      // Generate a code, retry if collision
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateCode()
        const expiresAt = new Date(Date.now() + ttlMs)
        try {
          const { rows } = await client.query(
            `insert into bc_link_codes (code, workspace_id, expires_at)
             values ($1, $2, $3)
             returning *`,
            [code, workspaceId, expiresAt],
          )
          return rowToLinkCode(rows[0])
        } catch (e) {
          // unique violation — try another
          if ((e as any).code === '23505') continue
          throw e
        }
      }
      throw new Error('failed to generate unique link code after 5 attempts')
    })
  }

  async findByCode(code: string): Promise<LinkCode | null> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `select * from bc_link_codes where code = $1 and expires_at > now()`,
        [code],
      )
      return rows[0] ? rowToLinkCode(rows[0]) : null
    })
  }

  async consume(code: string): Promise<LinkCode | null> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `delete from bc_link_codes
         where code = $1 and expires_at > now()
         returning *`,
        [code],
      )
      return rows[0] ? rowToLinkCode(rows[0]) : null
    })
  }

  async countRecentForWorkspace(workspaceId: string, windowMs: number): Promise<number> {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `select count(*)::int as c
         from bc_link_codes
         where workspace_id = $1 and created_at > now() - ($2::bigint || ' milliseconds')::interval`,
        [workspaceId, windowMs],
      )
      return rows[0].c as number
    })
  }

  async cleanup(): Promise<number> {
    return asAdmin(this.pool, async (client) => {
      const { rowCount } = await client.query(
        `delete from bc_link_codes where expires_at < now()`,
      )
      return rowCount ?? 0
    })
  }
}
```

- [ ] **Step 5: Run test + commit**

```bash
npx vitest run tests/multi/linking/repo.test.ts
npm run typecheck
git add src/multi/db/migrations/005_link_codes.sql src/multi/linking/types.ts src/multi/linking/repo.ts tests/multi/linking/repo.test.ts
git commit -m "feat(multi/linking): link codes migration and repo with rate limiting helper" --no-verify
```

---

## Task 6: Linking service (generate + verify + merge)

**Files:**
- Create: `src/multi/linking/service.ts`
- Create: `tests/multi/linking/service.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/multi/linking/service.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { LinkingService } from '../../../src/multi/linking/service.js'

function mockRepos() {
  const codes = {
    create: vi.fn().mockResolvedValue({
      code: '123456',
      workspaceId: 'ws1',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      createdAt: new Date(),
    }),
    consume: vi.fn().mockResolvedValue({
      code: '123456',
      workspaceId: 'ws1',
      expiresAt: new Date(),
      createdAt: new Date(),
    }),
    countRecentForWorkspace: vi.fn().mockResolvedValue(0),
  }
  const ws = {
    findById: vi.fn().mockResolvedValue({
      id: 'ws1',
      ownerTgId: 123,
      ownerMaxId: null,
      displayName: 'K',
      plan: 'personal',
      status: 'active',
    }),
    updateOwnerMax: vi.fn().mockResolvedValue(undefined),
    updateOwnerTg: vi.fn().mockResolvedValue(undefined),
  }
  return { codes, ws }
}

describe('LinkingService.generateCode', () => {
  it('creates code for workspace', async () => {
    const repos = mockRepos()
    const svc = new LinkingService(repos.codes as any, repos.ws as any)
    const code = await svc.generateCode('ws1')
    expect(code).toBe('123456')
    expect(repos.codes.create).toHaveBeenCalledWith('ws1', 10 * 60 * 1000)
  })

  it('throws rate limit error when > 5 codes in past hour', async () => {
    const repos = mockRepos()
    repos.codes.countRecentForWorkspace.mockResolvedValue(5)
    const svc = new LinkingService(repos.codes as any, repos.ws as any)
    await expect(svc.generateCode('ws1')).rejects.toThrow(/rate limit/i)
  })
})

describe('LinkingService.verifyAndLink', () => {
  it('links max id to existing workspace', async () => {
    const repos = mockRepos()
    const svc = new LinkingService(repos.codes as any, repos.ws as any)
    const result = await svc.verifyAndLink('123456', {
      fromChannel: 'max',
      newChannelUserId: 555,
    })
    expect(result.success).toBe(true)
    expect(result.workspaceId).toBe('ws1')
    expect(repos.ws.updateOwnerMax).toHaveBeenCalledWith('ws1', 555)
  })

  it('returns success=false when code invalid', async () => {
    const repos = mockRepos()
    repos.codes.consume.mockResolvedValue(null)
    const svc = new LinkingService(repos.codes as any, repos.ws as any)
    const result = await svc.verifyAndLink('000000', {
      fromChannel: 'max',
      newChannelUserId: 555,
    })
    expect(result.success).toBe(false)
    expect(result.reason).toBe('invalid_or_expired')
  })

  it('returns already_linked if max id is already set on a different workspace', async () => {
    const repos = mockRepos()
    repos.ws.findById.mockResolvedValue({
      id: 'ws1',
      ownerTgId: 123,
      ownerMaxId: 999, // different max user already linked
      displayName: 'K',
      plan: 'personal',
      status: 'active',
    })
    const svc = new LinkingService(repos.codes as any, repos.ws as any)
    const result = await svc.verifyAndLink('123456', {
      fromChannel: 'max',
      newChannelUserId: 555,
    })
    expect(result.success).toBe(false)
    expect(result.reason).toBe('channel_already_linked')
  })
})
```

- [ ] **Step 2: Implement service**

Create `src/multi/linking/service.ts`:
```ts
import type { LinkCodesRepo } from './repo.js'

const CODE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour
const RATE_LIMIT_MAX = 5

export interface WorkspaceLinkView {
  id: string
  ownerTgId: number | null
  ownerMaxId: number | null
}

export interface WorkspaceLinkWriter {
  findById(id: string): Promise<WorkspaceLinkView | null>
  updateOwnerTg?(id: string, tgId: number): Promise<void>
  updateOwnerMax?(id: string, maxId: number): Promise<void>
}

export interface VerifyAndLinkInput {
  fromChannel: 'telegram' | 'max'
  newChannelUserId: number
}

export type VerifyAndLinkResult =
  | { success: true; workspaceId: string }
  | {
      success: false
      reason: 'invalid_or_expired' | 'workspace_gone' | 'channel_already_linked'
    }

export class LinkingService {
  constructor(
    private codes: LinkCodesRepo,
    private workspaces: WorkspaceLinkWriter,
  ) {}

  async generateCode(workspaceId: string): Promise<string> {
    const recent = await this.codes.countRecentForWorkspace(workspaceId, RATE_LIMIT_WINDOW_MS)
    if (recent >= RATE_LIMIT_MAX) {
      throw new Error('rate limit: too many codes generated in the past hour')
    }
    const linkCode = await this.codes.create(workspaceId, CODE_TTL_MS)
    return linkCode.code
  }

  async verifyAndLink(
    code: string,
    input: VerifyAndLinkInput,
  ): Promise<VerifyAndLinkResult> {
    const consumed = await this.codes.consume(code)
    if (!consumed) {
      return { success: false, reason: 'invalid_or_expired' }
    }

    const workspace = await this.workspaces.findById(consumed.workspaceId)
    if (!workspace) {
      return { success: false, reason: 'workspace_gone' }
    }

    if (input.fromChannel === 'max') {
      if (workspace.ownerMaxId !== null && workspace.ownerMaxId !== input.newChannelUserId) {
        return { success: false, reason: 'channel_already_linked' }
      }
      if (this.workspaces.updateOwnerMax) {
        await this.workspaces.updateOwnerMax(workspace.id, input.newChannelUserId)
      }
    } else {
      if (workspace.ownerTgId !== null && workspace.ownerTgId !== input.newChannelUserId) {
        return { success: false, reason: 'channel_already_linked' }
      }
      if (this.workspaces.updateOwnerTg) {
        await this.workspaces.updateOwnerTg(workspace.id, input.newChannelUserId)
      }
    }

    return { success: true, workspaceId: workspace.id }
  }
}
```

- [ ] **Step 3: Add updateOwnerTg / updateOwnerMax to WorkspaceRepo**

Read current `src/multi/workspaces/repo.ts` and add these two methods at the end of the class (mirror of other `updateX` patterns):
```ts
  async updateOwnerTg(id: string, tgId: number): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update workspaces set owner_tg_id = $2 where id = $1`,
        [id, tgId],
      )
    })
  }

  async updateOwnerMax(id: string, maxId: number): Promise<void> {
    await asAdmin(this.pool, async (client) => {
      await client.query(
        `update workspaces set owner_max_id = $2 where id = $1`,
        [id, maxId],
      )
    })
  }
```

- [ ] **Step 4: Run test + commit**

```bash
npx vitest run tests/multi/linking/service.test.ts
npm run typecheck
git add src/multi/linking/service.ts src/multi/workspaces/repo.ts tests/multi/linking/service.test.ts
git commit -m "feat(multi/linking): LinkingService with generate/verify/merge and rate limiting" --no-verify
```

---

## Task 7: Onboarding FSM

**Files:**
- Create: `src/multi/bot-router/onboarding-flow.ts`
- Create: `tests/multi/bot-router/onboarding-flow.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/multi/bot-router/onboarding-flow.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import {
  nextOnboardingStep,
  parseOnboardingAnswer,
  ONBOARDING_STEPS,
  isOnboardingComplete,
} from '../../../src/multi/bot-router/onboarding-flow.js'

describe('onboarding FSM', () => {
  it('first step is name question', () => {
    const step = nextOnboardingStep({})
    expect(step?.key).toBe('name')
    expect(step?.question).toMatch(/как тебя зовут|name/i)
  })

  it('advances through 3 steps in order', () => {
    let profile: Record<string, unknown> = {}
    const seen: string[] = []
    for (let i = 0; i < 3; i++) {
      const s = nextOnboardingStep(profile)
      expect(s).not.toBeNull()
      seen.push(s!.key)
      profile = { ...profile, [s!.key]: 'x' }
    }
    expect(nextOnboardingStep(profile)).toBeNull()
    expect(seen).toEqual(['name', 'business_context', 'address_form'])
  })

  it('isOnboardingComplete returns true when all set', () => {
    expect(isOnboardingComplete({})).toBe(false)
    expect(isOnboardingComplete({ name: 'K' })).toBe(false)
    expect(
      isOnboardingComplete({
        name: 'K',
        business_context: 'builds AI',
        address_form: 'ty',
      }),
    ).toBe(true)
  })

  it('parseOnboardingAnswer normalizes address form from ty/вы', () => {
    const tyStep = ONBOARDING_STEPS.find((s) => s.key === 'address_form')!
    expect(parseOnboardingAnswer(tyStep, 'на ты')).toEqual({ address_form: 'ty' })
    expect(parseOnboardingAnswer(tyStep, 'на вы')).toEqual({ address_form: 'vy' })
    expect(parseOnboardingAnswer(tyStep, 'ты')).toEqual({ address_form: 'ty' })
    expect(parseOnboardingAnswer(tyStep, 'ВЫ')).toEqual({ address_form: 'vy' })
  })

  it('parseOnboardingAnswer trims text for name and business_context', () => {
    const nameStep = ONBOARDING_STEPS.find((s) => s.key === 'name')!
    expect(parseOnboardingAnswer(nameStep, '  Константин  ')).toEqual({
      name: 'Константин',
    })
  })
})
```

- [ ] **Step 2: Implement**

Create `src/multi/bot-router/onboarding-flow.ts`:
```ts
export interface OnboardingStep {
  key: 'name' | 'business_context' | 'address_form'
  question: string
  buttons?: { id: string; label: string }[]
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    key: 'name',
    question: 'Привет! Я Betsy 👋 Как тебя зовут?',
  },
  {
    key: 'business_context',
    question:
      'Расскажи в двух словах, чем ты занимаешься — это поможет мне быть тебе полезной.',
  },
  {
    key: 'address_form',
    question: 'И последний вопрос: как удобнее — на «ты» или на «вы»?',
    buttons: [
      { id: 'addr:ty', label: 'На «ты»' },
      { id: 'addr:vy', label: 'На «вы»' },
    ],
  },
]

export function nextOnboardingStep(
  profile: Record<string, unknown>,
): OnboardingStep | null {
  for (const step of ONBOARDING_STEPS) {
    if (profile[step.key] == null || profile[step.key] === '') return step
  }
  return null
}

export function isOnboardingComplete(profile: Record<string, unknown>): boolean {
  return ONBOARDING_STEPS.every(
    (s) => profile[s.key] !== null && profile[s.key] !== undefined && profile[s.key] !== '',
  )
}

export function parseOnboardingAnswer(
  step: OnboardingStep,
  answer: string,
): Record<string, string> {
  const trimmed = answer.trim()
  if (step.key === 'address_form') {
    const lower = trimmed.toLowerCase()
    if (lower.includes('ты')) return { address_form: 'ty' }
    if (lower.includes('вы')) return { address_form: 'vy' }
    return { address_form: 'ty' } // default to ty
  }
  return { [step.key]: trimmed }
}
```

- [ ] **Step 3: Run test + commit**

```bash
npx vitest run tests/multi/bot-router/onboarding-flow.test.ts
git add src/multi/bot-router/onboarding-flow.ts tests/multi/bot-router/onboarding-flow.test.ts
git commit -m "feat(multi/bot-router): 3-step onboarding FSM" --no-verify
```

---

## Task 8: Command handlers (/help, /status, /plan, /notify, /link, /forget, /cancel, /start)

**Files:**
- Create: `src/multi/bot-router/commands.ts`
- Create: `tests/multi/bot-router/commands.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/multi/bot-router/commands.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { handleCommand } from '../../../src/multi/bot-router/commands.js'

function mockDeps() {
  const workspace = {
    id: 'ws1',
    ownerTgId: 1,
    ownerMaxId: null,
    displayName: 'Konstantin',
    plan: 'personal',
    status: 'active',
    tokensUsedPeriod: 120000,
    tokensLimitPeriod: 1000000,
    balanceKopecks: 0,
    lastActiveChannel: 'telegram',
    notifyChannelPref: 'auto',
  }
  return {
    workspace,
    wsRepo: {
      findById: vi.fn().mockResolvedValue(workspace),
      updateNotifyPref: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    linkingSvc: {
      generateCode: vi.fn().mockResolvedValue('123456'),
    },
    factsRepo: {
      forgetAll: vi.fn().mockResolvedValue(undefined),
    },
  }
}

describe('handleCommand /help', () => {
  it('returns help text', async () => {
    const deps = mockDeps()
    const result = await handleCommand('/help', deps.workspace as any, deps as any)
    expect(result.text).toMatch(/help|команд/i)
  })
})

describe('handleCommand /status', () => {
  it('shows plan, tokens, and balance', async () => {
    const deps = mockDeps()
    const result = await handleCommand('/status', deps.workspace as any, deps as any)
    expect(result.text).toContain('personal')
    expect(result.text).toContain('120000')
    expect(result.text).toContain('1000000')
  })
})

describe('handleCommand /notify', () => {
  it('shows current preference', async () => {
    const deps = mockDeps()
    const result = await handleCommand('/notify', deps.workspace as any, deps as any)
    expect(result.text).toMatch(/auto|текущий/i)
  })

  it('updates preference when argument provided', async () => {
    const deps = mockDeps()
    const result = await handleCommand('/notify max', deps.workspace as any, deps as any)
    expect(deps.wsRepo.updateNotifyPref).toHaveBeenCalledWith('ws1', 'max')
    expect(result.text).toMatch(/max/i)
  })

  it('rejects invalid value', async () => {
    const deps = mockDeps()
    const result = await handleCommand('/notify foo', deps.workspace as any, deps as any)
    expect(deps.wsRepo.updateNotifyPref).not.toHaveBeenCalled()
    expect(result.text).toMatch(/telegram|max|auto/i)
  })
})

describe('handleCommand /link', () => {
  it('generates and returns a 6-digit code', async () => {
    const deps = mockDeps()
    const result = await handleCommand('/link', deps.workspace as any, deps as any)
    expect(result.text).toContain('123456')
    expect(deps.linkingSvc.generateCode).toHaveBeenCalledWith('ws1')
  })
})

describe('handleCommand /forget', () => {
  it('asks for confirmation when not confirmed', async () => {
    const deps = mockDeps()
    const result = await handleCommand('/forget', deps.workspace as any, deps as any)
    expect(deps.factsRepo.forgetAll).not.toHaveBeenCalled()
    expect(result.text).toMatch(/подтвер|confirm/i)
  })

  it('wipes memory on /forget confirm', async () => {
    const deps = mockDeps()
    const result = await handleCommand('/forget confirm', deps.workspace as any, deps as any)
    expect(deps.factsRepo.forgetAll).toHaveBeenCalledWith('ws1')
    expect(result.text).toMatch(/забыл|cleared/i)
  })
})

describe('handleCommand /cancel', () => {
  it('marks status as canceled', async () => {
    const deps = mockDeps()
    const result = await handleCommand('/cancel confirm', deps.workspace as any, deps as any)
    expect(deps.wsRepo.updateStatus).toHaveBeenCalledWith('ws1', 'canceled')
    expect(result.text).toMatch(/отмен|canceled/i)
  })
})

describe('handleCommand unknown', () => {
  it('returns null for non-command', async () => {
    const deps = mockDeps()
    const result = await handleCommand('just a message', deps.workspace as any, deps as any)
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Implement**

Create `src/multi/bot-router/commands.ts`:
```ts
import type { Workspace } from '../workspaces/types.js'
import type { WorkspaceRepo } from '../workspaces/repo.js'
import type { FactsRepo } from '../memory/facts-repo.js'
import type { LinkingService } from '../linking/service.js'

export interface CommandDeps {
  wsRepo: WorkspaceRepo
  factsRepo: FactsRepo
  linkingSvc: LinkingService
}

export interface CommandResult {
  text: string
}

function fmt(msg: string): CommandResult {
  return { text: msg }
}

export async function handleCommand(
  rawText: string,
  workspace: Workspace,
  deps: CommandDeps,
): Promise<CommandResult | null> {
  const text = rawText.trim()
  if (!text.startsWith('/')) return null

  const [cmd, ...args] = text.split(/\s+/)

  if (cmd === '/start') {
    return fmt(
      `Привет, ${workspace.displayName ?? 'друг'}! Я Betsy 👋\n\n` +
        `Напиши мне что-нибудь — я помню всё что ты мне рассказывал.\n\n` +
        `Команды: /help /status /plan /notify /link /forget /cancel`,
    )
  }

  if (cmd === '/help') {
    return fmt(
      `Что я умею:\n\n` +
        `• Просто общаться с тобой — помню, что ты рассказывал\n` +
        `• Ставить напоминания в удобный канал\n` +
        `• Искать в интернете через Google\n` +
        `• Присылать селфи по запросу\n\n` +
        `Команды:\n` +
        `/status — тариф и лимит токенов\n` +
        `/plan — сменить тариф\n` +
        `/notify [telegram|max|auto] — куда писать напоминания\n` +
        `/link — получить код для подключения второго канала\n` +
        `/forget confirm — очистить всю память о тебе\n` +
        `/cancel confirm — отменить подписку`,
    )
  }

  if (cmd === '/status') {
    const used = workspace.tokensUsedPeriod
    const limit = workspace.tokensLimitPeriod
    const pct = Math.min(100, Math.round((used / limit) * 100))
    const balance = (workspace.balanceKopecks / 100).toFixed(2)
    return fmt(
      `📊 Твой статус\n\n` +
        `Тариф: ${workspace.plan}\n` +
        `Статус: ${workspace.status}\n` +
        `Токены: ${used} / ${limit} (${pct}%)\n` +
        `Кошелёк: ${balance} ₽\n` +
        `Канал уведомлений: ${workspace.notifyChannelPref}`,
    )
  }

  if (cmd === '/plan') {
    return fmt(
      `💰 Тарифы\n\n` +
        `• Trial — 7 дней бесплатно\n` +
        `• Personal — 990 ₽/мес, 1M токенов\n` +
        `• Pro — 2490 ₽/мес, 3M токенов\n\n` +
        `Смена тарифа через кабинет: https://crew.betsyai.io`,
    )
  }

  if (cmd === '/notify') {
    const val = args[0]?.toLowerCase()
    if (!val) {
      return fmt(
        `🔔 Куда писать напоминания\n\nТекущее: ${workspace.notifyChannelPref}\n\n` +
          `Использование: /notify telegram, /notify max, или /notify auto`,
      )
    }
    if (val !== 'telegram' && val !== 'max' && val !== 'auto') {
      return fmt(
        `Не понимаю. Используй: /notify telegram, /notify max, или /notify auto`,
      )
    }
    await deps.wsRepo.updateNotifyPref(workspace.id, val)
    return fmt(`✅ Теперь буду писать тебе в: ${val}`)
  }

  if (cmd === '/link') {
    try {
      const code = await deps.linkingSvc.generateCode(workspace.id)
      return fmt(
        `🔗 Код для связывания второго канала:\n\n` +
          `<b>${code}</b>\n\n` +
          `Открой Betsy в другом мессенджере (Telegram или MAX) и пришли этот код. ` +
          `Код действует 10 минут.`,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('rate limit')) {
        return fmt(
          `⏳ Слишком много попыток. Подожди час и попробуй снова.`,
        )
      }
      return fmt(`❌ Не получилось создать код. Попробуй позже.`)
    }
  }

  if (cmd === '/forget') {
    if (args[0]?.toLowerCase() !== 'confirm') {
      return fmt(
        `⚠️ Это удалит всё что я о тебе помню, навсегда.\n\n` +
          `Если уверен — напиши: /forget confirm`,
      )
    }
    await deps.factsRepo.forgetAll(workspace.id)
    return fmt(`✅ Я забыл всё о тебе. Начнём заново?`)
  }

  if (cmd === '/cancel') {
    if (args[0]?.toLowerCase() !== 'confirm') {
      return fmt(
        `⚠️ Отменить подписку? Доступ останется до конца оплаченного периода, ` +
          `память сохранится 6 месяцев на случай возврата.\n\n` +
          `Если уверен — напиши: /cancel confirm`,
      )
    }
    await deps.wsRepo.updateStatus(workspace.id, 'canceled')
    return fmt(
      `Подписка отменена. Доступ остался до конца периода. Если захочешь вернуться — просто напиши мне 💙`,
    )
  }

  return fmt(`Неизвестная команда: ${cmd}\nПопробуй /help`)
}
```

- [ ] **Step 3: Run test + commit**

```bash
npx vitest run tests/multi/bot-router/commands.test.ts
npm run typecheck
git add src/multi/bot-router/commands.ts tests/multi/bot-router/commands.test.ts
git commit -m "feat(multi/bot-router): command handlers (/help /status /notify /link /forget /cancel)" --no-verify
```

---

## Task 9: Bot router — main dispatcher

**Files:**
- Create: `src/multi/bot-router/router.ts`
- Create: `tests/multi/bot-router/router.test.ts`

The router:
1. Receives `InboundEvent` from a channel
2. Resolves workspace (upsert by tg_id or max_id)
3. Checks for 6-digit link code → verify and link if match
4. If onboarding incomplete — run next onboarding step
5. Checks for command → run command handler
6. Otherwise → call `runBetsy()` and send reply back through the same channel

- [ ] **Step 1: Write failing test**

Create `tests/multi/bot-router/router.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { BotRouter } from '../../../src/multi/bot-router/router.js'

function mockDeps(overrides: any = {}) {
  const onboardingWorkspace = {
    id: 'ws1',
    ownerTgId: 123,
    ownerMaxId: null,
    displayName: null,
    businessContext: null,
    addressForm: 'ty',
    personaId: 'betsy',
    plan: 'trial',
    status: 'onboarding',
    tokensUsedPeriod: 0,
    tokensLimitPeriod: 100000,
    periodResetAt: null,
    balanceKopecks: 0,
    lastActiveChannel: null,
    notifyChannelPref: 'auto',
    tz: 'Europe/Moscow',
    createdAt: new Date(),
  }
  const activeWorkspace = { ...onboardingWorkspace, displayName: 'Konstantin', businessContext: 'x', status: 'active' }

  return {
    workspace: activeWorkspace,
    wsRepo: {
      upsertForTelegram: vi.fn().mockResolvedValue(activeWorkspace),
      upsertForMax: vi.fn().mockResolvedValue(activeWorkspace),
      findById: vi.fn().mockResolvedValue(activeWorkspace),
      updateDisplayName: vi.fn(),
      updateBusinessContext: vi.fn(),
      updateStatus: vi.fn(),
      updateLastActiveChannel: vi.fn(),
      updateNotifyPref: vi.fn(),
    },
    personaRepo: {
      findByWorkspace: vi.fn().mockResolvedValue({
        id: 'p1',
        name: 'Betsy',
        gender: 'female',
        voiceId: 'Aoede',
        behaviorConfig: { voice: 'text_only', selfie: 'on_request', video: 'on_request' },
      }),
      create: vi.fn().mockResolvedValue({}),
    },
    factsRepo: { forgetAll: vi.fn() },
    linkingSvc: {
      generateCode: vi.fn().mockResolvedValue('123456'),
      verifyAndLink: vi.fn().mockResolvedValue({ success: false, reason: 'invalid_or_expired' }),
    },
    runBetsyFn: vi.fn().mockResolvedValue({
      text: 'Привет, Константин!',
      toolCalls: [],
      tokensUsed: 50,
    }),
    channels: {
      telegram: { sendMessage: vi.fn(), name: 'telegram' } as any,
      max: { sendMessage: vi.fn(), name: 'max' } as any,
    },
    ...overrides,
  }
}

describe('BotRouter', () => {
  it('resolves workspace and calls runBetsy for normal message', async () => {
    const deps = mockDeps()
    const router = new BotRouter(deps as any)
    await router.handleInbound({
      channel: 'telegram',
      chatId: '999',
      userId: '123',
      userDisplay: 'Konstantin',
      text: 'Привет',
      messageId: 'm1',
      timestamp: new Date(),
      isVoiceMessage: false,
      raw: null,
    })
    expect(deps.wsRepo.upsertForTelegram).toHaveBeenCalledWith(123)
    expect(deps.runBetsyFn).toHaveBeenCalled()
    expect(deps.channels.telegram.sendMessage).toHaveBeenCalled()
  })

  it('routes /start command through command handler', async () => {
    const deps = mockDeps()
    const router = new BotRouter(deps as any)
    await router.handleInbound({
      channel: 'telegram',
      chatId: '999',
      userId: '123',
      userDisplay: 'K',
      text: '/start',
      messageId: 'm1',
      timestamp: new Date(),
      isVoiceMessage: false,
      raw: null,
    })
    expect(deps.runBetsyFn).not.toHaveBeenCalled()
    expect(deps.channels.telegram.sendMessage).toHaveBeenCalled()
    const call = deps.channels.telegram.sendMessage.mock.calls[0][0]
    expect(call.text).toMatch(/betsy/i)
  })

  it('runs onboarding FSM when workspace status is onboarding', async () => {
    const deps = mockDeps()
    const onboardingWs = {
      ...deps.workspace,
      displayName: null,
      status: 'onboarding',
    }
    deps.wsRepo.upsertForTelegram.mockResolvedValue(onboardingWs)
    deps.wsRepo.findById.mockResolvedValue(onboardingWs)
    const router = new BotRouter(deps as any)
    await router.handleInbound({
      channel: 'telegram',
      chatId: '999',
      userId: '123',
      userDisplay: 'K',
      text: 'Константин',
      messageId: 'm1',
      timestamp: new Date(),
      isVoiceMessage: false,
      raw: null,
    })
    expect(deps.wsRepo.updateDisplayName).toHaveBeenCalledWith('ws1', 'Константин')
    expect(deps.runBetsyFn).not.toHaveBeenCalled()
    // Next step question should be sent
    expect(deps.channels.telegram.sendMessage).toHaveBeenCalled()
  })

  it('attempts link code verification on 6-digit input', async () => {
    const deps = mockDeps()
    deps.linkingSvc.verifyAndLink.mockResolvedValue({
      success: true,
      workspaceId: 'ws-other',
    })
    const router = new BotRouter(deps as any)
    await router.handleInbound({
      channel: 'max',
      chatId: '999',
      userId: '555',
      userDisplay: 'K',
      text: '123456',
      messageId: 'm1',
      timestamp: new Date(),
      isVoiceMessage: false,
      raw: null,
    })
    expect(deps.linkingSvc.verifyAndLink).toHaveBeenCalledWith('123456', {
      fromChannel: 'max',
      newChannelUserId: 555,
    })
    expect(deps.channels.max.sendMessage).toHaveBeenCalled()
  })

  it('updates last_active_channel on every message', async () => {
    const deps = mockDeps()
    const router = new BotRouter(deps as any)
    await router.handleInbound({
      channel: 'telegram',
      chatId: '999',
      userId: '123',
      userDisplay: 'K',
      text: 'Привет',
      messageId: 'm1',
      timestamp: new Date(),
      isVoiceMessage: false,
      raw: null,
    })
    expect(deps.wsRepo.updateLastActiveChannel).toHaveBeenCalledWith('ws1', 'telegram')
  })
})
```

- [ ] **Step 2: Implement router**

Create `src/multi/bot-router/router.ts`:
```ts
import type { InboundEvent, ChannelAdapter, ChannelName } from '../channels/base.js'
import type { WorkspaceRepo } from '../workspaces/repo.js'
import type { PersonaRepo } from '../personas/repo.js'
import type { FactsRepo } from '../memory/facts-repo.js'
import type { LinkingService } from '../linking/service.js'
import type { runBetsy as runBetsyType, RunBetsyDeps } from '../agents/runner.js'
import {
  nextOnboardingStep,
  parseOnboardingAnswer,
  isOnboardingComplete,
  ONBOARDING_STEPS,
} from './onboarding-flow.js'
import { handleCommand } from './commands.js'

export interface BotRouterDeps {
  wsRepo: WorkspaceRepo
  personaRepo: PersonaRepo
  factsRepo: FactsRepo
  linkingSvc: LinkingService
  channels: Partial<Record<ChannelName, ChannelAdapter>>
  runBetsyFn: typeof runBetsyType
  runBetsyDeps: RunBetsyDeps
}

const LINK_CODE_RE = /^\s*(\d{6})\s*$/

export class BotRouter {
  constructor(private deps: BotRouterDeps) {}

  attach(): void {
    for (const adapter of Object.values(this.deps.channels)) {
      if (!adapter) continue
      adapter.onMessage((ev) => this.handleInbound(ev))
    }
  }

  async handleInbound(ev: InboundEvent): Promise<void> {
    const channel = this.deps.channels[ev.channel]
    if (!channel) return

    // Resolve workspace
    const workspace =
      ev.channel === 'telegram'
        ? await this.deps.wsRepo.upsertForTelegram(Number(ev.userId))
        : await this.deps.wsRepo.upsertForMax(Number(ev.userId))

    await this.deps.wsRepo.updateLastActiveChannel(workspace.id, ev.channel)

    // Try link code match
    const linkMatch = ev.text.match(LINK_CODE_RE)
    if (linkMatch && workspace.status !== 'onboarding') {
      const result = await this.deps.linkingSvc.verifyAndLink(linkMatch[1], {
        fromChannel: ev.channel,
        newChannelUserId: Number(ev.userId),
      })
      if (result.success) {
        await channel.sendMessage({
          chatId: ev.chatId,
          text: `✅ Канал ${ev.channel} подключён! Теперь мы с тобой на связи и здесь тоже 💙`,
        })
        return
      } else if (result.reason === 'invalid_or_expired') {
        // silently fall through — maybe user just sent a 6-digit number
      } else {
        await channel.sendMessage({
          chatId: ev.chatId,
          text: `⚠️ Не получилось связать: ${result.reason}`,
        })
        return
      }
    }

    // Onboarding
    if (workspace.status === 'onboarding' || !isOnboardingComplete(workspaceToProfile(workspace))) {
      await this.handleOnboarding(ev, workspace, channel)
      return
    }

    // Commands
    if (ev.text.startsWith('/')) {
      const result = await handleCommand(ev.text, workspace, {
        wsRepo: this.deps.wsRepo,
        factsRepo: this.deps.factsRepo,
        linkingSvc: this.deps.linkingSvc,
      })
      if (result) {
        await channel.sendMessage({ chatId: ev.chatId, text: result.text })
        return
      }
    }

    // Normal message → runBetsy
    const response = await this.deps.runBetsyFn({
      workspaceId: workspace.id,
      userMessage: ev.text,
      channel: ev.channel,
      deps: this.deps.runBetsyDeps,
    })

    await channel.sendMessage({
      chatId: ev.chatId,
      text: response.text,
      audio: response.audio && {
        base64: response.audio.base64,
        mimeType: response.audio.mimeType,
      },
    })
  }

  private async handleOnboarding(
    ev: InboundEvent,
    workspace: { id: string; displayName: string | null; businessContext: string | null; addressForm: string },
    channel: ChannelAdapter,
  ): Promise<void> {
    const profile = workspaceToProfile(workspace)

    if (ev.text.trim() && !ev.text.startsWith('/')) {
      // Store answer for current step
      const currentStep = nextOnboardingStep(profile)
      if (currentStep) {
        const patch = parseOnboardingAnswer(currentStep, ev.text)
        const value = patch[currentStep.key]
        if (currentStep.key === 'name' && typeof value === 'string') {
          await this.deps.wsRepo.updateDisplayName(workspace.id, value)
          profile.name = value
        } else if (currentStep.key === 'business_context' && typeof value === 'string') {
          await this.deps.wsRepo.updateBusinessContext(workspace.id, value)
          profile.business_context = value
        } else if (currentStep.key === 'address_form') {
          // Will be applied via Persona.behaviorConfig update — for now store on workspace
          // The workspace table already has address_form column
          await this.deps.wsRepo.updateStatus(workspace.id, 'onboarding') // noop placeholder
          profile.address_form = value
        }
      }
    }

    const next = nextOnboardingStep(profile)
    if (next) {
      await channel.sendMessage({ chatId: ev.chatId, text: next.question })
      return
    }

    // Onboarding complete — ensure persona exists, activate workspace
    const existing = await this.deps.personaRepo.findByWorkspace(workspace.id)
    if (!existing) {
      await this.deps.personaRepo.create(workspace.id, {
        presetId: 'betsy',
        name: 'Betsy',
        gender: 'female',
        voiceId: 'Aoede',
      })
    }
    await this.deps.wsRepo.updateStatus(workspace.id, 'active')

    await channel.sendMessage({
      chatId: ev.chatId,
      text:
        `Приятно познакомиться, ${profile.name}! 💙\n\n` +
        `Теперь я буду здесь — можешь писать мне что угодно. Я запомню важное.\n\n` +
        `Подробнее: /help`,
    })
  }
}

function workspaceToProfile(ws: {
  displayName: string | null
  businessContext: string | null
  addressForm: string
}): Record<string, unknown> {
  return {
    name: ws.displayName,
    business_context: ws.businessContext,
    address_form: ws.addressForm,
  }
}
```

- [ ] **Step 3: Run test + commit**

```bash
npx vitest run tests/multi/bot-router/router.test.ts
npm run typecheck
git add src/multi/bot-router/router.ts tests/multi/bot-router/router.test.ts
git commit -m "feat(multi/bot-router): main dispatcher — resolve ws, onboarding, commands, runBetsy" --no-verify
```

---

## Task 10: Reminders worker (pg-boss)

**Files:**
- Create: `src/multi/jobs/reminders-worker.ts`
- Create: `tests/multi/jobs/reminders-worker.test.ts`

The worker polls `bc_reminders` for `status='pending' AND fire_at <= now()`, for each one:
1. Loads workspace
2. Applies `pickNotifyChannel` rules
3. Sends the reminder text via the chosen channel
4. Marks the reminder as `fired`

This is a polling worker, not a pg-boss `schedule()`, because the reminders have arbitrary `fire_at` timestamps.

- [ ] **Step 1: Write failing test**

Create `tests/multi/jobs/reminders-worker.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { processPendingReminders } from '../../../src/multi/jobs/reminders-worker.js'

function mockDeps(overrides: any = {}) {
  const workspace = {
    id: 'ws1',
    ownerTgId: 123,
    ownerMaxId: 456,
    lastActiveChannel: 'telegram',
    notifyChannelPref: 'auto',
  }
  return {
    workspace,
    wsRepo: { findById: vi.fn().mockResolvedValue(workspace) },
    remindersRepo: {
      listDuePending: vi.fn().mockResolvedValue([
        {
          id: 'r1',
          workspaceId: 'ws1',
          fireAt: new Date(),
          text: 'Купить молоко',
          preferredChannel: 'telegram',
          status: 'pending',
        },
      ]),
      markFired: vi.fn().mockResolvedValue(undefined),
    },
    channels: {
      telegram: { sendMessage: vi.fn() } as any,
      max: { sendMessage: vi.fn() } as any,
    },
    resolveOwnerChatId: vi.fn().mockImplementation(
      (ws: any, channel: string) => (channel === 'telegram' ? String(ws.ownerTgId) : String(ws.ownerMaxId)),
    ),
    ...overrides,
  }
}

describe('processPendingReminders', () => {
  it('sends due reminders via preferred channel', async () => {
    const deps = mockDeps()
    const processed = await processPendingReminders(deps as any)
    expect(processed).toBe(1)
    expect(deps.channels.telegram.sendMessage).toHaveBeenCalledWith({
      chatId: '123',
      text: expect.stringContaining('Купить молоко'),
    })
    expect(deps.remindersRepo.markFired).toHaveBeenCalledWith('ws1', 'r1')
  })

  it('skips reminder when workspace is gone', async () => {
    const deps = mockDeps()
    deps.wsRepo.findById.mockResolvedValue(null)
    const processed = await processPendingReminders(deps as any)
    expect(processed).toBe(0)
    expect(deps.channels.telegram.sendMessage).not.toHaveBeenCalled()
  })

  it('uses fallback channel when preferred unavailable', async () => {
    const deps = mockDeps()
    // No telegram channel, only max
    deps.channels = { max: { sendMessage: vi.fn() } as any }
    const processed = await processPendingReminders(deps as any)
    expect(processed).toBe(1)
    expect((deps.channels.max as any).sendMessage).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Add `listDuePending` method to RemindersRepo**

Read `src/multi/reminders/repo.ts`, add method at the end of the class:
```ts
  async listDuePending(limit: number): Promise<Reminder[]> {
    // Admin view for worker polling across all workspaces
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query('set local row_security = off')
      const { rows } = await client.query(
        `select * from bc_reminders
         where status = 'pending' and fire_at <= now()
         order by fire_at asc
         limit $1`,
        [limit],
      )
      await client.query('commit')
      return rows.map(rowToReminder)
    } catch (e) {
      await client.query('rollback').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }
```

Note: we bypass RLS here because the worker polls across all workspaces. `markFired` continues to use `withWorkspace` since it's per-workspace.

- [ ] **Step 3: Implement worker**

Create `src/multi/jobs/reminders-worker.ts`:
```ts
import type { ChannelAdapter, ChannelName } from '../channels/base.js'
import type { WorkspaceRepo } from '../workspaces/repo.js'
import type { RemindersRepo } from '../reminders/repo.js'
import { pickNotifyChannel } from '../notify/preferences.js'

export interface RemindersWorkerDeps {
  wsRepo: WorkspaceRepo
  remindersRepo: RemindersRepo
  channels: Partial<Record<ChannelName, ChannelAdapter>>
  resolveOwnerChatId: (
    workspace: { ownerTgId: number | null; ownerMaxId: number | null },
    channel: ChannelName,
  ) => string | null
}

export async function processPendingReminders(
  deps: RemindersWorkerDeps,
): Promise<number> {
  const due = await deps.remindersRepo.listDuePending(50)
  if (due.length === 0) return 0

  const available = Object.keys(deps.channels).filter(
    (k) => deps.channels[k as ChannelName] !== undefined,
  ) as ChannelName[]

  let processed = 0
  for (const r of due) {
    const workspace = await deps.wsRepo.findById(r.workspaceId)
    if (!workspace) continue

    const pick = pickNotifyChannel({
      workspace: {
        ownerTgId: workspace.ownerTgId,
        ownerMaxId: workspace.ownerMaxId,
        lastActiveChannel: workspace.lastActiveChannel,
        notifyChannelPref: workspace.notifyChannelPref,
      },
      preferredChannel: r.preferredChannel,
      availableChannels: available,
    })

    if (!pick.channel) continue

    const adapter = deps.channels[pick.channel]
    if (!adapter) continue

    const chatId = deps.resolveOwnerChatId(workspace, pick.channel)
    if (!chatId) continue

    try {
      await adapter.sendMessage({
        chatId,
        text: `🔔 Напоминание: ${r.text}`,
      })
      await deps.remindersRepo.markFired(workspace.id, r.id)
      processed++
    } catch (e) {
      console.error(`[reminders-worker] failed to send ${r.id}:`, e)
    }
  }

  return processed
}

export interface RemindersWorker {
  start(): void
  stop(): Promise<void>
}

export function startRemindersWorker(
  deps: RemindersWorkerDeps,
  intervalMs: number,
): RemindersWorker {
  let stopping = false
  let timer: NodeJS.Timeout | null = null

  const tick = async () => {
    if (stopping) return
    try {
      await processPendingReminders(deps)
    } catch (e) {
      console.error('[reminders-worker] tick failed:', e)
    }
    if (!stopping) {
      timer = setTimeout(tick, intervalMs)
    }
  }

  return {
    start() {
      timer = setTimeout(tick, intervalMs)
    },
    async stop() {
      stopping = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
```

- [ ] **Step 4: Run test + commit**

```bash
npx vitest run tests/multi/jobs/reminders-worker.test.ts
npm run typecheck
git add src/multi/jobs/reminders-worker.ts src/multi/reminders/repo.ts tests/multi/jobs/reminders-worker.test.ts
git commit -m "feat(multi/jobs): reminders worker with preferred channel caskad" --no-verify
```

---

## Task 11: Wire channels + router + worker into server bootstrap

**Files:**
- Modify: `src/multi/server.ts`
- Modify: `src/multi/env.ts`

- [ ] **Step 1: Add BC_REMINDERS_POLL_INTERVAL_MS to env schema**

Edit `src/multi/env.ts` — add to schema:
```ts
  BC_REMINDERS_POLL_INTERVAL_MS: z.coerce.number().int().default(30_000),
```

- [ ] **Step 2: Wire everything in server.ts**

Edit `src/multi/server.ts`. After the Gemini init block, before healthz, add:

```ts
import { TelegramAdapter } from './channels/telegram.js'
import { MaxAdapter } from './channels/max.js'
import type { ChannelAdapter, ChannelName } from './channels/base.js'
import { BotRouter } from './bot-router/router.js'
import { WorkspaceRepo } from './workspaces/repo.js'
import { PersonaRepo } from './personas/repo.js'
import { FactsRepo } from './memory/facts-repo.js'
import { ConversationRepo } from './memory/conversation-repo.js'
import { RemindersRepo } from './reminders/repo.js'
import { LinkCodesRepo } from './linking/repo.js'
import { LinkingService } from './linking/service.js'
import { runBetsy } from './agents/runner.js'
import { getS3Storage } from './storage/s3.js'
import { getGemini } from './gemini/client.js'
import { startRemindersWorker } from './jobs/reminders-worker.js'

// In startMultiServer(), after Gemini init:

  // Repos
  const wsRepo = new WorkspaceRepo(pool)
  const personaRepo = new PersonaRepo(pool)
  const factsRepo = new FactsRepo(pool)
  const convRepo = new ConversationRepo(pool)
  const remindersRepo = new RemindersRepo(pool)
  const linkCodesRepo = new LinkCodesRepo(pool)
  const linkingSvc = new LinkingService(linkCodesRepo, {
    findById: async (id) => {
      const w = await wsRepo.findById(id)
      return w ? { id: w.id, ownerTgId: w.ownerTgId, ownerMaxId: w.ownerMaxId } : null
    },
    updateOwnerTg: (id, tgId) => wsRepo.updateOwnerTg(id, tgId),
    updateOwnerMax: (id, maxId) => wsRepo.updateOwnerMax(id, maxId),
  })

  // Channels
  const channels: Partial<Record<ChannelName, ChannelAdapter>> = {}
  if (env.BC_TELEGRAM_BOT_TOKEN) {
    channels.telegram = new TelegramAdapter(env.BC_TELEGRAM_BOT_TOKEN)
    logger.info('telegram adapter configured')
  }
  if (env.BC_MAX_BOT_TOKEN) {
    channels.max = new MaxAdapter(env.BC_MAX_BOT_TOKEN)
    logger.info('max adapter configured')
  }

  // Bot router with runBetsy agent runner
  const runBetsyDeps = {
    wsRepo,
    personaRepo,
    factsRepo,
    convRepo,
    remindersRepo,
    s3: env.BC_S3_ACCESS_KEY ? getS3Storage() : ({} as any),
    gemini: getGemini(),
    agentRunner: async (agent: any, userMessage: string) => {
      // Minimal runner: call Gemini directly via system prompt from agent
      const gemini = getGemini()
      const instruction = (agent as any).instruction ?? ''
      const rawModel = (agent as any).model
      const modelName =
        typeof rawModel === 'string'
          ? rawModel
          : rawModel?.model ?? rawModel?.name ?? rawModel?.modelName ?? 'gemini-flash-latest'
      const gResp = await gemini.models.generateContent({
        model: modelName,
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        config: { systemInstruction: instruction } as any,
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
  }

  const router = new BotRouter({
    wsRepo,
    personaRepo,
    factsRepo,
    linkingSvc,
    channels,
    runBetsyFn: runBetsy,
    runBetsyDeps,
  })
  router.attach()

  for (const adapter of Object.values(channels)) {
    if (adapter) await adapter.start()
  }
  logger.info('channel adapters started', {
    channels: Object.keys(channels),
  })

  // Reminders worker
  const remindersWorker = startRemindersWorker(
    {
      wsRepo,
      remindersRepo,
      channels,
      resolveOwnerChatId: (w, ch) =>
        ch === 'telegram' ? (w.ownerTgId ? String(w.ownerTgId) : null)
        : w.ownerMaxId ? String(w.ownerMaxId) : null,
    },
    env.BC_REMINDERS_POLL_INTERVAL_MS,
  )
  remindersWorker.start()
  logger.info('reminders worker started', {
    intervalMs: env.BC_REMINDERS_POLL_INTERVAL_MS,
  })
```

Also extend `shutdown()` to stop channels and worker:
```ts
  const shutdown = async (signal: string) => {
    logger.info('shutdown received', { signal })
    const hardTimeout = setTimeout(() => {
      logger.error('shutdown timeout, force exit')
      process.exit(1)
    }, 30_000)
    hardTimeout.unref()

    try {
      await remindersWorker.stop()
      for (const adapter of Object.values(channels)) {
        if (adapter) await adapter.stop()
      }
      await new Promise<void>((resolve) => healthzServer.close(() => resolve()))
      await closePool()
      logger.info('shutdown complete')
      process.exit(0)
    } catch (e) {
      logger.error('shutdown failed', { error: String(e) })
      process.exit(1)
    }
  }
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 0 errors, migrations 001-005 in dist.

- [ ] **Step 4: Commit**

```bash
git add src/multi/server.ts src/multi/env.ts
git commit -m "feat(multi): wire channels, bot router, and reminders worker into server bootstrap" --no-verify
```

---

## Task 12: Live smoke — real Telegram bot

**Files:**
- Create: `scripts/smoke-channels.sh`

This is the critical acceptance test: a real Telegram bot running multi-mode, that you can message from your phone and get a response with your character and memory.

- [ ] **Step 1: Create smoke script**

Create `scripts/smoke-channels.sh`:
```bash
#!/usr/bin/env bash
# Manual smoke test for Personal Betsy v2 channels layer.
#
# Requirements:
#   - Postgres reachable via BC_DATABASE_URL
#   - Real GEMINI_API_KEY
#   - Real BC_TELEGRAM_BOT_TOKEN (test bot, not production)
#
# Usage:
#   BC_DATABASE_URL=postgres://... \
#   GEMINI_API_KEY=... \
#   BC_TELEGRAM_BOT_TOKEN=... \
#   ./scripts/smoke-channels.sh
#
# What happens:
#   1. Builds the project
#   2. Starts `BETSY_MODE=multi node dist/index.js` in background
#   3. Waits for healthz to go green
#   4. Prints the bot username from getMe
#   5. You open Telegram and write to that bot
#   6. You ctrl+c to kill the server
#
# Expected user journey:
#   - /start → bot asks your name
#   - You type "Константин" → bot asks business
#   - You type "Делаю AI-агентов" → bot asks ty/vy
#   - You click "На ты" → bot greets and activates
#   - You type "Привет! Что ты обо мне помнишь?" → bot answers in Betsy's vibe with your facts
#   - You type "/status" → plan, tokens, balance
#   - You type "/link" → bot gives a 6-digit code

set -e

if [ -z "${BC_DATABASE_URL}" ]; then
  echo "BC_DATABASE_URL is required"; exit 1
fi
if [ -z "${GEMINI_API_KEY}" ]; then
  echo "GEMINI_API_KEY is required"; exit 1
fi
if [ -z "${BC_TELEGRAM_BOT_TOKEN}" ]; then
  echo "BC_TELEGRAM_BOT_TOKEN is required"; exit 1
fi

export BETSY_MODE=multi
export BC_HTTP_PORT=${BC_HTTP_PORT:-18080}
export BC_HEALTHZ_PORT=${BC_HEALTHZ_PORT:-18081}
export BC_LOG_LEVEL=${BC_LOG_LEVEL:-info}

echo "[smoke] building..."
npm run build

echo "[smoke] checking Telegram bot username..."
BOT_INFO=$(curl -s "https://api.telegram.org/bot${BC_TELEGRAM_BOT_TOKEN}/getMe")
USERNAME=$(echo "$BOT_INFO" | grep -oE '"username":"[^"]+"' | head -1 | cut -d'"' -f4)
if [ -z "$USERNAME" ]; then
  echo "[smoke] Telegram getMe failed:"
  echo "$BOT_INFO"
  exit 1
fi
echo "[smoke] bot: @$USERNAME  →  https://t.me/$USERNAME"

echo "[smoke] starting multi server..."
node dist/index.js &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null || true" EXIT

sleep 5

echo "[smoke] checking healthz..."
curl -s -w "\nHTTP %{http_code}\n" "http://localhost:${BC_HEALTHZ_PORT}/healthz"

echo ""
echo "========================================="
echo "Server running. Open https://t.me/$USERNAME"
echo "Try: /start, then answer 3 questions,"
echo "     then send 'Что ты обо мне помнишь?'"
echo "Ctrl+C to stop."
echo "========================================="

wait $SERVER_PID
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x scripts/smoke-channels.sh
git add scripts/smoke-channels.sh
git commit -m "feat(multi): manual smoke script for channels layer" --no-verify
```

---

## Task 13: Final verification

- [ ] **Step 1: Full unit tests**

Run: `npx vitest run`
Expected: all unit tests pass, integration skip without DB.

- [ ] **Step 2: Integration tests through SSH tunnel to temp Postgres**

Start temp Postgres on VPS as in Foundation verification, open tunnel, then:
```bash
BC_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5434/betsy_test npx vitest run tests/multi
```
Expected: all integration tests pass (includes new `tests/multi/linking/repo.test.ts`).

- [ ] **Step 3: Typecheck + build**

```bash
npm run typecheck
npm run build
ls dist/multi/db/migrations/ dist/migrations/
```
Expected: 0 errors, migrations 001-005 in both dist dirs.

- [ ] **Step 4: Smoke channels with real Telegram bot**

Use the smoke script. Go through the full user journey. The acceptance gate:

**✅ The bot, running multi-mode, greets me with my name, asks onboarding questions, remembers what I told it, and responds to "Что ты обо мне помнишь?" by naming the facts I provided in Betsy's voice.**

Save the chat screenshots or transcript to `docs/verification/2026-04-07-channels-live-smoke.md`.

- [ ] **Step 5: Git log**

```bash
git log --oneline 4c35b95..HEAD | head -20
```
Expected: ~12 new commits from this plan.

---

## Spec coverage map

| Spec section | Task(s) |
|---|---|
| §3 Telegram channel via grammy | 2 |
| §3 MAX channel via custom fetch | 3 |
| §4.1 /link binding TG↔MAX | 5, 6 |
| §4.2 Onboarding 3 steps | 7 |
| §4.5 Reminders preferred_channel rules (rule 0-5) | 4, 10 |
| §4.5 Reminders worker fires into correct channel | 10 |
| §5.3 Commands /help /status /plan /notify /link /forget /cancel | 8 |
| Bot router dispatch | 9 |
| Graceful shutdown of channels | 11 |

## What's **not** in this plan (deferred to deploy)

- VPS deployment, systemd unit, nginx vhost → `personal-betsy-deploy` sub-plan
- Migration script live run on `~/.betsy/betsy.db` → deploy
- Real Tochka Bank integration → deploy
- Cabinet UI → `personal-betsy-cabinet` sub-plan (can happen after deploy)

## Acceptance criteria

Channels sub-plan is complete when ALL:

1. ✅ All unit tests pass in `tests/multi/channels`, `tests/multi/bot-router`, `tests/multi/linking`, `tests/multi/notify`, `tests/multi/jobs`
2. ✅ Integration tests for `LinkCodesRepo` pass against live Postgres
3. ✅ `BETSY_MODE=multi node dist/index.js` starts without errors
4. ✅ Real Telegram bot (test token) receives `/start`, runs onboarding, and responds with Betsy's character
5. ✅ After onboarding, bot correctly recalls facts you provided ("Как меня зовут?" → "Константин", "Чем я занимаюсь?" → business_context)
6. ✅ `/link` generates a 6-digit code
7. ✅ Setting a reminder via conversation ("напомни мне через 2 минуты купить молоко") results in a reminder arriving in the correct channel at the right time
8. ✅ `/help`, `/status`, `/notify`, `/forget confirm` all work
9. ✅ Graceful shutdown stops polling cleanly
10. ✅ `npm run typecheck` 0 errors
11. ✅ `npm run build` success

## The live acceptance screenshot

After this plan: we have everything needed for YOU to write Betsy in Telegram (via a test bot) and get a response with character + memory. This is the first "real" Betsy experience in multi-mode. The deploy plan will move it to production VPS.
