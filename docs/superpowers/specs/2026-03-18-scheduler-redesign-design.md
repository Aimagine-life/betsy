# Scheduler Redesign — Proactive Messaging & Reminders

**Date:** 2026-03-18
**Status:** Approved

## Problem

Betsy's scheduler tool creates cron tasks in memory, but `onTaskFire` callback is never connected — tasks fire into the void. No support for one-time reminders ("напиши через 5 минут"), no persistence across restarts.

## Decisions

| Question | Answer |
|----------|--------|
| What happens on fire? | LLM agent turn (engine.process) — always |
| Where to deliver? | Same channel the request came from |
| Persistence? | SQLite (better-sqlite3, already in project) |
| Missed tasks on restart? | Execute missed one-shot, skip recurring |
| Conversation context? | Save last 10 messages (max 700 chars total) with task |

## Approach

**Approach A: Extend current scheduler.** Minimal changes, no new modules. Add 3 schedule types, SQLite store, and callback integration in index.ts. ~250-350 lines total.

Rejected alternatives:
- **B (Separate CronService module):** Overengineering for Betsy's scale (~5K LOC project)
- **C (setTimeout for at/every):** Two mechanisms, harder to manage state

## Data Model

### Schedule Types

```typescript
type Schedule =
  | { kind: "at"; at: number }         // Unix timestamp ms — one-time
  | { kind: "every"; everyMs: number } // Interval in ms — recurring
  | { kind: "cron"; expr: string }     // Cron 5-field — recurring

interface ScheduledTask {
  id: string;                    // uuid
  name: string;                  // human-readable name
  schedule: Schedule;
  command: string;               // prompt for LLM
  context: string;               // last chat messages at creation time
  channel: string;               // "telegram" | "browser"
  chatId: string;                // delivery target
  nextRunAt: number;             // Unix timestamp ms
  lastRunAt: number | null;
  createdAt: number;
}
```

### SQLite Table

`scheduled_tasks` — all fields above, `schedule` stored as JSON string. Loaded on startup, `nextRunAt` recalculated.

### Lifecycle

- **`at`:** one-shot, deleted from DB after firing (derived from `schedule.kind === "at"`)
- **`every`:** `nextRunAt += everyMs` after each fire, updated in DB. Stopped only via explicit `remove`.
- **`cron`:** `nextRunAt` recalculated via cron parser

### Task Name Uniqueness

`name` must be unique. `action: "remove"` works by `name`. `id` (uuid) is the primary key in SQLite but not exposed to the LLM.

## Ticker

- `setInterval` every 30 seconds (down from 60)
- Checks `nextRunAt <= Date.now()` for all tasks
- **Before** calling the async callback: immediately update `nextRunAt` in DB (or delete for `at` tasks) to prevent double-fire if callback takes longer than 30s
- Then calls registered `onTaskFire(task)` callback asynchronously
- `at` tasks may fire up to 30s late — acceptable for the use case

## Startup Recovery

1. Load all tasks from SQLite
2. Find missed one-shot tasks (`nextRunAt < now`)
3. Execute them with 3s delay between each
4. For recurring — recalculate `nextRunAt` to future, skip execution

## Tool API

Extends existing `scheduler` tool. Backward compatible — `cron_expression` without `schedule_type` defaults to `kind: "cron"`.

### Parameters

```
action: "add" | "remove" | "list"
name: string
schedule_type: "at" | "every" | "cron"    // default "cron"
cron_expression: string                    // for type="cron"
at: string                                 // for type="at" — ISO datetime or "+5m", "+2h"
every: string                              // for type="every" — "5m", "1h", "30s"
command: string                            // LLM prompt
```

### Relative Time Parsing

`at` accepts: `"+5m"`, `"+2h30m"`, `"+1d"`, or ISO string `"2026-03-18T15:30:00"` (parsed as local server time).
`every` accepts: `"30s"`, `"5m"`, `"2h"`, `"1d"`.

Note: All times use server-local timezone (same as current cron parser which uses `getHours()`). Betsy is a single-owner bot, so server timezone matches owner timezone.

### Automatic Fields

