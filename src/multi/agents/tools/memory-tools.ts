import { z } from 'zod'
import type { FactsRepo } from '../../memory/facts-repo.js'
import type { ConversationRepo } from '../../memory/conversation-repo.js'
import type { FactKind } from '../../memory/types.js'

export interface MemoryTool {
  name: string
  description: string
  parameters: z.ZodType
  execute(params: any): Promise<unknown>
}

export interface MemoryToolsDeps {
  factsRepo: FactsRepo
  /** Optional — when provided, forget_all and forget_recent_messages also clear conversation history */
  convRepo?: ConversationRepo
  workspaceId: string
}

export function createMemoryTools(deps: MemoryToolsDeps): MemoryTool[] {
  const { factsRepo, convRepo, workspaceId } = deps

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

  const forgetOneParams = z.object({
    query: z.string().min(1).max(500).describe(
      'Ключевое слово/фраза для поиска факта который надо забыть. Например "бывший", "Мария", "встреча в среду".',
    ),
  })
  const forgetOne: MemoryTool = {
    name: 'forget_fact',
    description:
      'Удалить КОНКРЕТНЫЙ факт из памяти. Используй когда юзер просит забыть что-то определённое: "забудь про моего бывшего", "удали что я говорил про работу". Поиск идёт по ключевому слову, удаляются ВСЕ совпадающие atomic facts (не summary). Если ничего не найдено — скажи юзеру.',
    parameters: forgetOneParams,
    async execute(params) {
      const parsed = forgetOneParams.parse(params)
      const matches = await factsRepo.searchByContent(workspaceId, parsed.query, 20)
      if (matches.length === 0) {
        return { success: false, deleted: 0, message: 'Нет совпадающих фактов' }
      }
      // Don't delete the rolling summary fact through this tool — that's
      // forget_all's job. Only individual atomic facts.
      const toDelete = matches.filter((f) => (f.kind as string) !== 'summary')
      let deleted = 0
      for (const f of toDelete) {
        await factsRepo.forget(workspaceId, f.id)
        deleted++
      }
      return {
        success: true,
        deleted,
        deletedContents: toDelete.map((f) => f.content),
      }
    },
  }

  const forgetRecentParams = z.object({
    count: z.number().int().min(1).max(200).describe(
      'Сколько последних сообщений диалога удалить (и user, и assistant считаются по отдельности). Например 4 = последние 2 пары обмена.',
    ),
  })
  const forgetRecent: MemoryTool = {
    name: 'forget_recent_messages',
    description:
      'Стереть последние N сообщений из истории диалога. Используй когда юзер говорит "забудь что я только что сказал", "удали последние 5 сообщений", "сотри сегодняшний разговор". Это НЕ трогает долговременные факты — только chat history.',
    parameters: forgetRecentParams,
    async execute(params) {
      if (!convRepo) {
        return { success: false, error: 'conversation history pruning not available in this agent' }
      }
      const parsed = forgetRecentParams.parse(params)
      const deleted = await convRepo.deleteRecent(workspaceId, parsed.count)
      return { success: true, deleted }
    },
  }

  const forgetAllParams = z.object({
    confirm: z.boolean().describe('Должно быть true. Это деструктивная операция.'),
  })
  const forgetAll: MemoryTool = {
    name: 'forget_all',
    description:
      'ВНИМАНИЕ: ПОЛНОСТЬЮ стереть всю память о юзере — atomic facts, long-term summary, и всю историю диалога. Это полный сброс. Используй ТОЛЬКО когда юзер явно и осознанно попросил забыть ВСЁ ("забудь всё", "сотри меня"). Параметр confirm должен быть true. После выполнения Betsy не будет ничего помнить о юзере.',
    parameters: forgetAllParams,
    async execute(params) {
      const parsed = forgetAllParams.parse(params)
      if (!parsed.confirm) {
        return { success: false, reason: 'confirm must be true' }
      }
      await factsRepo.forgetAll(workspaceId)
      let convCleared = 0
      if (convRepo) {
        convCleared = await convRepo.purgeAll(workspaceId)
      }
      return {
        success: true,
        message: 'Вся память и история очищены',
        conversationsDeleted: convCleared,
      }
    },
  }

  return [remember, recall, forgetOne, forgetRecent, forgetAll]
}
