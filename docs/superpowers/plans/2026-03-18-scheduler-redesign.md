# Scheduler Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Betsy's scheduler to support 3 schedule types (at/every/cron), SQLite persistence, and proactive message delivery via LLM agent turns.

**Architecture:** Replace in-memory Map with SQLite-backed store. Single 30s ticker checks `nextRunAt`. On fire: update DB first (prevent double-fire), then run `engine.process()` and deliver via the originating channel. Mutable setter injects message context (channel, chatId, recent messages) into the scheduler tool.

**Tech Stack:** TypeScript, better-sqlite3 (existing), vitest (existing), grammy (existing)

**Spec:** `docs/superpowers/specs/2026-03-18-scheduler-redesign-design.md`

---

### Task 1: SQLite Store — Schema and CRUD

**Files:**
- Create: `src/core/tools/scheduler-store.ts`
- Test: `test/core/tools/scheduler-store.test.ts`

- [ ] **Step 1: Write failing test for store init and add**

```typescript
// test/core/tools/scheduler-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SchedulerStore } from "../../../src/core/tools/scheduler-store.js";
import Database from "better-sqlite3";

let db: Database.Database;
let store: SchedulerStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SchedulerStore(db);
  store.init();
});

afterEach(() => {
  db.close();
});

describe("SchedulerStore", () => {
  it("creates table and adds a task", () => {
    const task = {
      id: "test-1",
      name: "reminder",
      schedule: JSON.stringify({ kind: "at", at: Date.now() + 300_000 }),
      command: "Напомни",
      context: "user: привет",
      channel: "telegram",
      chatId: "123",
      nextRunAt: Date.now() + 300_000,
      lastRunAt: null,
      createdAt: Date.now(),
    };
    store.add(task);
    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("reminder");
  });

  it("removes a task by name", () => {
    store.add({
      id: "test-2", name: "to-remove",
      schedule: JSON.stringify({ kind: "at", at: Date.now() + 60_000 }),
      command: "test", context: "", channel: "telegram",
      chatId: "123", nextRunAt: Date.now() + 60_000, lastRunAt: null, createdAt: Date.now(),
    });
    expect(store.removeByName("to-remove")).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it("returns false when removing non-existent task", () => {
    expect(store.removeByName("nope")).toBe(false);
  });

  it("finds due tasks", () => {
    const now = Date.now();
    store.add({
      id: "due", name: "due-task",
      schedule: JSON.stringify({ kind: "at", at: now - 1000 }),
      command: "fire", context: "", channel: "telegram",
      chatId: "1", nextRunAt: now - 1000, lastRunAt: null, createdAt: now,
    });
    store.add({
      id: "future", name: "future-task",
      schedule: JSON.stringify({ kind: "at", at: now + 600_000 }),
      command: "later", context: "", channel: "telegram",
      chatId: "1", nextRunAt: now + 600_000, lastRunAt: null, createdAt: now,
    });
    const due = store.getDue(now);
    expect(due).toHaveLength(1);
    expect(due[0].name).toBe("due-task");
  });

  it("updates nextRunAt", () => {
    const now = Date.now();
    store.add({
      id: "upd", name: "updatable",
      schedule: JSON.stringify({ kind: "every", everyMs: 60_000 }),
      command: "repeat", context: "", channel: "telegram",
      chatId: "1", nextRunAt: now, lastRunAt: null, createdAt: now,
    });
    store.updateNextRun("upd", now + 60_000, now);
    const tasks = store.list();
    expect(tasks[0].nextRunAt).toBe(now + 60_000);
    expect(tasks[0].lastRunAt).toBe(now);
  });

  it("deletes a task by id", () => {
    store.add({
      id: "del", name: "deletable",
      schedule: JSON.stringify({ kind: "at", at: Date.now() }),
      command: "x", context: "", channel: "telegram",
      chatId: "1", nextRunAt: Date.now(), lastRunAt: null, createdAt: Date.now(),
    });
    store.deleteById("del");
    expect(store.list()).toHaveLength(0);
  });

  it("enforces unique name", () => {
    const base = {
      schedule: JSON.stringify({ kind: "at", at: Date.now() }),
      command: "x", context: "", channel: "telegram",
      chatId: "1", nextRunAt: Date.now(), lastRunAt: null, createdAt: Date.now(),
    };
    store.add({ ...base, id: "a", name: "same" });
    expect(() => store.add({ ...base, id: "b", name: "same" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/tools/scheduler-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SchedulerStore**

```typescript
// src/core/tools/scheduler-store.ts
import type Database from "better-sqlite3";

