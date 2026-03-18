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
| Conversation context? | Save last 10 messages (max 700 chars) with task |

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
  oneShot: boolean;              // true for "at", false for "every"/"cron"
  createdAt: number;
}
```

### SQLite Table

`scheduled_tasks` — all fields above, `schedule` stored as JSON string. Loaded on startup, `nextRunAt` recalculated.

### Lifecycle

- **`at`:** `oneShot: true`, deleted from DB after firing
- **`every`:** `nextRunAt += everyMs` after each fire, updated in DB
- **`cron`:** `nextRunAt` recalculated via cron parser

## Ticker

- `setInterval` every 30 seconds (down from 60)
- Checks `nextRunAt <= Date.now()` for all tasks
- Calls registered `onTaskFire(task)` callback
- After fire: updates or deletes task in DB depending on type

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

`at` accepts: `"+5m"`, `"+2h30m"`, `"+1d"`, or ISO string `"2026-03-18T15:30:00"`.
`every` accepts: `"30s"`, `"5m"`, `"2h"`, `"1d"`.

### Automatic Fields

`channel` and `chatId` are NOT passed by LLM — injected automatically from incoming message metadata.

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

Context passed to tool via closure at creation time (channel, chatId from current message).

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
| `src/core/tools/types.ts` | Possibly add metadata to execute() for channel/chatId |

## What Stays the Same

- Engine — no changes, process() called as usual
- TelegramChannel — no changes, existing send() used
- Cron parser — stays, used for kind: "cron"
- Tool interface — execute(params) signature preserved
- Telegram message handlers — untouched
- All other tools — untouched

## References

- **OpenClaw** (`/tmp/openclaw/src/cron/`): 3 schedule types (at/every/cron), isolated agent execution, multi-channel delivery, session management. We take the schedule type model and simplify everything else.
- **CashClaw** (`/tmp/cashclaw/src/heartbeat.ts`): Background polling loop, no reminder system. Not directly applicable.
