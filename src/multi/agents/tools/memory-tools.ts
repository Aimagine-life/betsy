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

/**
 * Ask Gemini Flash to semantically pick which items from a list are related
 * to a topic. Returns indexes (0-based) of the items to delete.
 *
 * One LLM call regardless of list size — no per-item overhead.
 */
async function pickRelatedItems(
  gemini: GoogleGenAI,
  topic: string,
  items: string[],
): Promise<Set<number>> {
  if (items.length === 0) return new Set()

  // Truncate each item so the prompt stays manageable; semantic match still works
  const truncated = items.map((s, i) => `${i}: ${(s ?? '').slice(0, 300)}`)

  const prompt = `Below is a list of memory items. The user wants to forget everything related to a TOPIC. Decide which items are RELATED to this topic (in any meaningful way: directly mentions it, refers to it by codename, talks about events around it, etc.). Return ONLY a JSON array of the integer indexes that should be deleted. No commentary.

If nothing matches, return [].

TOPIC: "${topic}"

ITEMS:
${truncated.join('\n')}

INDEXES TO DELETE (JSON array):`

  try {
    const resp: any = await gemini.models.generateContent({
      model: SUMMARY_EDITOR_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    })
    const text =
      (resp as any).text ??
      (resp as any).candidates?.[0]?.content?.parts?.[0]?.text ??
      ''
    const match = String(text).match(/\[[^\]]*\]/s)
    if (!match) return new Set()
    const arr = JSON.parse(match[0])
    if (!Array.isArray(arr)) return new Set()
    return new Set(
      arr
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n >= 0 && n < items.length),
    )
  } catch (e) {
    log().error('forget_fact: semantic picker failed', {
      error: e instanceof Error ? e.message : String(e),
    })
    return new Set()
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
      'Забыть тему из памяти ПОЛНОСТЬЮ — семантически, не по совпадению слов. Делает три вещи через Gemini: (1) находит и удаляет связанные atomic facts, (2) ПЕРЕПИСЫВАЕТ долгосрочное саммари без упоминаний темы, (3) находит и удаляет связанные сообщения из истории чата. Понимает синонимы, кодовые имена, контекст. Используй когда юзер просит забыть что-то конкретное: "забудь про печь", "забудь моего бывшего", "удали про работу".',
    parameters: forgetOneParams,
    async execute(params) {
      const parsed = forgetOneParams.parse(params)

      if (!gemini) {
        return {
          success: false,
          message: 'gemini client not available — semantic forget cannot run',
        }
      }

      // 1) Semantic deletion of atomic facts
      const allFacts = await factsRepo.list(workspaceId, 200)
      const atomicFacts = allFacts.filter((f) => (f.kind as string) !== 'summary')
      const summaryFacts = allFacts.filter((f) => (f.kind as string) === 'summary')

      const factIndexesToDelete = await pickRelatedItems(
        gemini,
        parsed.query,
        atomicFacts.map((f) => f.content),
      )
      const deletedContents: string[] = []
      for (const idx of factIndexesToDelete) {
        const f = atomicFacts[idx]
        await factsRepo.forget(workspaceId, f.id)
        deletedContents.push(f.content)
      }
      log().info('forget_fact: atomic facts deleted', {
        topic: parsed.query,
        count: deletedContents.length,
      })

      // 2) Edit the rolling summary
      let summaryEdited = false
      for (const summaryFact of summaryFacts) {
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

      // 3) Semantic deletion of conversation messages
      let conversationDeleted = 0
      if (convRepo) {
        const recent = await convRepo.recent(workspaceId, 300)
        // recent is newest-first; we want to give Gemini them in chronological order
        const ordered = [...recent].reverse()
        const items = ordered.map(
          (m) => `[${m.role}] ${m.content}`,
        )
        const indexesToDelete = await pickRelatedItems(gemini, parsed.query, items)
        const idsToDelete: string[] = []
        for (const idx of indexesToDelete) {
          idsToDelete.push(ordered[idx].id)
        }
        if (idsToDelete.length > 0) {
          conversationDeleted = await convRepo.deleteByIds(workspaceId, idsToDelete)
        }
        log().info('forget_fact: conversation messages deleted', {
          topic: parsed.query,
          count: conversationDeleted,
        })
      }

      const anyChange = deletedContents.length > 0 || summaryEdited || conversationDeleted > 0

      if (!anyChange) {
        return {
          success: false,
          deleted: 0,
          summary_edited: false,
          conversation_deleted: 0,
          message: 'Не нашла ничего связанного с этой темой',
        }
      }

      return {
        success: true,
        deleted: deletedContents.length,
        deletedContents,
        summary_edited: summaryEdited,
        conversation_deleted: conversationDeleted,
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
