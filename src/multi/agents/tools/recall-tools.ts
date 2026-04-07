import { z } from 'zod'
import type { GoogleGenAI } from '@google/genai'
import type { ConversationRepo } from '../../memory/conversation-repo.js'
import { embedText } from '../../memory/embeddings.js'
import { log } from '../../observability/logger.js'
import type { MemoryTool } from './memory-tools.js'
import type { RunContext } from '../run-context.js'

const DEFAULT_LIMIT = Number(process.env.BC_RECALL_DEFAULT_LIMIT ?? 5)
const MAX_LIMIT = 20
const EXCLUDE_RECENT_N = Number(process.env.BC_RECALL_EXCLUDE_RECENT_N ?? 200)

export interface RecallToolsDeps {
  convRepo: ConversationRepo
  gemini: GoogleGenAI
  workspaceId: string
  currentChatId: string
  currentChannel: 'telegram' | 'max'
  runContext: RunContext
}

export function createRecallTools(deps: RecallToolsDeps): MemoryTool[] {
  const { convRepo, gemini, workspaceId, currentChatId, currentChannel, runContext } = deps

  const recallParams = z.object({
    query: z.string().min(1).max(500).describe('Что искать. Свободный текст на русском.'),
    role: z
      .enum(['user', 'assistant', 'any'])
      .optional()
      .describe('Чьи реплики искать: user — мои, assistant — твои, any — любые.'),
    // Note: no .max() here so the agent can pass a too-large value;
    // we clamp to MAX_LIMIT inside execute() rather than rejecting.
    limit: z.number().int().min(1).optional(),
    since: z
      .string()
      .optional()
      .describe('ISO-дата (YYYY-MM-DD). Только сообщения начиная с этой даты.'),
    until: z
      .string()
      .optional()
      .describe('ISO-дата (YYYY-MM-DD). Только сообщения до этой даты включительно.'),
  })

  const recallMessages: MemoryTool = {
    name: 'recall_messages',
    description:
      'Семантический поиск по старым сообщениям из этого чата (уже выпавшим из активного контекста). ' +
      'Используй когда юзер просит вспомнить что-то конкретное из прошлого: "что я говорил про X", ' +
      '"когда ты обещала Y", "о чём мы говорили вчера про Z". Возвращает массив matches с content, role, ' +
      'externalMessageId и similarity (0..1). После выбора нужного сообщения используй set_reply_target ' +
      'чтобы процитировать его реплаем.',
    parameters: recallParams,
    async execute(params) {
      const parsed = recallParams.parse(params)
      const limit = Math.min(parsed.limit ?? DEFAULT_LIMIT, MAX_LIMIT)

      let queryVec: number[]
      try {
        queryVec = await embedText(gemini, parsed.query)
      } catch (e) {
        log().warn('recall_messages: embed failed', {
          workspaceId,
          error: e instanceof Error ? e.message : String(e),
        })
        return { matches: [], error: 'embedding_failed' }
      }

      let hits: Awaited<ReturnType<typeof convRepo.searchByEmbedding>>
      try {
        hits = await convRepo.searchByEmbedding(workspaceId, queryVec, {
          chatId: currentChatId,
          limit,
          role: parsed.role ?? 'any',
          since: parsed.since,
          until: parsed.until,
          excludeRecentN: EXCLUDE_RECENT_N,
        })
      } catch (e) {
        log().warn('recall_messages: search failed', {
          workspaceId,
          error: e instanceof Error ? e.message : String(e),
        })
        return { matches: [], error: 'search_failed' }
      }

      return {
        matches: hits.map((h) => ({
          role: h.role,
          content: h.content.length > 300 ? h.content.slice(0, 300) + '…' : h.content,
          externalMessageId: h.externalMessageId,
          chatId: h.chatId,
          timestamp:
            h.createdAt instanceof Date ? h.createdAt.toISOString() : String(h.createdAt),
          // pgvector cosine distance is in [0, 2]; rescale to similarity in [0, 1].
          similarity: Number(Math.max(0, 1 - h.distance / 2).toFixed(3)),
        })),
      }
    },
  }

  const setReplyTargetParams = z.object({
    externalMessageId: z
      .number()
      .int()
      .positive()
      .describe('externalMessageId из recall_messages результата.'),
  })
  const setReplyTarget: MemoryTool = {
    name: 'set_reply_target',
    description:
      'Пометить следующий твой ответ как реплай на указанное сообщение (Telegram reply-quote). ' +
      'Вызывай ОДИН раз перед финальным текстом. Твой обычный текстовый ответ станет комментарием ' +
      'к процитированному сообщению. Работает только в Telegram.',
    parameters: setReplyTargetParams,
    async execute(params) {
      const parsed = setReplyTargetParams.parse(params)
      if (currentChannel !== 'telegram') {
        return { ok: false, reason: 'reply-quote only telegram supported in v1' }
      }
      runContext.replyTarget = parsed.externalMessageId
      log().info('set_reply_target: target set', {
        workspaceId,
        externalMessageId: parsed.externalMessageId,
      })
      return { ok: true }
    },
  }

  return [recallMessages, setReplyTarget]
}
