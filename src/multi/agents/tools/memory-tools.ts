import { z } from 'zod'
import type { FactsRepo } from '../../memory/facts-repo.js'
import type { FactKind } from '../../memory/types.js'

export interface MemoryTool {
  name: string
  description: string
  parameters: z.ZodType
  execute(params: any): Promise<unknown>
}

export interface MemoryToolsDeps {
  factsRepo: FactsRepo
  workspaceId: string
}

export function createMemoryTools(deps: MemoryToolsDeps): MemoryTool[] {
  const { factsRepo, workspaceId } = deps

  const rememberParams = z.object({
    kind: z.enum(['preference', 'fact', 'task', 'relationship', 'event', 'other']),
    content: z.string().min(1).max(2000),
  })
  const remember: MemoryTool = {
    name: 'remember',
    description:
      'Запомнить важный факт о собеседнике или событие в долговременной памяти. Используй когда юзер сообщает что-то значимое: предпочтения, людей вокруг, планы, привычки.',
    parameters: rememberParams,
    async execute(params) {
      const parsed = rememberParams.parse(params)
      await factsRepo.remember(workspaceId, {
        kind: parsed.kind as FactKind,
        content: parsed.content,
      })
      return { success: true, remembered: parsed.content }
    },
  }

  const recallParams = z.object({
    query: z.string().min(1).max(500),
  })
  const recall: MemoryTool = {
    name: 'recall',
    description:
      'Найти факты из долговременной памяти по ключевому слову или теме. Используй когда нужно вспомнить что-то о юзере что не вошло в текущий контекст.',
    parameters: recallParams,
    async execute(params) {
      const parsed = recallParams.parse(params)
      const facts = await factsRepo.searchByContent(workspaceId, parsed.query, 20)
      return {
        facts: facts.map((f) => ({ kind: f.kind, content: f.content })),
      }
    },
  }

  const forgetParams = z.object({
    confirm: z.boolean(),
  })
  const forgetAll: MemoryTool = {
    name: 'forget_all',
    description:
      'ВНИМАНИЕ: удалить всю память о юзере безвозвратно. Вызывай только если юзер явно попросил забыть всё. Параметр confirm должен быть true.',
    parameters: forgetParams,
    async execute(params) {
      const parsed = forgetParams.parse(params)
      if (!parsed.confirm) {
        return { success: false, reason: 'confirm must be true' }
      }
      await factsRepo.forgetAll(workspaceId)
      return { success: true, message: 'Вся память очищена' }
    },
  }

  return [remember, recall, forgetAll]
}
