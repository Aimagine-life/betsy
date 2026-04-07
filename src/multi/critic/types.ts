/**
 * Wave 2B — CriticAgent types.
 *
 * The CriticAgent is a lightweight pre-send validator that inspects a draft
 * assistant response and returns either `{ ok: true }` or a structured
 * critique with optional suggested rewrite. See {@link ../critic.ts}.
 */

export interface CriticInput {
  /** The assistant draft Betsy would normally send. */
  draftResponse: string
  /** The user message that triggered this turn. */
  userMessage: string
  /** Persona system prompt / personality brief, used to judge tone + style. */
  personaPrompt: string
  /** Top relevant facts about the owner (5-10). Optional. */
  ownerFacts?: string[]
  /** Outbound channel — used for length heuristics. */
  channel: 'telegram' | 'max'
}

export type CriticIssueKind =
  | 'persona_mismatch'
  | 'fact_conflict'
  | 'leak'
  | 'length'
  | 'tone'

export interface CriticIssue {
  kind: CriticIssueKind
  detail: string
}

export interface CriticResult {
  ok: boolean
  issues: CriticIssue[]
  /** Optional rewritten draft, only present when critic can produce one. */
  suggested?: string
  /** Wall-clock duration of the review (ms). */
  durationMs: number
}
