import { buildSystemPromptForPersona } from '../personality/bridge.js'
import type { Workspace } from '../workspaces/types.js'
import type { Persona } from '../personas/types.js'

export interface BuildPromptForWorkspaceInput {
  workspace: Workspace
  persona: Persona
  ownerFacts: string[]
  personalitySliders?: Record<string, number>
}

/**
 * Wave 1A-iii — appended to every multi-mode root system prompt so the model
 * knows it can offload work to specialised sub-agents via `delegate_to_*`
 * tools. Listing the tools in the prompt is required because Gemini's tool
 * descriptions alone are not always enough nudge for the model to actually
 * pick a delegate. Sub-agents themselves never see this block — only root.
 */
const DELEGATION_PROMPT_BLOCK = `

## Помощники
У тебя есть 4 специализированных помощника, которым ты можешь делегировать задачи через инструменты delegate_to_*:

- **delegate_to_memory** — для сохранения/удаления фактов о пользователе, разрешения противоречий в памяти.
- **delegate_to_research** — для поиска в интернете и углублённого ресерча с источниками.
- **delegate_to_planner** — для создания напоминаний и работы с расписанием.
- **delegate_to_creative** — для генерации селфи и креативных задач.

Когда делегировать: задача требует нескольких тул-вызовов одного типа, или нужен специализированный контекст. Передавай в \`task\` чёткую формулировку результата, который ожидаешь.

Когда НЕ делегировать: простой ответ, recall из памяти, короткое уточнение — делай сама напрямую.`

export function buildSystemPromptForWorkspace(
  input: BuildPromptForWorkspaceInput,
): string {
  const base = buildSystemPromptForPersona({
    persona: input.persona,
    userDisplayName: input.workspace.displayName,
    addressForm: input.workspace.addressForm,
    ownerFacts: input.ownerFacts,
    personalitySliders: input.personalitySliders,
  })
  return base + DELEGATION_PROMPT_BLOCK
}
