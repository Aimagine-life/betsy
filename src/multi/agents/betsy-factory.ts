import { LlmAgent } from '@google/adk'
import { buildSystemPromptForWorkspace } from './prompt-builder.js'
import type { Workspace } from '../workspaces/types.js'
import type { Persona } from '../personas/types.js'
import type { MemoryTool } from './tools/memory-tools.js'

export interface BetsyTools {
  memoryTools: MemoryTool[]
  reminderTools: MemoryTool[]
  selfieTool: MemoryTool
  webSearchTool?: MemoryTool
  recallTools?: MemoryTool[]
}

export interface CreateBetsyAgentInput {
  workspace: Workspace
  persona: Persona
  ownerFacts: string[]
  tools: BetsyTools
  currentChannel: 'telegram' | 'max'
  personalitySliders?: Record<string, number>
}

function pickModel(plan: Workspace['plan']): string {
  // Use stable, region-available model IDs (Vertex AI rejects "-latest" aliases).
  // These work both in AI Studio and Vertex.
  return plan === 'pro' ? 'gemini-2.5-pro' : 'gemini-2.5-flash'
}

/**
 * Creates an ADK LlmAgent configured for a specific workspace.
 *
 * Model selection: gemini-2.5-flash for trial/personal, gemini-2.5-pro for pro.
 * We use stable explicit IDs because Vertex AI does not accept the "-latest"
 * aliases that AI Studio supports.
 *
 * Tools are bound to the workspaceId by closing over it in the factory of each
 * tool (see createMemoryTools etc.). This factory only combines them into the
 * agent definition.
 *
 * GOOGLE_SEARCH is deferred: @google/adk v0.6.1 has a barrel-export quirk and
 * we ship without web search for v1.0 — follow-up task will add it.
 */
export function createBetsyAgent(input: CreateBetsyAgentInput): any {
  const { workspace, persona, ownerFacts, tools, personalitySliders } = input

  const instruction = buildSystemPromptForWorkspace({
    workspace,
    persona,
    ownerFacts,
    personalitySliders,
  })

  const allTools = [
    ...tools.memoryTools,
    ...tools.reminderTools,
    tools.selfieTool,
    ...(tools.webSearchTool ? [tools.webSearchTool] : []),
    ...(tools.recallTools ?? []),
  ]

  return new (LlmAgent as any)({
    name: `betsy_${workspace.id.replace(/-/g, '_')}`,
    model: pickModel(workspace.plan),
    instruction,
    description: `Personal Betsy for workspace ${workspace.id}`,
    tools: allTools,
  })
}
