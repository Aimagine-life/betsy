/**
 * Wave 4 — eval harness types.
 *
 * A "case" is a single golden example: an input the agent should handle and
 * a set of expectations the response must satisfy. Cases are grouped by
 * `category` so the runner can aggregate per-area success rates.
 */

export type EvalCategory =
  | 'delegation'
  | 'recall'
  | 'tool_selection'
  | 'persona'
  | 'safety'
  | 'skills'

export interface EvalCaseInput {
  userMessage: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  workspace?: { id: string; persona?: unknown }
  facts?: string[]
}

export interface MinRecallExpectation {
  k: number
  relevantIds: string[]
}

export interface EvalExpectations {
  /** Name of the tool that should be invoked first. */
  firstTool?: string
  /** String or list of strings that must appear in the final text. */
  textContains?: string | string[]
  /** String or list of strings that must NOT appear in the final text. */
  textMustNotContain?: string | string[]
  /** Minimum recall@k for memory retrieval cases. */
  minRecall?: MinRecallExpectation
  /** LLM-judge properties (each is a natural-language assertion). */
  judgeProperties?: string[]
}

/** Scripted reply matching the shape consumed by the mock Gemini in sim/. */
export interface MockReply {
  functionCall?: { name: string; args: Record<string, unknown> }
  text?: string
}

export interface EvalCase {
  id: string
  description: string
  category: EvalCategory
  /** When true, the runner skips the case (use for "not yet automatable"). */
  skip?: boolean
  input: EvalCaseInput
  expected: EvalExpectations
  /** Scripted Gemini replies (consumed in order) — required for mock runs. */
  mockResponses?: MockReply[]
  /** When set, the runner will use this list as the "actual recall ids". */
  mockRecallIds?: string[]
}

export interface EvalMetrics {
  firstTool?: string
  recall?: number
  judgeScore?: number
}

export interface EvalResult {
  caseId: string
  category: EvalCategory
  skipped: boolean
  passed: boolean
  failures: string[]
  durationMs: number
  metrics: EvalMetrics
}

export interface CategorySummary {
  passed: number
  failed: number
  skipped: number
}

export interface EvalRunSummary {
  total: number
  passed: number
  failed: number
  skipped: number
  byCategory: Record<string, CategorySummary>
  results: EvalResult[]
  latencyP50: number
  latencyP95: number
  startedAt: string
  finishedAt: string
}

export interface BaselineFile {
  startedAt?: string
  results: Array<{ caseId: string; passed: boolean; category: EvalCategory }>
}

export interface BaselineComparison {
  /** Cases that previously passed but now fail. */
  regressions: string[]
  /** Cases that previously failed and now pass. */
  improvements: string[]
}
