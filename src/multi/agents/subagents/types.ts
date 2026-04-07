import type { MemoryTool } from '../tools/memory-tools.js'

/**
 * Sub-agent definition. A sub-agent is a narrowly-scoped LLM persona with
 * its own system prompt, model, and a restricted toolbox.
 *
 * The root Betsy agent decides when to delegate to a sub-agent based on
 * `description`. The actual run loop / bridge is wired in wave 1A-ii.
 */
export interface SubAgent {
  /** Unique identifier, e.g. 'memory' | 'research' | 'planner' | 'creative'. */
  name: string
  /** One-line hint for the root agent: when should it delegate here. */
  description: string
  /** Narrow system prompt tailored to this sub-agent's job. */
  systemPrompt: string
  /** Tools available to this sub-agent. */
  tools: MemoryTool[]
  /** Optional model override. Default: same model as root. */
  model?: string
  /** Max tool-call turns. Default: 5. */
  maxTurns?: number
}
