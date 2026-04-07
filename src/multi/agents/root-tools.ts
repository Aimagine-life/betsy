/**
 * Wave 1A-iii — root-tool composition helper.
 *
 * Centralises the assembly of every tool the root Betsy agent gets so that
 * `runBetsy` and `runBetsyStream` stop diverging. Also wires sub-agent
 * delegation tools (`delegate_to_*`) and the `fetch_url` tool that research
 * sub-agent depends on.
 *
 * Layering:
 *  - leafTools     — direct, low-level tools (memory, recall, reminders,
 *                    selfie, search, fetch_url, MCP). These are the same
 *                    set the sub-agents see — sub-agents never get
 *                    delegation tools or skill tools.
 *  - delegationTools — synthetic delegate_to_<name> tools, one per sub-agent.
 *  - skillTools    — run_skill / list_skills (root-only privilege).
 *  - allRootTools  — concatenation; this is what the root agent receives.
 *
 * NOTE: leaf tools are intentionally NOT removed from the root pool in this
 * wave. Root keeps direct access to everything; delegation is *additive*.
 * WAVE2-TODO: consider removing direct tools after sub-agents prove
 * themselves in eval.
 */
import type { GoogleGenAI } from '@google/genai'
import type { MemoryTool } from './tools/memory-tools.js'
import type { LoadedRegistry } from './mcp/registry.js'
import type { SkillManager } from '../skills/manager.js'
import type { SkillLLM } from '../skills/executor.js'
import { createMemoryTools } from './tools/memory-tools.js'
import { createReminderTools } from './tools/reminder-tools.js'
import { createSelfieTool } from './tools/selfie-tool.js'
import { createWebSearchTool } from './tools/web-search-tool.js'
import { createFetchUrlTool } from './tools/fetch-url-tool.js'
import { createRecallTools } from './tools/recall-tools.js'
import { createSkillTools } from '../skills/skill-tool.js'
import { createLearnerTools } from '../learner/learner-tools.js'
import type { CandidatesRepo } from '../learner/candidates-repo.js'
// WAVE3C-MERGE: oauth integration tools
import { createOAuthTools, type OAuthToolsDeps } from '../oauth/oauth-tools.js'
import {
  buildDefaultRegistry,
  createAllDelegationTools,
} from './subagents/index.js'
import { log } from '../observability/logger.js'
import type { FactsRepo } from '../memory/facts-repo.js'
import type { ConversationRepo } from '../memory/conversation-repo.js'
import type { RemindersRepo } from '../reminders/repo.js'
import type { PersonaRepo } from '../personas/repo.js'
import type { S3Storage } from '../storage/s3.js'
import type { RunContext } from './run-context.js'

export interface BuildRootToolsDeps {
  factsRepo: FactsRepo
  convRepo: ConversationRepo
  remindersRepo: RemindersRepo
  personaRepo: PersonaRepo
  s3: S3Storage
  gemini: GoogleGenAI
  skillManager?: SkillManager
  // WAVE2-MERGE: Waves 2B (critic) and 2C (feedback) also add optional deps here.
  /** Wave 2A — LearnerAgent candidates repo. When present, root agent gets
   *  list/approve/reject candidate tools. */
  learnerCandidatesRepo?: CandidatesRepo
}

export interface BuildRootToolsOptions {
  workspaceId: string
  channel: 'telegram' | 'max'
  currentChatId: string
  runContext: RunContext
  /** Already-loaded MCP tools (or null). The caller owns lifecycle. */
  mcpLoaded: LoadedRegistry | null
  /** Optional traceId for log correlation in delegation. */
  traceId?: string
  // WAVE3C-MERGE: when present, root gets list/connect/disconnect/status
  //               integration tools. Leaf tool set is untouched (sub-agents
  //               don't see these). Absent = zero behaviour change.
  oauthToolsDeps?: OAuthToolsDeps
}