`channel` and `chatId` are NOT passed by LLM — injected automatically via **mutable setter** on the scheduler tool instance. The tool exposes `setMessageContext(channel, chatId, messages)` which the engine calls before each tool execution round. This avoids changing the `Tool` interface or re-creating the tool per message.

### Example Calls

```
"напиши через 5 минут"
→ {action: "add", schedule_type: "at", at: "+5m", name: "reminder", command: "Напомни владельцу"}

"каждый день в 20:00 делай сводку"
→ {action: "add", schedule_type: "cron", cron_expression: "0 20 * * *", name: "daily-summary", command: "Сделай сводку дня"}

"проверяй сайт каждые 30 минут"
→ {action: "add", schedule_type: "every", every: "30m", name: "site-check", command: "Проверь доступность сайта"}
```

## Integration in index.ts

```
1. Init SQLite store for scheduler
2. Create scheduler with store
3. Register scheduler tool (wraps scheduler instance)
4. Save channels in Map for delivery
5. Connect onTaskFire callback:
   - Build reminder prompt (command + context)
   - engine.process() with prompt
   - channel.send(chatId, result)
6. Start ticker + process missed one-shot tasks
```

Scheduler tool becomes a thin wrapper over scheduler instance (owns SQLite store + ticker), instead of standalone object with internal Map.

### engine.process() for scheduled tasks

When a task fires, the callback constructs an `IncomingMessage`:
```typescript
{
  channelName: task.channel,
  userId: task.chatId,      // same user who created the task
  text: reminderPrompt,     // built from command + context
  timestamp: Date.now(),
  metadata: { scheduledTask: true }
}
```
This means the scheduled response shares conversation history with the user — the bot knows who it's talking to.

### Channel delivery

The `onTaskFire` callback looks up the channel by `task.channel` from a `Map<string, { send(userId: string, msg: OutgoingMessage): Promise<void> }>`. Currently only `TelegramChannel` implements `send()`. Browser (WebSocket) delivery is best-effort — if the user is not connected, the message is lost. This is acceptable — primary use case is Telegram.

### Conversation context capture

Context is captured at task creation time from the mutable setter's `messages` array:
- Includes both user and assistant messages (most recent first)
- Format: plain text, one line per message: `"user: ...\nassistant: ..."`
- Truncation: take the most recent messages that fit within 700 chars total, drop older ones
- Stored as a single string in the `context` field

## Prompt Changes

Expand scheduler description in system prompt:

```
scheduler — планировщик задач (напоминания, повторяющиеся задачи).
  schedule_type="at" + at="+5m" для одноразовых,
  schedule_type="every" + every="30m" для интервалов,
  schedule_type="cron" + cron_expression="0 20 * * *" для расписаний.
  Когда владелец просит "напомни", "напиши через", "каждый день" — используй scheduler.
```

Prompt on task fire (passed to engine.process):

```
Сработало запланированное задание "{task.name}".
Задача: {task.command}

Контекст разговора при создании задачи:
{task.context}

Напиши владельцу сообщение в связи с этой задачей.
```

## Files Changed

| File | Change |
|------|--------|
| `src/core/tools/scheduler.ts` | Extend types, SQLite store, 3 schedule types, ticker |
| `src/index.ts` | Init store, onTaskFire callback, startup recovery |
| `src/core/prompt.ts` | Expand scheduler tool description |
| `src/core/tools/types.ts` | No changes — context passed via mutable setter on scheduler tool |

## What Stays the Same

- Engine — no changes, process() called as usual
- TelegramChannel — no changes, existing send() used
- Cron parser — stays, used for kind: "cron"
- Tool interface — execute(params) signature preserved, no changes to types.ts
- Telegram message handlers — untouched
- All other tools — untouched

## References

- **OpenClaw** (`/tmp/openclaw/src/cron/`): 3 schedule types (at/every/cron), isolated agent execution, multi-channel delivery, session management. We take the schedule type model and simplify everything else.
- **CashClaw** (`/tmp/cashclaw/src/heartbeat.ts`): Background polling loop, no reminder system. Not directly applicable.
