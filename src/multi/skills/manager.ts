// Wave 1C — Workspace skills: high-level facade.
import type { SkillsRepo } from './repo.js'
import type { SkillRow, SkillRunResult, WorkspaceSkill } from './types.js'
import type { ExecuteSkillContext, SkillLLM, SkillLogger } from './executor.js'
import { executeSkill } from './executor.js'
import { parseSkillYaml } from './parser.js'
import type { MemoryTool } from '../agents/tools/memory-tools.js'

export interface SkillManagerDeps {
  repo: SkillsRepo
  logger: SkillLogger
}

export interface RunByNameInput {
  availableTools: MemoryTool[]
  llm: SkillLLM
  vars?: Record<string, any>
}

export class SkillManager {
  constructor(private deps: SkillManagerDeps) {}

  async listForWorkspace(workspaceId: string): Promise<SkillRow[]> {
    return this.deps.repo.list(workspaceId)
  }

  /**
   * Find skill by name; if `enabled` is false, returns null.
   */
  async findEnabledByName(workspaceId: string, name: string): Promise<SkillRow | null> {
    const row = await this.deps.repo.getByName(workspaceId, name)
    if (!row || !row.enabled) return null
    return row
  }

  /**
   * Find an enabled keyword-triggered skill whose keywords match the inbound
   * message. Case-insensitive substring match. Returns first match by name.
   */
  async findByKeyword(workspaceId: string, message: string): Promise<SkillRow | null> {
    const all = await this.deps.repo.list(workspaceId)
    const lower = message.toLowerCase()
    for (const row of all) {
      if (!row.enabled) continue
      if (row.triggerType !== 'keyword') continue
      const cfg: any = row.triggerConfig ?? {}
      const kws: string[] = Array.isArray(cfg.keywords) ? cfg.keywords : []
      for (const kw of kws) {
        if (typeof kw === 'string' && kw.length > 0 && lower.includes(kw.toLowerCase())) {
          return row
        }
      }
    }
    return null
  }

  /**
   * Load skill from DB by name, parse YAML, run via executor, persist run record.
   */
  async runByName(
    workspaceId: string,
    name: string,
    input: RunByNameInput,
  ): Promise<SkillRunResult> {
    const row = await this.findEnabledByName(workspaceId, name)
    if (!row) {
      return {
        success: false,
        stepsExecuted: 0,
        error: `skill not found or disabled: ${name}`,
      }
    }
    let parsed: WorkspaceSkill
    try {
      parsed = parseSkillYaml(row.yaml)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      await this.deps.repo.recordRun(workspaceId, row.id, 'error', `parse: ${message}`)
      return { success: false, stepsExecuted: 0, error: `parse error: ${message}` }
    }

    const ctx: ExecuteSkillContext = {
      workspaceId,
      availableTools: input.availableTools,
      llm: input.llm,
      logger: this.deps.logger,
      vars: input.vars,
    }
    const result = await executeSkill(parsed, ctx)
    try {
      await this.deps.repo.recordRun(
        workspaceId,
        row.id,
        result.success ? 'success' : 'error',
        result.error,
      )
    } catch (e) {
      this.deps.logger.warn('skill: recordRun failed', {
        workspaceId,
        skillId: row.id,
        error: e instanceof Error ? e.message : String(e),
      })
    }
    return result
  }

  /**
   * Register cron triggers for ALL enabled cron skills across every workspace
   * with pg-boss. Idempotent: callers should invoke once at server startup.
   *
   * The boss object is loosely typed (`any`) so this module doesn't take a
   * hard dep on a specific pg-boss version. Each schedule sends a job whose
   * payload identifies the skill so the worker can resolve it back to a
   * workspace context via withWorkspace.
   */
  async registerCronTriggers(
    boss: { schedule: (name: string, cron: string, data: any) => Promise<unknown> },
  ): Promise<{ registered: number }> {
    const skills = await this.deps.repo.listAllEnabledCronAdmin()
    let registered = 0
    for (const s of skills) {
      const cron = (s.triggerConfig as any)?.cron
      if (typeof cron !== 'string' || cron.length === 0) continue
      try {
        await boss.schedule(`skill:${s.workspaceId}:${s.id}`, cron, {
          workspaceId: s.workspaceId,
          skillId: s.id,
          skillName: s.name,
        })
        registered++
      } catch (e) {
        this.deps.logger.warn('skill: cron schedule failed', {
          workspaceId: s.workspaceId,
          skillId: s.id,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    this.deps.logger.info('skill: cron triggers registered', { registered })
    return { registered }
  }
}
