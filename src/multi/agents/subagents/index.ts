import type { MemoryTool } from '../tools/memory-tools.js'
import { log } from '../../observability/logger.js'
import { SubAgentRegistry } from './registry.js'
import { createMemoryAgent } from './memory-agent.js'
import { createResearchAgent } from './research-agent.js'
import { createPlannerAgent } from './planner-agent.js'
import { createCreativeAgent } from './creative-agent.js'

export type { SubAgent } from './types.js'
export { SubAgentRegistry } from './registry.js'
export { createMemoryAgent } from './memory-agent.js'
export { createResearchAgent } from './research-agent.js'
export { createPlannerAgent } from './planner-agent.js'
export { createCreativeAgent } from './creative-agent.js'
export {
  createDelegationTool,
  createAllDelegationTools,
  MAX_DELEGATION_DEPTH,
  type DelegationContext,
  type DelegationRunner,
} from './bridge.js'

const MEMORY_NAMES = new Set([
  'remember',
  'forget_fact',
  'forget_recent_messages',
  'forget_all',
])
const REMINDER_NAMES = new Set([
  'set_reminder',
  'list_reminders',
  'cancel_reminder',
])

/**
 * Build the default sub-agent registry from a flat pool of tools.
 *
 * If the tools required by a particular sub-agent are missing, that sub-agent
 * is silently skipped (with a warning log) — this lets callers compose
 * partial environments (e.g. tests, no-network, no-image).
 */
export function buildDefaultRegistry(allTools: MemoryTool[]): SubAgentRegistry {
  const reg = new SubAgentRegistry()
  const byName = new Map(allTools.map((t) => [t.name, t]))

  // Memory
  const memoryTools = allTools.filter((t) => MEMORY_NAMES.has(t.name))
  if (memoryTools.length > 0) {
    reg.register(createMemoryAgent({ memory: memoryTools }))
  } else {
    log().warn('subagents: skipping memory agent — no memory tools found')
  }

  // Research
  const search = byName.get('google_search')
  const fetchUrl = byName.get('fetch_url')
  if (search && fetchUrl) {
    reg.register(createResearchAgent({ search, fetchUrl }))
  } else {
    log().warn('subagents: skipping research agent', {
      hasSearch: !!search,
      hasFetchUrl: !!fetchUrl,
    })
  }

  // Planner
  const reminderTools = allTools.filter((t) => REMINDER_NAMES.has(t.name))
  if (reminderTools.length > 0) {
    reg.register(createPlannerAgent({ reminders: reminderTools }))
  } else {
    log().warn('subagents: skipping planner agent — no reminder tools found')
  }

  // Creative
  const selfie = byName.get('generate_selfie')
  if (selfie) {
    reg.register(createCreativeAgent({ selfie }))
  } else {
    log().warn('subagents: skipping creative agent — generate_selfie not found')
  }

  return reg
}
