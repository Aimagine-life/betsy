// Wave 1C — Workspace skills: persistence layer.
import type { Pool } from 'pg'
import { withWorkspace, asAdmin } from '../db/rls.js'
import type { SkillRow, TriggerType } from './types.js'

function rowToSkill(r: any): SkillRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    description: r.description,
    yaml: r.yaml,
    triggerType: r.trigger_type as TriggerType,
    triggerConfig: r.trigger_config ?? {},
    enabled: r.enabled,
    createdBy: r.created_by,
    lastRunAt: r.last_run_at,
    lastRunStatus: r.last_run_status,
    lastRunError: r.last_run_error,
    runCount: r.run_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface UpsertSkillInput {
  name: string
  description?: string
  yaml: string
  triggerType: TriggerType
  triggerConfig?: Record<string, any>
  enabled?: boolean
  createdBy?: string
}

export class SkillsRepo {
  constructor(private pool: Pool) {}

  async list(workspaceId: string): Promise<SkillRow[]> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_workspace_skills order by name asc`,
      )
      return rows.map(rowToSkill)
    })
  }

  async get(workspaceId: string, id: string): Promise<SkillRow | null> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_workspace_skills where id = $1`,
        [id],
      )
      return rows[0] ? rowToSkill(rows[0]) : null
    })
  }

  async getByName(workspaceId: string, name: string): Promise<SkillRow | null> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `select * from bc_workspace_skills where name = $1`,
        [name],
      )
      return rows[0] ? rowToSkill(rows[0]) : null
    })
  }

  async upsert(workspaceId: string, input: UpsertSkillInput): Promise<SkillRow> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const { rows } = await client.query(
        `insert into bc_workspace_skills
           (workspace_id, name, description, yaml, trigger_type, trigger_config, enabled, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (workspace_id, name) do update set
           description    = excluded.description,
           yaml           = excluded.yaml,
           trigger_type   = excluded.trigger_type,
           trigger_config = excluded.trigger_config,
           enabled        = excluded.enabled,
           updated_at     = now()
         returning *`,
        [
          workspaceId,
          input.name,
          input.description ?? null,
          input.yaml,
          input.triggerType,
          input.triggerConfig ?? {},
          input.enabled ?? true,
          input.createdBy ?? null,
        ],
      )
      return rowToSkill(rows[0])
    })
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    return withWorkspace(this.pool, workspaceId, async (client) => {
      const res = await client.query(
        `delete from bc_workspace_skills where id = $1`,
        [id],
      )
      return (res.rowCount ?? 0) > 0
    })
  }

  async setEnabled(workspaceId: string, id: string, enabled: boolean): Promise<void> {
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(
        `update bc_workspace_skills set enabled = $1, updated_at = now() where id = $2`,
        [enabled, id],
      )
    })
  }

  async recordRun(
    workspaceId: string,
    id: string,
    status: 'success' | 'error',
    error?: string,
  ): Promise<void> {
    await withWorkspace(this.pool, workspaceId, async (client) => {
      await client.query(
        `update bc_workspace_skills
            set last_run_at     = now(),
                last_run_status = $1,
                last_run_error  = $2,
                run_count       = run_count + 1,
                updated_at      = now()
          where id = $3`,
        [status, error ?? null, id],
      )
    })
  }

  /**
   * Admin-only: enumerate all enabled cron skills across every workspace.
   * Used by registerCronTriggers on server startup. Never expose to user input.
   */
  async listAllEnabledCronAdmin(): Promise<
    Array<Pick<SkillRow, 'id' | 'workspaceId' | 'name' | 'yaml' | 'triggerConfig'>>
  > {
    return asAdmin(this.pool, async (client) => {
      const { rows } = await client.query(
        `select id, workspace_id, name, yaml, trigger_config
           from bc_workspace_skills
          where enabled = true and trigger_type = 'cron'`,
      )
      return rows.map((r: any) => ({
        id: r.id,
        workspaceId: r.workspace_id,
        name: r.name,
        yaml: r.yaml,
        triggerConfig: r.trigger_config ?? {},
      }))
    })
  }
}