export interface RootToolBundle {
  /** Direct, low-level tools — also passed to sub-agents. */
  leafTools: MemoryTool[]
  /** delegate_to_<name> tools, one per registered sub-agent. */
  delegationTools: MemoryTool[]
  /** run_skill / list_skills — root-only. May be empty if no SkillManager. */
  skillTools: MemoryTool[]
  /** Concatenation passed to the root agent. */
  allRootTools: MemoryTool[]
}

/**
 * Build the full tool bundle for the root agent. Pure (no I/O) apart from
 * what each tool factory does internally; deterministic for the same inputs.
 */
export function buildRootTools(
  deps: BuildRootToolsDeps,
  options: BuildRootToolsOptions,
): RootToolBundle {
  const { workspaceId, channel, currentChatId, runContext, mcpLoaded } = options

  const memoryTools = createMemoryTools({
    factsRepo: deps.factsRepo,
    convRepo: deps.convRepo,
    gemini: deps.gemini,
    workspaceId,
  })
  const reminderTools = createReminderTools({
    remindersRepo: deps.remindersRepo,
    workspaceId,
    currentChannel: channel,
  })
  const selfieTool = createSelfieTool({
    personaRepo: deps.personaRepo,
    s3: deps.s3,
    factsRepo: deps.factsRepo,
    gemini: deps.gemini,
    workspaceId,
  })
  const webSearchTool = createWebSearchTool(deps.gemini)
  const fetchUrlTool = createFetchUrlTool()
  const recallTools = createRecallTools({
    convRepo: deps.convRepo,
    gemini: deps.gemini,
    workspaceId,
    currentChatId,
    currentChannel: channel,
    runContext,
  })
  const mcpTools = mcpLoaded?.getTools() ?? []

  // Leaf pool — passed to sub-agents AND root.
  const leafTools: MemoryTool[] = [
    ...memoryTools,
    ...reminderTools,
    selfieTool,
    webSearchTool,
    fetchUrlTool,
    ...recallTools,
    ...mcpTools,
  ]

  // Sub-agent registry. buildDefaultRegistry silently skips sub-agents whose
  // required tools are missing — so a misconfigured workspace just gets fewer
  // delegation options, never a crash.
  const subagentRegistry = buildDefaultRegistry(leafTools)
  const delegationTools =
    subagentRegistry.size > 0
      ? createAllDelegationTools(subagentRegistry, {
          gemini: deps.gemini,
          parentDepth: 0,
          workspaceId,
          traceId: options.traceId,
        })
      : []

  // Skill tools — root-only, never given to sub-agents.
  // The skill executor gets `leafTools` minus run_skill/list_skills, so a
  // skill cannot recursively call itself or other skills.
  let skillTools: MemoryTool[] = []
  if (deps.skillManager) {
    const skillLlm: SkillLLM = {
      async generateText(prompt: string): Promise<string> {
        const resp: any = await deps.gemini.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        })
        return (
          (resp as any).text ??
          (resp as any).candidates?.[0]?.content?.parts?.[0]?.text ??
          ''
        )
      },
    }
    skillTools = createSkillTools({
      workspaceId,
      manager: deps.skillManager,
      llm: skillLlm,
      logger: log(),
      // Skills get the leaf pool only — no skill recursion, no delegation.
      getRunnableTools: () =>
        leafTools.filter(
          (t) => t.name !== 'run_skill' && t.name !== 'list_skills',
        ),
    })
  }

  // Wave 2A — learner candidate tools (root-only). Purely opt-in: absent
  // when deps.learnerCandidatesRepo is undefined (e.g. in tests that don't
  // wire the Learner).
  const learnerTools: MemoryTool[] = deps.learnerCandidatesRepo
    ? createLearnerTools({
        workspaceId,
        candidatesRepo: deps.learnerCandidatesRepo,
      })
    : []

  // WAVE3C-MERGE: oauth integration tools (root-only, opt-in).
  const oauthTools: MemoryTool[] = options.oauthToolsDeps
    ? createOAuthTools(options.oauthToolsDeps)
    : []

  const allRootTools: MemoryTool[] = [
    ...leafTools,
    ...delegationTools,
    ...skillTools,
    ...learnerTools,
    ...oauthTools,
  ]

  return { leafTools, delegationTools, skillTools, allRootTools }
}
