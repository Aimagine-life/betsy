import type { GoogleGenAI } from '@google/genai'
import type { FactKind } from '../memory/types.js'
import type { FactsRepo } from '../memory/facts-repo.js'
import type { ConversationRepo } from '../memory/conversation-repo.js'
import { embedText } from '../memory/embeddings.js'
import { log } from '../observability/logger.js'

export interface AgentContext {
  /** Plain strings from bc_memory_facts.content, ordered newest first */
  factContents: string[]
  /** Recent messages, oldest first (LLM-ready order) */
  history: { role: 'user' | 'assistant' | 'tool'; content: string }[]
}

export interface LoadContextInput {
  factsRepo: FactsRepo
  convRepo: ConversationRepo
  workspaceId: string
  factLimit: number
  historyLimit: number
  /** When provided together with gemini, enables semantic fact retrieval. */
  userQuery?: string
  gemini?: GoogleGenAI
}

export async function loadAgentContext(input: LoadContextInput): Promise<AgentContext> {
  const { factsRepo, convRepo, workspaceId, factLimit, historyLimit, userQuery, gemini } = input

  // Always load the latest rolling summary — it is the long-term compressed memory
  // and must always be present in context regardless of retrieval strategy.
  // 'summary' is not in the FactKind union but is used by the Summarizer as an
  // internal kind — cast to satisfy TypeScript.
  const summaryFacts = await factsRepo.listByKind(workspaceId, 'summary' as FactKind, 1)

  let factContents: string[]

  const semanticSlots = factLimit - 1 // one slot is reserved for the summary

  if (userQuery && gemini && semanticSlots > 0) {
    // Semantic retrieval path: embed the user query and find nearest facts
    let semanticFacts = null
    try {
      const queryVec = await embedText(gemini, userQuery)
      // Exclude 'summary' kind — it's always loaded separately above
      const hits = await factsRepo.searchByEmbedding(workspaceId, queryVec, semanticSlots, ['summary' as FactKind])
      semanticFacts = hits
    } catch (e) {
      log().warn('loadAgentContext: semantic search failed, falling back to recency', {
        workspaceId,
        error: e instanceof Error ? e.message : String(e),
      })
    }

    if (semanticFacts !== null && semanticFacts.length > 0) {
      // Merge: summary first, then semantic hits (dedup by id just in case)
      const seen = new Set<string>()
      const combined = [...summaryFacts, ...semanticFacts].filter((f) => {
        if (seen.has(f.id)) return false
        seen.add(f.id)
        return true
      })
      factContents = combined.map((f) => f.content)
    } else {
      // Semantic returned nothing (no embeddings yet) — fall back to recency
      const fallbackFacts = await factsRepo.list(workspaceId, factLimit)
      // Dedup with the summary we already have
      const seen = new Set(summaryFacts.map((f) => f.id))
      const dedupedFallback = fallbackFacts.filter((f) => {
        if (seen.has(f.id)) return false
        seen.add(f.id)
        return true
      })
      const combined = [...summaryFacts, ...dedupedFallback]
      factContents = combined.map((f) => f.content)
    }
  } else {
    // Recency-based fallback (no query / no gemini)
    const facts = await factsRepo.list(workspaceId, factLimit)
    // Ensure summary is always first (it may already be in the list)
    const seen = new Set(summaryFacts.map((f) => f.id))
    const rest = facts.filter((f) => !seen.has(f.id))
    const combined = [...summaryFacts, ...rest]
    factContents = combined.map((f) => f.content)
  }

  const rawHistory = await convRepo.recent(workspaceId, historyLimit)

  return {
    factContents,
    history: rawHistory
      .slice()
      .reverse()
      .map((m: any) => ({
        role: m.role as 'user' | 'assistant' | 'tool',
        content: m.content,
      })),
  }
}
