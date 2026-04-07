import { buildSystemPromptForPersona } from '../personality/bridge.js'
import type { Workspace } from '../workspaces/types.js'
import type { Persona } from '../personas/types.js'

export interface BuildPromptForWorkspaceInput {
  workspace: Workspace
  persona: Persona
  ownerFacts: string[]
  personalitySliders?: Record<string, number>
}

export function buildSystemPromptForWorkspace(
  input: BuildPromptForWorkspaceInput,
): string {
  return buildSystemPromptForPersona({
    persona: input.persona,
    userDisplayName: input.workspace.displayName,
    addressForm: input.workspace.addressForm,
    ownerFacts: input.ownerFacts,
    personalitySliders: input.personalitySliders,
  })
}
