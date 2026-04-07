import type { SubAgent } from './types.js'

/**
 * In-memory registry of sub-agents. Pure container — no I/O, no globals.
 *
 * Bridge / wiring (wave 1A-ii) will look up sub-agents here and turn them
 * into delegation tools surfaced to the root Betsy agent.
 */
export class SubAgentRegistry {
  private readonly agents = new Map<string, SubAgent>()

  /** Register a sub-agent. Throws on duplicate name. */
  register(agent: SubAgent): void {
    if (this.agents.has(agent.name)) {
      throw new Error(`SubAgentRegistry: duplicate sub-agent '${agent.name}'`)
    }
    this.agents.set(agent.name, agent)
  }

  /** Lookup by name. Returns undefined if absent. */
  get(name: string): SubAgent | undefined {
    return this.agents.get(name)
  }

  /** Existence check. */
  has(name: string): boolean {
    return this.agents.has(name)
  }

  /** All registered sub-agents, in insertion order. */
  list(): SubAgent[] {
    return Array.from(this.agents.values())
  }

  /** Number of registered sub-agents. */
  get size(): number {
    return this.agents.size
  }
}
