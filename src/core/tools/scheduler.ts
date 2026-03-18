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
