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
