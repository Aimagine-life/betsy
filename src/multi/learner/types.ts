// Wave 2A — LearnerAgent: types.
//
// A candidate is a proposed skill the Learner derived from a conversation
// pattern. Candidates live in bc_skill_candidates until the user explicitly
// approves them, at which point they are promoted into bc_workspace_skills.

export type SkillCandidateStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface SkillCandidate {
  id: string
  workspaceId: string
  name: string
  description: string
  yaml: string
  rationale: string
  sourcePattern?: Record<string, unknown> | null
  status: SkillCandidateStatus
  createdAt: Date
  decidedAt: Date | null
  expiresAt: Date
}

/**
 * A conversation pattern detected by the Learner. Patterns must pass both a
 * cheap heuristic filter (tool-call repetition across days) AND the LLM
 * extractor before they become candidates.
 */
export interface ConversationPattern {
  /** Human-readable description of what the user is repeatedly doing. */
  description: string
  /** A few representative user messages that kicked off the pattern. */
  triggerExamples: string[]
  /** Tool names called in order. Empty array is allowed for pure prompt flows. */
  toolSequence: string[]
  /** How many times the pattern was observed in the analysed window. */
  frequency: number
  /** 0..1 confidence from the LLM extractor. */
  confidence: number
}

/** Result of generating a candidate from a pattern. */
export interface GeneratedCandidate {
  name: string
  description: string
  yaml: string
  rationale: string
}
