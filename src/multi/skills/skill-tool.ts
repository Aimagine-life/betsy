// Wave 1C — Workspace skills: agent-facing tools (run_skill, list_skills).
import { z } from 'zod'
import type { MemoryTool } from '../agents/tools/memory-tools.js'
import type { SkillManager } from './manager.js'
import type { SkillLLM, SkillLogger } from './executor.js'

export interface SkillToolDeps {
  workspaceId: string
  manager: SkillManager
  llm: SkillLLM
  logger: SkillLogger
  /**
   * Function returning tools the skill is allowed to call. Resolved lazily so
   * we avoid the obvious infinite loop where run_skill itself appears in the
   * skill's available tools.
   */
  getRunnableTools: () => MemoryTool[]
}

export function createSkillTools(deps: SkillToolDeps): MemoryTool[] {
  const { workspaceId, manager, llm, logger, getRunnableTools } = deps

  const runParams = z.object({
    name: z.string().min(1).max(100).describe('Имя скила, как зарегистрировано'),
    args: z.record(z.any()).optional().describe('Опциональные начальные переменные (vars.*)'),
  })
  const runSkill: MemoryTool = {
    name: 'run_skill',
    description:
      'Запустить именованный воркспейс-скил. Скил — заранее заданная последовательность шагов (вызовы тулов, prompt-шаги, условия, циклы). Используй когда юзер просит выполнить рутину, которую он сам настроил, или когда тебе нужно собрать сложный отчёт по шаблону.',
    parameters: runParams,
    async execute(params) {
      const parsed = runParams.parse(params)
      const result = await manager.runByName(workspaceId, parsed.name, {
        availableTools: getRunnableTools(),
        llm,
        vars: parsed.args ?? {},
      })
      return result
    },
  }

  const listParams = z.object({})
  const listSkills: MemoryTool = {
    name: 'list_skills',
    description:
      'Получить список всех доступных воркспейс-скилов с их описаниями. Используй чтобы понять что юзер уже автоматизировал, и можно ли запустить один из готовых скилов вместо ручной работы.',
    parameters: listParams,
    async execute() {
      const rows = await manager.listForWorkspace(workspaceId)
      return rows.map((r) => ({
        name: r.name,
        description: r.description,
        triggerType: r.triggerType,
        enabled: r.enabled,
      }))
    },
  }

  // logger reference kept to discourage tree-shaking complaints in CI
  void logger

  return [runSkill, listSkills]
}
