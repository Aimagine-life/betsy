import { z } from 'zod'
import type { GoogleGenAI } from '@google/genai'
import type { MemoryTool } from './memory-tools.js'
import { log } from '../../observability/logger.js'

const SEARCH_MODEL = 'gemini-2.5-flash'

/**
 * Vertex grounding returns wrapped redirect URLs like
 * https://vertexaisearch.cloud.google.com/grounding-api-redirect/...
 * Resolve them once via HEAD (manual redirect) to get the real destination
 * URL (e.g. the actual product page), so the LLM can pass deep links.
 */
async function resolveRedirect(url: string): Promise<string> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 4000)
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    const loc = res.headers.get('location')
    if (loc && /^https?:/i.test(loc)) return loc
    return url
  } catch {
    return url
  }
}

/**
 * Wraps Gemini's built-in googleSearch grounding as a custom FunctionTool.
 *
 * Why a wrapper instead of declaring `tools: [{googleSearch:{}}]` directly on
 * the main agent call: Gemini API does NOT allow mixing the googleSearch
 * built-in with `functionDeclarations` in a single request. So we expose
 * search as a regular function tool, and internally fan out to a SECOND
 * Gemini call that uses grounding.
 */
const MAX_SEARCHES_PER_RUN = 4

export function createWebSearchTool(gemini: GoogleGenAI): MemoryTool {
  let callCount = 0
  const params = z.object({
    query: z.string().min(1).max(500).describe(
      'Поисковый запрос на естественном языке. Например "курс доллара сегодня", "новости об OpenAI", "погода в Москве завтра".',
    ),
  })
  return {
    name: 'google_search',
    description:
      'Поиск в интернете через Google. Используй для актуальных новостей, текущих событий, погоды, курсов валют, цен, проверки фактов, и всего что может быть свежее твоих знаний. Возвращает ответ с источниками.',
    parameters: params,
    async execute(input) {
      const { query } = params.parse(input)
      callCount++
      if (callCount > MAX_SEARCHES_PER_RUN) {
        log().warn('google_search: limit reached', { query, callCount })
        return {
          error: `достигнут лимит ${MAX_SEARCHES_PER_RUN} поисков за один ответ — отвечай по уже найденному`,
          answer: '',
          sources: [],
        }
      }
      log().info('google_search: executing', { query, callCount })
      try {
        const callPromise = gemini.models.generateContent({
          model: SEARCH_MODEL,
          contents: [{ role: 'user', parts: [{ text: query }] }],
          config: { tools: [{ googleSearch: {} }] } as any,
        })
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('google_search timeout after 20s')), 20_000),
        )
        const res: any = await Promise.race([callPromise, timeoutPromise])
        const text =
          (res as any).text ??
          (res as any).candidates?.[0]?.content?.parts?.[0]?.text ??
          ''
        const meta = (res as any).candidates?.[0]?.groundingMetadata
        const rawSources = ((meta?.groundingChunks ?? []) as any[])
          .map((c) => ({
            title: c.web?.title ?? c.retrievedContext?.title,
            uri: c.web?.uri ?? c.retrievedContext?.uri,
          }))
          .filter((s) => s.uri)
        // Resolve Vertex grounding redirects in parallel so the LLM gets
        // real destination URLs (deep links) instead of opaque redirect URIs.
        const sources = await Promise.all(
          rawSources.map(async (s) => ({
            title: s.title,
            uri: await resolveRedirect(s.uri),
          })),
        )
        log().info('google_search: ok', {
          query,
          answerLen: text.length,
          sources: sources.length,
        })
        return {
          answer: text,
          queries: meta?.webSearchQueries ?? [],
          sources,
        }
      } catch (e) {
        log().error('google_search: failed', {
          query,
          error: e instanceof Error ? e.message : String(e),
        })
        return {
          error: e instanceof Error ? e.message : String(e),
          answer: '',
          sources: [],
        }
      }
    },
  }
}
