import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { SchedulerStore } from "../../../src/core/tools/scheduler-store.js";
import { SchedulerService, nextCronRun } from "../../../src/core/tools/scheduler.js";

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
