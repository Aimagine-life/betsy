import type { GoogleGenAI } from '@google/genai'
import type { FactsRepo } from './facts-repo.js'
import type { FactKind } from './types.js'
import { embedText } from './embeddings.js'
import { log } from '../observability/logger.js'

export interface ExtractorDeps {
  gemini: GoogleGenAI
  factsRepo: FactsRepo
}

export interface ExtractOptions {
  workspaceId: string
  lastUserMessage: string
  lastAssistantMessage: string
  /** Gemini model to use for extraction. Default: gemini-2.5-flash */
  model?: string
  /**
   * Cosine SIMILARITY threshold above which a candidate is considered a
   * duplicate of an existing fact. Default: 0.92.
   * (Equivalently: pgvector cosine distance < 0.08)
   */
  dedupThreshold?: number
}

const DEFAULT_MODEL = 'gemini-2.5-flash'
const DEFAULT_DEDUP_THRESHOLD = 0.92

interface ExtractedCandidate {
  kind: FactKind
  content: string
}

/**
 * Passive fact extractor.
 *
 * After each assistant turn this class inspects the user/assistant exchange
 * and asks Gemini to pull out any NEW long-term facts worth remembering.
 * Each candidate is deduped against the existing embedding index before being
 * persisted, so we never write the same fact twice.
 */
export class FactExtractor {
  constructor(private deps: ExtractorDeps) {}

  async maybeExtract(opts: ExtractOptions): Promise<{ extractedCount: number }> {
    const {
      workspaceId,
      lastUserMessage,
      lastAssistantMessage,
      model = DEFAULT_MODEL,
      dedupThreshold = DEFAULT_DEDUP_THRESHOLD,
    } = opts

    const prompt = `You are a memory extractor. From the user/assistant exchange below, extract any NEW long-term facts about the user that should be remembered: preferences, personal facts, relationships, important events, ongoing projects/tasks. Return STRICT JSON: an array of objects {kind, content}. kind ∈ [preference, fact, relationship, event, task, other]. content: one short atomic fact in Russian, max 200 chars. If nothing worth remembering, return []. Skip small talk, greetings, and anything ephemeral. Do not duplicate obvious or trivial info.

USER: ${lastUserMessage}
ASSISTANT: ${lastAssistantMessage}

JSON:`

    let rawText: string
    try {
      const resp: any = await this.deps.gemini.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      })
      rawText =
        (resp as any).text ??
        (resp as any).candidates?.[0]?.content?.parts?.[0]?.text ??
        ''
      rawText = String(rawText).trim()
    } catch (e) {
      log().error('factExtractor: gemini generateContent failed', {
        workspaceId,
        error: e instanceof Error ? e.message : String(e),
      })
      return { extractedCount: 0 }
    }

    // Parse JSON — strip markdown code fences if present
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
    let candidates: ExtractedCandidate[]
    try {
      const parsed = JSON.parse(cleaned)
      if (!Array.isArray(parsed)) {
        log().warn('factExtractor: response was not an array, skipping', { workspaceId, rawText })
        return { extractedCount: 0 }
      }
      candidates = parsed.filter(
        (c: any) =>
          c && typeof c.kind === 'string' && typeof c.content === 'string' && c.content.length > 0,
      ) as ExtractedCandidate[]
    } catch (e) {
      log().warn('factExtractor: JSON parse failed', {
        workspaceId,
        error: e instanceof Error ? e.message : String(e),
        rawText,
      })
      return { extractedCount: 0 }
    }

    if (candidates.length === 0) {
      return { extractedCount: 0 }
    }

    // Cosine distance threshold: distance = 1 - similarity
    const maxDistance = 1 - dedupThreshold
    let extractedCount = 0

    for (const candidate of candidates) {
      // Compute embedding for the candidate
      let candidateVec: number[]
      try {
        candidateVec = await embedText(this.deps.gemini, candidate.content)
      } catch (e) {
        log().warn('factExtractor: embedding candidate failed, skipping', {
          workspaceId,
          content: candidate.content,
          error: e instanceof Error ? e.message : String(e),
        })
        continue
      }

      // Check for duplicates among existing facts
      const nearby = await this.deps.factsRepo.searchByEmbeddingWithDistance(
        workspaceId,
        candidateVec,
        3,
      )
      const isDuplicate = nearby.some((f) => f.distance < maxDistance)
      if (isDuplicate) {
        log().debug('factExtractor: skipping duplicate candidate', {
          workspaceId,
          content: candidate.content,
          closestDistance: nearby[0]?.distance,
        })
        continue
      }

      // Persist the new fact
      try {
        await this.deps.factsRepo.remember(workspaceId, {
          kind: candidate.kind,
          content: candidate.content,
          meta: { source: 'auto_extractor' },
        })
        extractedCount++
        log().debug('factExtractor: saved fact', { workspaceId, content: candidate.content })
      } catch (e) {
        log().error('factExtractor: remember failed', {
          workspaceId,
          content: candidate.content,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }

    log().info('factExtractor: done', { workspaceId, extractedCount, candidates: candidates.length })
    return { extractedCount }
  }
}
