import type { Pool } from 'pg'
import { withWorkspace } from '../db/rls.js'
import type { Reminder, ReminderStatus, CreateReminderInput } from './types.js'

export type { CreateReminderInput } from './types.js'

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
