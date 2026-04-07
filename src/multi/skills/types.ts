// Wave 1C — Workspace skills: types

export type TriggerType = 'manual' | 'cron' | 'keyword' | 'event'

export interface SkillTrigger {
  type: TriggerType
  /** cron expression, when type === 'cron'. pg-boss schedule format. */
  cron?: string
  /** keywords (lowercased) that trigger this skill on inbound message match. */
  keywords?: string[]
  /** event name, when type === 'event'. */
  event?: string
}

export type SkillStep =
  | {
      kind: 'tool'
      tool: string
      params: Record<string, any>
      saveAs?: string
    }
  | {
      kind: 'prompt'
      prompt: string
      saveAs?: string
    }
  | {
      kind: 'condition'
      if: string
      then: SkillStep[]
      else?: SkillStep[]
    }
  | {
      kind: 'loop'
      over: string
      as: string
      do: SkillStep[]
    }

export interface WorkspaceSkill {
  /** id only present for skills loaded from the DB. */
  id?: string
  name: string
  description?: string
  trigger: SkillTrigger
  steps: SkillStep[]
}

export interface SkillRunResult {
  success: boolean
  output?: unknown
  stepsExecuted: number
  error?: string
}

/** Persisted row representation in bc_workspace_skills. */
export interface SkillRow {
  id: string
  workspaceId: string
  name: string
  description: string | null
  yaml: string
  triggerType: TriggerType
  triggerConfig: Record<string, any>
  enabled: boolean
  createdBy: string | null
  lastRunAt: Date | null
  lastRunStatus: string | null
  lastRunError: string | null
  runCount: number
  createdAt: Date
  updatedAt: Date
}
