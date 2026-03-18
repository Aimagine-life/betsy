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
