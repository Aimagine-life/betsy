/**
 * Conversation summarizer.
 *
 * When a workspace's active (not-yet-summarized) conversation history exceeds
 * the threshold, this fold the OLDEST batch of messages into a single rolling
 * "summary" fact in bc_memory_facts (kind='summary'). The summarized messages
 * stay in the database (for audit / debugging) but are flagged with
 * meta.summarized=true so they no longer load into the model context.
 *
 * Result: the live context always contains
 *   1. one always-fresh long-term summary fact
 *   2. the most recent `keepRecent` messages verbatim
 *
 * This lets a workspace chat indefinitely without bloating tokens.
 */
import type { GoogleGenAI } from '@google/genai'
import type { ConversationRepo } from './conversation-repo.js'
import type { FactsRepo } from './facts-repo.js'
import { log } from '../observability/logger.js'

export interface SummarizerDeps {
  gemini: GoogleGenAI
  convRepo: ConversationRepo
  factsRepo: FactsRepo
}

export interface SummarizeOptions {
  workspaceId: string
  /** Trigger summarization when active count >= this. */
  threshold: number
  /** After summarization, keep this many newest messages alive. */
  keepRecent: number
  /** Model id used for summarization. Cheap is fine. */
  model?: string
}

const DEFAULT_MODEL = 'gemini-2.5-flash'

export class Summarizer {
  constructor(private deps: SummarizerDeps) {}

  /**
   * Run summarization for one workspace if needed. Idempotent and safe to call
   * after every assistant turn — it returns immediately if the threshold
   * hasn't been crossed.
   */
  async maybeSummarize(opts: SummarizeOptions): Promise<{ summarized: boolean; foldedCount?: number }> {
    const { workspaceId, threshold, keepRecent, model = DEFAULT_MODEL } = opts

    const active = await this.deps.convRepo.countActive(workspaceId)
    if (active < threshold) {
      return { summarized: false }
    }

    const toFoldCount = active - keepRecent
    if (toFoldCount <= 0) return { summarized: false }

    log().info('summarizer: folding old messages', {
      workspaceId,
      activeCount: active,
      threshold,
      keepRecent,
      toFold: toFoldCount,
    })

    const oldMessages = await this.deps.convRepo.oldestActive(workspaceId, toFoldCount)
    if (oldMessages.length === 0) return { summarized: false }

    // Get the existing summary (if any) so the new one extends it
    const existingFacts = await this.deps.factsRepo.listByKind(workspaceId, 'summary' as any, 1)
    const previousSummary = existingFacts[0]?.content ?? null

    // Build the prompt for the summarizer
    const transcript = oldMessages
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n')

    const prompt = previousSummary
      ? `Below is the existing long-term memory summary about a user, and then a batch of NEW conversation messages (oldest first) that need to be folded into it. Update the summary to incorporate the new information. Keep important facts (preferences, projects, life events, ongoing tasks, decisions, things the user explicitly asked to remember). Drop small-talk and chit-chat. Write in Russian (the user speaks Russian). Keep it under 3000 characters.

EXISTING SUMMARY:
${previousSummary}

NEW MESSAGES TO FOLD IN:
${transcript}

UPDATED SUMMARY:`
      : `Below is a batch of conversation messages (oldest first). Extract a long-term memory summary of important facts about the user: preferences, projects, life events, ongoing tasks, decisions, things they explicitly asked to remember. Drop small-talk and chit-chat. Write in Russian (the user speaks Russian). Keep it under 3000 characters.

MESSAGES:
${transcript}

SUMMARY:`

    let newSummary: string
    try {
      const resp: any = await this.deps.gemini.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      })
      const text =
        (resp as any).text ??
        (resp as any).candidates?.[0]?.content?.parts?.[0]?.text ??
        ''
      newSummary = String(text).trim()
      if (!newSummary) {
        log().warn('summarizer: empty summary returned, skipping', { workspaceId })
        return { summarized: false }
      }
    } catch (e) {
      log().error('summarizer: gemini failed', {
        workspaceId,
        error: e instanceof Error ? e.message : String(e),
      })
      return { summarized: false }
    }

    // Replace existing summary fact (or insert new one)
    if (existingFacts[0]) {
      await this.deps.factsRepo.forget(workspaceId, existingFacts[0].id)
    }
    await this.deps.factsRepo.remember(workspaceId, {
      kind: 'summary' as any,
      content: newSummary,
      meta: {
        source: 'auto_summarizer',
        folded_messages: oldMessages.length,
        updated_at: new Date().toISOString(),
      } as any,
    })

    // Mark old messages as summarized so they no longer load
    await this.deps.convRepo.markSummarized(
      workspaceId,
      oldMessages.map((m) => m.id),
    )

    log().info('summarizer: done', {
      workspaceId,
      foldedCount: oldMessages.length,
      newSummaryLen: newSummary.length,
    })

    return { summarized: true, foldedCount: oldMessages.length }
  }
}
