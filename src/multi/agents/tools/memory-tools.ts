import { z } from 'zod'
import type { GoogleGenAI } from '@google/genai'
import type { FactsRepo } from '../../memory/facts-repo.js'
import type { ConversationRepo } from '../../memory/conversation-repo.js'
import type { FactKind } from '../../memory/types.js'
import { log } from '../../observability/logger.js'

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
  /** Optional — when provided, forget_fact can edit the rolling summary
   *  to remove a specific topic via Gemini Flash */
  gemini?: GoogleGenAI
  workspaceId: string
}

const SUMMARY_EDITOR_MODEL = 'gemini-2.5-flash'

async function editSummaryRemovingTopic(
  gemini: GoogleGenAI,
  oldSummary: string,
  topic: string,
): Promise<string | null> {
  const prompt = `Below is a long-term memory summary about a user. The user just asked to forget everything related to a specific topic. Rewrite the summary so all mentions of that topic are removed. Keep all other facts intact. If the topic isn't actually mentioned, return the summary unchanged. Write in Russian. Do not add commentary — only the updated summary text.

TOPIC TO REMOVE: ${topic}

CURRENT SUMMARY:
${oldSummary}

UPDATED SUMMARY:`
  try {
    const resp: any = await gemini.models.generateContent({
      model: SUMMARY_EDITOR_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    })
    const text =
      (resp as any).text ??
      (resp as any).candidates?.[0]?.content?.parts?.[0]?.text ??
      ''
    const trimmed = String(text).trim()
    return trimmed.length > 0 ? trimmed : null
  } catch (e) {
    log().error('forget_fact: summary editor failed', {
      error: e instanceof Error ? e.message : String(e),
    })
    return null
  }
}

export function createMemoryTools(deps: MemoryToolsDeps): MemoryTool[] {
  const { factsRepo, convRepo, gemini, workspaceId } = deps

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
      'Ключевое слово/фраза/тема для забывания. Например "бывший", "Мария", "печь", "встреча в среду", "работа в Wildbots".',
    ),
  })
  const forgetOne: MemoryTool = {
    name: 'forget_fact',
    description:
      'Забыть тему из памяти. Удаляет atomic facts с этим словом И ПОПРАВЛЯЕТ долгосрочное саммари — Gemini Flash перепишет его, убрав упоминания темы. Используй когда юзер просит забыть что-то конкретное: "забудь про печь", "забудь моего бывшего", "удали про работу". Если ничего не найдено — честно скажи юзеру.',
    parameters: forgetOneParams,
    async execute(params) {
      const parsed = forgetOneParams.parse(params)
      const matches = await factsRepo.searchByContent(workspaceId, parsed.query, 20)

      // Split into atomic facts (delete outright) and summary fact (edit through Gemini)
      const atomicMatches = matches.filter((f) => (f.kind as string) !== 'summary')
      const summaryMatches = matches.filter((f) => (f.kind as string) === 'summary')

      // 1) Delete atomic facts directly
      const deletedContents: string[] = []
      for (const f of atomicMatches) {
        await factsRepo.forget(workspaceId, f.id)
        deletedContents.push(f.content)
      }

      // 2) For each summary match, ask Gemini to rewrite it without the topic
      let summaryEdited = false
      let editError: string | null = null
      for (const summaryFact of summaryMatches) {
        if (!gemini) {
          editError = 'gemini client not available — summary cannot be edited'
          break
        }
        const newSummary = await editSummaryRemovingTopic(
          gemini,
          summaryFact.content,
          parsed.query,
        )
        if (newSummary && newSummary !== summaryFact.content) {
          // Replace by deleting old + inserting new (factsRepo lacks an update method)
          await factsRepo.forget(workspaceId, summaryFact.id)
          await factsRepo.remember(workspaceId, {
            kind: 'summary' as FactKind,
            content: newSummary,
            meta: {
              source: 'forget_fact_edit',
              removed_topic: parsed.query,
              edited_at: new Date().toISOString(),
            } as any,
          })
          summaryEdited = true
        }
      }

      // 3) If we found NO match in atomic facts AND NO match in summary,
      //    do one more pass: maybe the topic is in summary but searchByContent
      //    used a too-narrow LIKE. Try editing whatever current summary exists.
      if (!summaryEdited && atomicMatches.length === 0 && gemini) {
        const allSummaries = await factsRepo.listByKind(
          workspaceId,
          'summary' as FactKind,
          5,
        )
        for (const summaryFact of allSummaries) {
          const newSummary = await editSummaryRemovingTopic(
            gemini,
            summaryFact.content,
            parsed.query,
          )
          if (newSummary && newSummary !== summaryFact.content) {
            await factsRepo.forget(workspaceId, summaryFact.id)
            await factsRepo.remember(workspaceId, {
              kind: 'summary' as FactKind,
              content: newSummary,
              meta: {
                source: 'forget_fact_edit',
                removed_topic: parsed.query,
                edited_at: new Date().toISOString(),
              } as any,
            })
            summaryEdited = true
          }
        }
      }

      if (deletedContents.length === 0 && !summaryEdited) {
        return {
          success: false,
          deleted: 0,
          summary_edited: false,
          message: editError ?? 'Не нашла ничего по этой теме',
        }
      }

      return {
        success: true,
        deleted: deletedContents.length,
        deletedContents,
        summary_edited: summaryEdited,
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