export interface ScheduledTaskRow {
  id: string;
  name: string;
  schedule: string;        // JSON string of Schedule
  command: string;
  context: string;
  channel: string;
  chatId: string;
  nextRunAt: number;       // Unix timestamp ms
  lastRunAt: number | null;
  createdAt: number;       // Unix timestamp ms
}

export class SchedulerStore {
  constructor(private db: Database.Database) {}

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        schedule TEXT NOT NULL,
        command TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        channel TEXT NOT NULL,
        chatId TEXT NOT NULL,
        nextRunAt INTEGER NOT NULL,
        lastRunAt INTEGER,
        createdAt INTEGER NOT NULL
      )
    `);
  }

  add(task: ScheduledTaskRow): void {
    this.db.prepare(`
      INSERT INTO scheduled_tasks (id, name, schedule, command, context, channel, chatId, nextRunAt, lastRunAt, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.name, task.schedule, task.command, task.context,
           task.channel, task.chatId, task.nextRunAt, task.lastRunAt, task.createdAt);
  }

  removeByName(name: string): boolean {
    const result = this.db.prepare("DELETE FROM scheduled_tasks WHERE name = ?").run(name);
    return result.changes > 0;
  }

  deleteById(id: string): void {
    this.db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
  }

  list(): ScheduledTaskRow[] {
    return this.db.prepare("SELECT * FROM scheduled_tasks ORDER BY nextRunAt").all() as ScheduledTaskRow[];
  }

  getDue(now: number): ScheduledTaskRow[] {
    return this.db.prepare("SELECT * FROM scheduled_tasks WHERE nextRunAt <= ?").all(now) as ScheduledTaskRow[];
  }

  updateNextRun(id: string, nextRunAt: number, lastRunAt: number | null): void {
    this.db.prepare("UPDATE scheduled_tasks SET nextRunAt = ?, lastRunAt = ? WHERE id = ?")
      .run(nextRunAt, lastRunAt, id);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/tools/scheduler-store.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/scheduler-store.ts test/core/tools/scheduler-store.test.ts
git commit -m "feat: add SchedulerStore with SQLite persistence for scheduled tasks"
```

---

### Task 2: Time Parsing Utilities

**Files:**
- Create: `src/core/tools/scheduler-parse.ts`
- Test: `test/core/tools/scheduler-parse.test.ts`

- [ ] **Step 1: Write failing tests for relative/duration parsing**

```typescript
// test/core/tools/scheduler-parse.test.ts
import { describe, it, expect } from "vitest";
import { parseAtTime, parseEveryDuration } from "../../../src/core/tools/scheduler-parse.js";

describe("parseAtTime", () => {
  it("parses relative +5m", () => {
    const now = Date.now();
    const result = parseAtTime("+5m", now);
    expect(result).toBeGreaterThanOrEqual(now + 5 * 60_000 - 100);
    expect(result).toBeLessThanOrEqual(now + 5 * 60_000 + 100);
  });

  it("parses relative +2h30m", () => {
    const now = Date.now();
    const result = parseAtTime("+2h30m", now);
    const expected = now + 2 * 3600_000 + 30 * 60_000;
    expect(Math.abs(result - expected)).toBeLessThan(100);
  });

  it("parses relative +1d", () => {
    const now = Date.now();
    const result = parseAtTime("+1d", now);
    expect(Math.abs(result - (now + 86_400_000))).toBeLessThan(100);
  });

  it("parses ISO datetime string", () => {
    const result = parseAtTime("2026-03-18T15:30:00", Date.now());
    const expected = new Date("2026-03-18T15:30:00").getTime();
    expect(result).toBe(expected);
  });

  it("throws on invalid input", () => {
    expect(() => parseAtTime("garbage", Date.now())).toThrow();
  });
});

describe("parseEveryDuration", () => {
  it("parses 30s", () => {
    expect(parseEveryDuration("30s")).toBe(30_000);
  });

  it("parses 5m", () => {
    expect(parseEveryDuration("5m")).toBe(300_000);
  });

  it("parses 2h", () => {
    expect(parseEveryDuration("2h")).toBe(7_200_000);
  });

  it("parses 1d", () => {
    expect(parseEveryDuration("1d")).toBe(86_400_000);
  });

  it("throws on invalid input", () => {
    expect(() => parseEveryDuration("abc")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/tools/scheduler-parse.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement parsers**

```typescript
// src/core/tools/scheduler-parse.ts

/**
 * Parse a relative time string ("+5m", "+2h30m", "+1d") or ISO datetime
 * into an absolute Unix timestamp in milliseconds.
 */
export function parseAtTime(input: string, now: number): number {
  if (input.startsWith("+")) {
    return now + parseRelativeDuration(input.slice(1));
  }

  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid time: "${input}". Use "+5m", "+2h", or ISO datetime.`);
  }
  return date.getTime();
}

/**
 * Parse a duration string ("30s", "5m", "2h", "1d") into milliseconds.
 */
export function parseEveryDuration(input: string): number {
  return parseRelativeDuration(input);
}

function parseRelativeDuration(input: string): number {
  const regex = /(\d+)\s*(d|h|m|s)/g;
  let totalMs = 0;
  let matched = false;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    matched = true;
    const value = Number(match[1]);
    const unit = match[2];
    switch (unit) {
      case "d": totalMs += value * 86_400_000; break;
      case "h": totalMs += value * 3_600_000; break;
      case "m": totalMs += value * 60_000; break;
      case "s": totalMs += value * 1_000; break;
    }
  }

  if (!matched || totalMs <= 0) {
    throw new Error(`Invalid duration: "${input}". Use "5m", "2h", "1d", etc.`);
  }

  return totalMs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/tools/scheduler-parse.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/scheduler-parse.ts test/core/tools/scheduler-parse.test.ts
git commit -m "feat: add relative time and duration parsers for scheduler"
```

---

### Task 3: Rewrite Scheduler Tool

Replace the current standalone `schedulerTool` with a class that wraps `SchedulerStore`, supports 3 schedule types, and exposes a mutable setter for message context.

**Files:**
- Modify: `src/core/tools/scheduler.ts` (full rewrite)
- Test: `test/core/tools/scheduler.test.ts` (create new)

- [ ] **Step 1: Write failing tests for the new scheduler tool**

```typescript
// test/core/tools/scheduler.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { SchedulerStore } from "../../../src/core/tools/scheduler-store.js";
import { SchedulerService } from "../../../src/core/tools/scheduler.js";

let db: Database.Database;
let store: SchedulerStore;
let scheduler: SchedulerService;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SchedulerStore(db);
  store.init();
  scheduler = new SchedulerService(store);
});

afterEach(() => {
  scheduler.stop();
  db.close();
});

describe("SchedulerService", () => {
  it("adds an 'at' task via tool", async () => {
    scheduler.setMessageContext("telegram", "42", []);
    const tool = scheduler.tool;
    const result = await tool.execute({
      action: "add", name: "reminder",
      schedule_type: "at", at: "+5m",
      command: "Напомни про деплой",
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("reminder");

    const tasks = store.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].channel).toBe("telegram");
    expect(tasks[0].chatId).toBe("42");
  });

  it("adds a 'cron' task via tool (backward compat)", async () => {
    scheduler.setMessageContext("telegram", "1", []);
    const result = await scheduler.tool.execute({
      action: "add", name: "daily",
      cron_expression: "0 20 * * *",
      command: "Сводка",
    });
    expect(result.success).toBe(true);
    const tasks = store.list();
    expect(tasks).toHaveLength(1);
    const schedule = JSON.parse(tasks[0].schedule);
    expect(schedule.kind).toBe("cron");
  });

  it("adds an 'every' task", async () => {
    scheduler.setMessageContext("browser", "ws-1", []);
    const result = await scheduler.tool.execute({
      action: "add", name: "check-site",
      schedule_type: "every", every: "30m",
      command: "Проверь сайт",
    });
    expect(result.success).toBe(true);
    const schedule = JSON.parse(store.list()[0].schedule);
    expect(schedule.kind).toBe("every");
    expect(schedule.everyMs).toBe(1_800_000);
  });

  it("lists tasks", async () => {
    scheduler.setMessageContext("telegram", "1", []);
    await scheduler.tool.execute({
      action: "add", name: "t1", schedule_type: "at", at: "+5m", command: "a",
    });
    const result = await scheduler.tool.execute({ action: "list" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("t1");
  });

  it("removes a task by name", async () => {
    scheduler.setMessageContext("telegram", "1", []);
    await scheduler.tool.execute({
      action: "add", name: "to-remove", schedule_type: "at", at: "+5m", command: "x",
    });
    const result = await scheduler.tool.execute({ action: "remove", name: "to-remove" });
    expect(result.success).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it("captures conversation context", async () => {
    scheduler.setMessageContext("telegram", "1", [
      { role: "user", content: "Надо задеплоить проект" },
      { role: "assistant", content: "Окей, когда?" },
      { role: "user", content: "Напомни через 5 минут" },
    ]);
    await scheduler.tool.execute({
      action: "add", name: "deploy-reminder",
      schedule_type: "at", at: "+5m", command: "Напомни про деплой",
    });
    const task = store.list()[0];
    expect(task.context).toContain("Надо задеплоить");
    expect(task.context).toContain("Напомни через 5 минут");
  });

  it("fires due tasks and calls callback", async () => {
    const fired: string[] = [];
    scheduler.onTaskFire((task) => { fired.push(task.name); });
    scheduler.setMessageContext("telegram", "1", []);

    // Add task and manually set it to past via store
    await scheduler.tool.execute({
      action: "add", name: "now-task",
      schedule_type: "at", at: "+1m",
      command: "fire now",
    });
    // Force nextRunAt to past so tick fires it
    const task = store.list()[0];
    store.updateNextRun(task.id, Date.now() - 1000, null);

    // Manually trigger tick
    await scheduler.tick();
    expect(fired).toContain("now-task");
    // One-shot task should be deleted
    expect(store.list()).toHaveLength(0);
  });

  it("advances nextRunAt for 'every' tasks after fire", async () => {
    const fired: string[] = [];
    scheduler.onTaskFire((task) => { fired.push(task.name); });
    scheduler.setMessageContext("telegram", "1", []);

    await scheduler.tool.execute({
      action: "add", name: "repeater",
      schedule_type: "every", every: "10m",
      command: "repeat",
    });

    // Manually set nextRunAt to past so tick fires it
    const task = store.list()[0];
    store.updateNextRun(task.id, Date.now() - 1000, null);

    await scheduler.tick();
    expect(fired).toContain("repeater");

    // Task should still exist with future nextRunAt
    const updated = store.list();
    expect(updated).toHaveLength(1);
    expect(updated[0].nextRunAt).toBeGreaterThan(Date.now());
  });

  it("recoverMissed executes missed one-shot and skips recurring", async () => {
    const fired: string[] = [];
    scheduler.onTaskFire((task) => { fired.push(task.name); });
    scheduler.setMessageContext("telegram", "1", []);

    // Add one-shot task in the past (manually via store)
    const now = Date.now();
    store.add({
      id: "missed-at", name: "missed-oneshot",
      schedule: JSON.stringify({ kind: "at", at: now - 60_000 }),
      command: "missed", context: "", channel: "telegram",
      chatId: "1", nextRunAt: now - 60_000, lastRunAt: null, createdAt: now - 120_000,
    });
    // Add recurring task in the past
    store.add({
      id: "missed-every", name: "missed-recurring",
      schedule: JSON.stringify({ kind: "every", everyMs: 300_000 }),
      command: "repeat", context: "", channel: "telegram",
      chatId: "1", nextRunAt: now - 60_000, lastRunAt: null, createdAt: now - 120_000,
    });

    await scheduler.recoverMissed();

    // One-shot was fired and deleted
    expect(fired).toContain("missed-oneshot");
    // Recurring was NOT fired, but nextRunAt was advanced
    expect(fired).not.toContain("missed-recurring");
    const remaining = store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe("missed-recurring");
    expect(remaining[0].nextRunAt).toBeGreaterThan(now);
  });
});
```

Add a test for `nextCronRun` in the same file:

```typescript
import { nextCronRun } from "../../../src/core/tools/scheduler.js";

describe("nextCronRun", () => {
  it("computes next run for daily cron", () => {
    const now = new Date("2026-03-18T15:00:00").getTime();
    const next = nextCronRun("0 20 * * *", now);
    const nextDate = new Date(next);
    expect(nextDate.getHours()).toBe(20);
    expect(nextDate.getMinutes()).toBe(0);
    expect(next).toBeGreaterThan(now);
  });

  it("computes next run for every-5-minutes cron", () => {
    const now = new Date("2026-03-18T15:02:00").getTime();
    const next = nextCronRun("*/5 * * * *", now);
    const nextDate = new Date(next);
    expect(nextDate.getMinutes() % 5).toBe(0);
    expect(next).toBeGreaterThan(now);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/tools/scheduler.test.ts`
Expected: FAIL — `SchedulerService` not found

- [ ] **Step 3: Rewrite scheduler.ts**

Replace the entire content of `src/core/tools/scheduler.ts` with:

```typescript
// src/core/tools/scheduler.ts
import { randomUUID } from "node:crypto";
import type { Tool, ToolResult } from "./types.js";
import type { SchedulerStore, ScheduledTaskRow } from "./scheduler-store.js";
import { parseAtTime, parseEveryDuration } from "./scheduler-parse.js";

// ---------------------------------------------------------------------------
// Cron parser (kept from original)
// ---------------------------------------------------------------------------

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }
    const stepMatch = part.match(/^(\*|\d+-\d+)\/(\d+)$/);
    if (stepMatch) {
      let start = min;
      let end = max;
      if (stepMatch[1] !== "*") {
        const [s, e] = stepMatch[1].split("-").map(Number);
        start = s; end = e;
      }
      const step = Number(stepMatch[2]);
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      for (let i = start; i <= end; i++) values.add(i);
      continue;
    }
    const num = Number(part);
    if (!Number.isNaN(num) && num >= min && num <= max) values.add(num);
  }
  return values;
}

function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression "${expression}": expected 5 fields`);
  }
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dayOfMonth: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dayOfWeek: parseField(parts[4], 0, 6),
  };
}

function cronMatches(fields: CronFields, date: Date): boolean {
  return (
    fields.minute.has(date.getMinutes()) &&
    fields.hour.has(date.getHours()) &&
    fields.dayOfMonth.has(date.getDate()) &&
    fields.month.has(date.getMonth() + 1) &&
    fields.dayOfWeek.has(date.getDay())
  );
}

/** Compute the next time a cron expression matches after `afterMs`. */
export function nextCronRun(expr: string, afterMs: number): number {
  const fields = parseCron(expr);
  // Scan minute-by-minute for up to 366 days
  const maxScan = 366 * 24 * 60;
  const start = new Date(afterMs);
  // Start from the next minute
  start.setSeconds(0, 0);
  start.setTime(start.getTime() + 60_000);

  for (let i = 0; i < maxScan; i++) {
    const candidate = new Date(start.getTime() + i * 60_000);
    if (cronMatches(fields, candidate)) {
      return candidate.getTime();
    }
  }
  // Fallback: 24h from now
  return afterMs + 86_400_000;
}

// ---------------------------------------------------------------------------
// Context helper
// ---------------------------------------------------------------------------

interface ContextMessage {
  role: string;
  content: string;
}

function buildContext(messages: ContextMessage[]): string {
  const MAX_CHARS = 700;
  const lines: string[] = [];
  let totalLen = 0;

  // Most recent first
  for (let i = messages.length - 1; i >= 0; i--) {
    const line = `${messages[i].role}: ${messages[i].content}`;
    if (totalLen + line.length > MAX_CHARS) break;
    lines.unshift(line);
    totalLen += line.length;
    if (lines.length >= 10) break;
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// SchedulerService
// ---------------------------------------------------------------------------

export type TaskFireCallback = (task: ScheduledTaskRow) => void | Promise<void>;

export class SchedulerService {
  private store: SchedulerStore;
  private fireCallback: TaskFireCallback | null = null;
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  // Mutable message context — set before each tool execution
  private currentChannel = "";
  private currentChatId = "";
  private currentMessages: ContextMessage[] = [];

  constructor(store: SchedulerStore) {
    this.store = store;
  }

  /** Set current message context. Called by engine before tool execution. */
  setMessageContext(channel: string, chatId: string, messages: ContextMessage[]): void {
    this.currentChannel = channel;
    this.currentChatId = chatId;
    this.currentMessages = messages;
  }

  /** Register callback for when a scheduled task fires. */
  onTaskFire(cb: TaskFireCallback): void {
    this.fireCallback = cb;
  }

  /** Start the 30s ticker. */
  start(): void {
    if (this.tickHandle) return;
    this.tickHandle = setInterval(() => { this.tick(); }, 30_000);
    if (this.tickHandle && typeof this.tickHandle === "object" && "unref" in this.tickHandle) {
      (this.tickHandle as NodeJS.Timeout).unref();
    }
  }

  /** Stop the ticker. */
  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /** Check for due tasks and fire them. Public for testing. */
  async tick(): Promise<void> {
    const now = Date.now();
    const due = this.store.getDue(now);

    for (const task of due) {
      const schedule = JSON.parse(task.schedule);

      // Update DB BEFORE async callback to prevent double-fire
      if (schedule.kind === "at") {
        this.store.deleteById(task.id);
      } else if (schedule.kind === "every") {
        const nextRunAt = now + schedule.everyMs;
        this.store.updateNextRun(task.id, nextRunAt, now);
      } else if (schedule.kind === "cron") {
        const nextRunAt = nextCronRun(schedule.expr, now);
        this.store.updateNextRun(task.id, nextRunAt, now);
      }

      // Fire callback (async, don't block the loop)
      if (this.fireCallback) {
        try {
          await this.fireCallback(task);
        } catch (err) {
          console.error(`Scheduler fire error for "${task.name}":`, err);
        }
      }
    }
  }

  /** Process missed one-shot tasks on startup. */
  async recoverMissed(): Promise<void> {
    const now = Date.now();
    const due = this.store.getDue(now);

    for (const task of due) {
      const schedule = JSON.parse(task.schedule);

      if (schedule.kind === "at") {
        // Execute missed one-shot
        this.store.deleteById(task.id);
        if (this.fireCallback) {
          try {
            await this.fireCallback(task);
          } catch (err) {
            console.error(`Scheduler recovery error for "${task.name}":`, err);
          }
          // 3s delay between missed tasks
          await new Promise((r) => setTimeout(r, 3000));
        }
      } else if (schedule.kind === "every") {
        // Skip to next future run
        const nextRunAt = now + schedule.everyMs;
        this.store.updateNextRun(task.id, nextRunAt, null);
      } else if (schedule.kind === "cron") {
        const nextRunAt = nextCronRun(schedule.expr, now);
        this.store.updateNextRun(task.id, nextRunAt, null);
      }
    }
  }

  /** The Tool instance to register in ToolRegistry. */
  get tool(): Tool {
    return {
      name: "scheduler",
      description:
        "Планировщик задач (напоминания, повторяющиеся задачи). " +
        'schedule_type="at" + at="+5m" для одноразовых, ' +
        'schedule_type="every" + every="30m" для интервалов, ' +
        'schedule_type="cron" + cron_expression="0 20 * * *" для расписаний. ' +
        "action=add создаёт задачу, action=remove удаляет по имени, action=list показывает все.",
      parameters: [
        { name: "action", type: "string", description: "add, remove, or list", required: true },
        { name: "name", type: "string", description: "Task name (required for add/remove)" },
        { name: "schedule_type", type: "string", description: 'at, every, or cron (default: cron)' },
        { name: "cron_expression", type: "string", description: 'Cron expression for schedule_type=cron, e.g. "0 20 * * *"' },
        { name: "at", type: "string", description: 'Time for schedule_type=at: "+5m", "+2h", or ISO datetime' },
        { name: "every", type: "string", description: 'Interval for schedule_type=every: "30s", "5m", "2h"' },
        { name: "command", type: "string", description: "What to do when the task fires (prompt for the LLM)" },
      ],
      execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
        return this.handleToolCall(params);
      },
    };
  }

  private async handleToolCall(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || "").trim();

    switch (action) {
      case "add": return this.handleAdd(params);
      case "remove": return this.handleRemove(params);
      case "list": return this.handleList();
      default:
        return { success: false, output: `Unknown action: ${action}. Use add, remove, or list.`, error: "invalid_action" };
    }
  }

  private handleAdd(params: Record<string, unknown>): ToolResult {
    const name = String(params.name || "").trim();
    if (!name) return { success: false, output: "Missing: name", error: "missing_param" };

    const command = String(params.command || "").trim();
    if (!command) return { success: false, output: "Missing: command", error: "missing_param" };

    // Determine schedule type — default to "cron" for backward compat
    let scheduleType = String(params.schedule_type || "").trim();
    if (!scheduleType && params.cron_expression) scheduleType = "cron";
    if (!scheduleType) return { success: false, output: "Missing: schedule_type (at, every, or cron)", error: "missing_param" };

    const now = Date.now();
    let schedule: string;
    let nextRunAt: number;

    try {
      switch (scheduleType) {
        case "at": {
          const atStr = String(params.at || "").trim();
          if (!atStr) return { success: false, output: "Missing: at (e.g. \"+5m\")", error: "missing_param" };
          const atMs = parseAtTime(atStr, now);
          schedule = JSON.stringify({ kind: "at", at: atMs });
          nextRunAt = atMs;
          break;
        }
        case "every": {
          const everyStr = String(params.every || "").trim();
          if (!everyStr) return { success: false, output: "Missing: every (e.g. \"30m\")", error: "missing_param" };
          const everyMs = parseEveryDuration(everyStr);
          schedule = JSON.stringify({ kind: "every", everyMs });
          nextRunAt = now + everyMs;
          break;
        }
        case "cron": {
          const expr = String(params.cron_expression || "").trim();
          if (!expr) return { success: false, output: "Missing: cron_expression", error: "missing_param" };
          // Validate by parsing
          parseCron(expr);
          schedule = JSON.stringify({ kind: "cron", expr });
          nextRunAt = nextCronRun(expr, now);
          break;
        }
        default:
          return { success: false, output: `Invalid schedule_type: ${scheduleType}`, error: "invalid_param" };
      }
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : String(err), error: "parse_error" };
    }

    const context = buildContext(this.currentMessages);

    const task: ScheduledTaskRow = {
      id: randomUUID(),
      name,
      schedule,
      command,
      context,
      channel: this.currentChannel,
      chatId: this.currentChatId,
      nextRunAt,
      lastRunAt: null,
      createdAt: now,
    };

    try {
      this.store.add(task);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE")) {
        return { success: false, output: `Task "${name}" already exists. Remove it first or use a different name.`, error: "duplicate" };
      }
      return { success: false, output: msg, error: "db_error" };
    }

    const when = scheduleType === "at"
      ? new Date(nextRunAt).toLocaleString()
      : scheduleType === "every"
        ? `every ${params.every}`
        : params.cron_expression;

    return { success: true, output: `Задача "${name}" запланирована (${when}).` };
  }

  private handleRemove(params: Record<string, unknown>): ToolResult {
    const name = String(params.name || "").trim();
    if (!name) return { success: false, output: "Missing: name", error: "missing_param" };

    const removed = this.store.removeByName(name);
    if (!removed) return { success: false, output: `Task "${name}" not found.`, error: "not_found" };

    return { success: true, output: `Задача "${name}" удалена.` };
  }

  private handleList(): ToolResult {
    const tasks = this.store.list();
    if (tasks.length === 0) return { success: true, output: "Нет запланированных задач." };

    const lines = tasks.map((t) => {
      const sched = JSON.parse(t.schedule);
      const type = sched.kind;
      const detail = type === "at" ? new Date(sched.at).toLocaleString()
        : type === "every" ? `every ${sched.everyMs / 60_000}m`
        : sched.expr;
      return `- ${t.name}: [${type}] ${detail} → ${t.command}`;
    });
    return { success: true, output: `${tasks.length} задач(а):\n${lines.join("\n")}` };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/tools/scheduler.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/scheduler.ts test/core/tools/scheduler.test.ts
git commit -m "feat: rewrite scheduler as SchedulerService with 3 schedule types"
```

---

### Task 4: Integration — Wire Up in index.ts

Connect SchedulerService to Engine, Telegram channel, and startup recovery.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update imports**

At the top of `src/index.ts`, replace the old scheduler import:

```typescript
// Remove:
import { schedulerTool } from "./core/tools/scheduler.js";

// Add:
import { SchedulerService } from "./core/tools/scheduler.js";
import { SchedulerStore } from "./core/tools/scheduler-store.js";
import { getDB } from "./core/memory/db.js";
import type { Channel } from "./channels/types.js";
```

- [ ] **Step 2: Initialize store and service after config load**

After `const tools = new ToolRegistry();` (line 71), add:

```typescript
  // Setup scheduler with SQLite persistence
  const schedulerDb = getDB();  // reuses existing ~/.betsy/betsy.db
  const schedulerStore = new SchedulerStore(schedulerDb);
  schedulerStore.init();
  const scheduler = new SchedulerService(schedulerStore);
```

- [ ] **Step 3: Replace old tool registration**

Replace `tools.register(schedulerTool);` (line 77) with:

```typescript
  tools.register(scheduler.tool);
```

- [ ] **Step 4: Hoist telegram variable and add channel map**

First, hoist the `telegram` variable declaration outside the `try` block so it's accessible later. Change the Telegram block in `src/index.ts`:

```typescript
  // Start Telegram channel
  let telegram: TelegramChannel | null = null;
  if (config.telegram?.token) {
    try {
      telegram = new TelegramChannel();
      // ... rest of existing code stays the same
```

Then after the Telegram start block, add:

```typescript
  // Channel map for proactive delivery
  const channels = new Map<string, Channel>();
  if (telegram) {
    channels.set("telegram", telegram);
  }

  // Wire scheduler to engine + channels
  if (engine) {
    scheduler.onTaskFire(async (task) => {
      const channel = channels.get(task.channel);
      if (!channel) {
        console.error(`Scheduler: channel "${task.channel}" not available for task "${task.name}"`);
        return;
      }

      const prompt = [
        `Сработало запланированное задание "${task.name}".`,
        `Задача: ${task.command}`,
        task.context ? `\nКонтекст разговора при создании задачи:\n${task.context}` : "",
        `\nНапиши владельцу сообщение в связи с этой задачей.`,
      ].join("\n");

      try {
        const result = await engine.process({
          channelName: task.channel,
          userId: task.chatId,
          text: prompt,
          timestamp: Date.now(),
          metadata: { scheduledTask: true },
        });
        await channel.send(task.chatId, result);
        console.log(`✅ Scheduler: delivered "${task.name}" to ${task.channel}:${task.chatId}`);
      } catch (err) {
        console.error(`❌ Scheduler: failed to deliver "${task.name}":`, err);
      }
    });

    // Recover missed one-shot tasks, then start ticker
    await scheduler.recoverMissed();
    scheduler.start();
    console.log("✅ Планировщик запущен");
  }
```

Also update `setupShutdown` to accept and stop the scheduler:

```typescript
  setupShutdown(server, wss, scheduler);
```

And modify the function:

```typescript
function setupShutdown(server: any, wss: any, scheduler?: SchedulerService) {
  const shutdown = () => {
    console.log("\nЗавершение работы...");
    scheduler?.stop();
    wss.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
```
```

- [ ] **Step 5: Wire setMessageContext in engine**

The engine needs to call `scheduler.setMessageContext()` before each tool execution round. Modify `src/index.ts` to pass the scheduler into the engine's message handler so context is set.

The simplest approach: wrap the telegram `onMessage` handler to set context before engine processes:

Replace the existing `telegram.onMessage` block:

```typescript
      telegram.onMessage(async (msg, onProgress) => {
        if (engine) {
          // Set scheduler context from incoming message
          scheduler.setMessageContext(
            msg.channelName,
            msg.userId,
            engine.getHistory(msg.userId) ?? [],
          );
          return engine.process(msg, onProgress);
        }
        return { text: "LLM не настроен. Открой дашборд для настройки." };
      });
```

This requires a small addition to Engine — a `getHistory()` method.

- [ ] **Step 6: Add getHistory to Engine**

In `src/core/engine.ts`, add a public method:

```typescript
  /** Get conversation history for a user (for scheduler context). */
  getHistory(userId: string): Array<{ role: string; content: string }> {
    const history = this.histories.get(userId);
    if (!history) return [];
    return history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "" }));
  }
```

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS (existing tests should not break)

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/core/engine.ts
git commit -m "feat: wire scheduler service to engine and telegram channel"
```

---

### Task 5: Update System Prompt

**Files:**
- Modify: `src/core/prompt.ts`

- [ ] **Step 1: Update scheduler description in prompt**

In `src/core/prompt.ts`, find the tools section (around line 99-107) and replace the scheduler line:

```typescript
// Replace:
- scheduler — планировщик задач
// With:
- scheduler — планировщик задач (напоминания, повторяющиеся задачи). schedule_type="at" + at="+5m" для одноразовых, schedule_type="every" + every="30m" для интервалов, schedule_type="cron" + cron_expression="0 20 * * *" для расписаний. Когда владелец просит "напомни", "напиши через", "каждый день" — используй scheduler.
```

- [ ] **Step 2: Run prompt tests**

Run: `npx vitest run test/core/prompt.test.ts`
Expected: PASS (check if any tests assert on the old scheduler description)

- [ ] **Step 3: Commit**

```bash
git add src/core/prompt.ts
git commit -m "feat: update system prompt with scheduler usage examples"
```

---

### Task 6: Smoke Test — End-to-End Manual Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: Successful build

- [ ] **Step 4: Manual test (optional)**

Start the dev server and test via Telegram:
1. Send "напомни мне через 1 минуту про тест"
2. Verify bot creates a scheduled task (check logs)
3. Wait ~1-1.5 minutes
4. Verify bot sends a proactive message about the test

---

### Task 7: Cleanup — Remove Old Exports

**Files:**
- Modify: `src/core/tools/scheduler.ts`

- [ ] **Step 1: Check for any remaining imports of old exports**

Search codebase for `onTaskFire`, `stopScheduler`, `schedulerTool` imports outside of the scheduler file itself. These old exports no longer exist.

- [ ] **Step 2: Fix any broken imports**

If any files import old exports, update them to use `SchedulerService` instead.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: clean up old scheduler exports"
```
