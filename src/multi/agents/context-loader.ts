import type { FactsRepo } from '../memory/facts-repo.js'
import type { ConversationRepo } from '../memory/conversation-repo.js'

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
}

export async function loadAgentContext(input: LoadContextInput): Promise<AgentContext> {
  const { factsRepo, convRepo, workspaceId, factLimit, historyLimit } = input

  const facts = await factsRepo.list(workspaceId, factLimit)
  const rawHistory = await convRepo.recent(workspaceId, historyLimit)

  return {
    factContents: facts.map((f) => f.content),
    history: rawHistory
      .slice()
      .reverse()
      .map((m: any) => ({
        role: m.role as 'user' | 'assistant' | 'tool',
        content: m.content,
      })),
  }
}
