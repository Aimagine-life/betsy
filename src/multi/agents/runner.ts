import type { GoogleGenAI } from '@google/genai'
import type { WorkspaceRepo } from '../workspaces/repo.js'
import type { PersonaRepo } from '../personas/repo.js'
import type { FactsRepo } from '../memory/facts-repo.js'
import type { ConversationRepo } from '../memory/conversation-repo.js'
import type { RemindersRepo } from '../reminders/repo.js'
import type { S3Storage } from '../storage/s3.js'
import { loadAgentContext } from './context-loader.js'
import { createBetsyAgent } from './betsy-factory.js'
import { createRunContext } from './run-context.js'
import { buildRootTools } from './root-tools.js'
import type { SkillManager } from '../skills/manager.js'
import type { CandidatesRepo as LearnerCandidatesRepo } from '../learner/candidates-repo.js'
import { speak as realSpeak } from '../gemini/tts.js'
import { runWithGeminiToolsStream } from './gemini-runner.js'
import { log } from '../observability/logger.js'
import { Summarizer } from '../memory/summarizer.js'
import { FactExtractor } from '../memory/fact-extractor.js'
import { embedText } from '../memory/embeddings.js'
import type { McpRegistry, LoadedRegistry } from './mcp/registry.js'

const SUMMARIZER_THRESHOLD = Number(process.env.BC_SUMMARIZER_THRESHOLD ?? 150)
const SUMMARIZER_KEEP_RECENT = Number(process.env.BC_SUMMARIZER_KEEP_RECENT ?? 50)

const SUMMARIZER_DELAY_MS = Number(process.env.BC_SUMMARIZER_DELAY_MS ?? 30_000)

const EXTRACTOR_ENABLED = (process.env.BC_EXTRACTOR_ENABLED ?? 'true') !== 'false'
const EXTRACTOR_DELAY_MS = Number(process.env.BC_EXTRACTOR_DELAY_MS ?? 10_000)

/**
 * Background backfill: pick facts with null embeddings and compute them.
 * Called once per assistant turn; processes up to 20 facts per call.
 */
function fireAndForgetBackfillEmbeddings(deps: RunBetsyDeps, workspaceId: string): void {
  setTimeout(() => {
    void (async () => {
      try {
        const missing = await deps.factsRepo.listMissingEmbeddings(workspaceId, 20)
        if (missing.length === 0) return
        log().info('backfill: computing embeddings for facts without vectors', {
          workspaceId,
          count: missing.length,
        })
        for (const fact of missing) {
          try {
            const vec = await embedText(deps.gemini, fact.content)
            await deps.factsRepo.setEmbedding(workspaceId, fact.id, vec)
          } catch (e) {
            log().warn('backfill: embedding failed for fact', {
              workspaceId,
              factId: fact.id,
              error: e instanceof Error ? e.message : String(e),
            })
          }
        }
        log().info('backfill: done', { workspaceId, processed: missing.length })
      } catch (e) {
        log().error('backfill: unexpected error', {
          workspaceId,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    })()
  }, 0).unref()
}

/**
 * Background passive fact extraction from the last user/assistant exchange.
 * Runs after a configurable delay so it doesn't compete for rate-limit slots.
 */
function fireAndForgetExtract(
  deps: RunBetsyDeps,
  workspaceId: string,
  userMessage: string,
  assistantText: string,
): void {
  if (!EXTRACTOR_ENABLED) return
  const extractor = new FactExtractor({ gemini: deps.gemini, factsRepo: deps.factsRepo })
  setTimeout(() => {
    void extractor
      .maybeExtract({
        workspaceId,
        lastUserMessage: userMessage,
        lastAssistantMessage: assistantText,
      })
      .catch((e) =>
        log().error('extractor: background run failed', {
          workspaceId,
          error: e instanceof Error ? e.message : String(e),
        }),
      )
  }, EXTRACTOR_DELAY_MS).unref()
}

function fireAndForgetSummarize(deps: RunBetsyDeps, workspaceId: string): void {
  const summarizer = new Summarizer({
    gemini: deps.gemini,
    convRepo: deps.convRepo,
    factsRepo: deps.factsRepo,
  })
  // Delay so we don't compete with the just-finished response loop for rate limit slots
  setTimeout(() => {
    void summarizer
      .maybeSummarize({
        workspaceId,
        threshold: SUMMARIZER_THRESHOLD,
        keepRecent: SUMMARIZER_KEEP_RECENT,
      })
      .catch((e) =>
        log().error('summarizer: background run failed', {
          workspaceId,
          error: e instanceof Error ? e.message : String(e),
        }),
      )
  }, SUMMARIZER_DELAY_MS).unref()
}

export interface RunBetsyDeps {
  wsRepo: WorkspaceRepo
  personaRepo: PersonaRepo
  factsRepo: FactsRepo
  convRepo: ConversationRepo
  remindersRepo: RemindersRepo
  s3: S3Storage
  gemini: GoogleGenAI
  /**
   * Function that actually runs the ADK agent and returns text.
   * Injected for testability; production wires it to ADK's agent.run().
   * `history` is the prior conversation (oldest first), so the runner can
   * include it in the model's context window.
   */
  agentRunner: (
    agent: any,
    userMessage: string,
    history?: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>,
  ) => Promise<{
    text: string
    toolCalls: unknown[]
    tokensUsed: number
  }>
  /** Injected for testability */
  ttsSpeak?: typeof realSpeak
  /** Optional per-workspace MCP server registry. When set, the runner loads
   *  the workspace's enabled MCP servers and bridges their tools into the
   *  agent. Failures are non-fatal — the agent runs without MCP if loading
   *  fails. Leave undefined in tests / setups without Postgres MCP wiring. */
  mcpRegistry?: McpRegistry
  /** Wave 1C — workspace skills. Optional: when provided, run_skill / list_skills
   *  are exposed to the agent and can execute per-workspace YAML skills. */
  skillManager?: SkillManager
  // WAVE2-MERGE: Waves 2B (critic) and 2C (feedback) also inject their
  // services into RunBetsyDeps here. Keep additions additive + optional.
  /** Wave 2A — LearnerAgent candidate repo. Optional; when wired, the root
   *  agent exposes list/approve/reject candidate tools. */
  learnerCandidatesRepo?: LearnerCandidatesRepo
}

/**
 * Try to load MCP tools for a workspace. Never throws — on any failure
 * returns an empty registry-like object so the caller can ignore it. The
 * returned object always has a `closeAll()` method, so callers can defer
 * shutdown without conditionals.
 */
async function loadMcpToolsSafe(
  registry: McpRegistry | undefined,
  workspaceId: string,
): Promise<LoadedRegistry | null> {
  if (!registry) return null
  try {
    return await registry.loadForWorkspace(workspaceId)
  } catch (e) {
    log().warn('runBetsy: mcp registry load failed, continuing without MCP', {
      workspaceId,
      error: e instanceof Error ? e.message : String(e),
    })
    return null
  }
}

export interface RunBetsyInput {
  workspaceId: string
  userMessage: string
  channel: 'telegram' | 'max'
  deps: RunBetsyDeps
  /** When true, do NOT persist the user message (caller already did it).
   *  Used by retry loops to avoid duplicating the user turn in conversation. */
  skipAppendUser?: boolean
  /** When set, forces the LLM to call exactly this tool on its first turn.
   *  Used to bypass history-poisoning when the user clearly asks for a specific
   *  action (e.g. selfie) and we don't want the model to "rationalize" a refusal. */
  forceTool?: string
  /** Chat-id of the current inbound message (required for recall + chat_id plumbing). */
  currentChatId: string
}

export interface BetsyResponse {
  text: string
  audio?: { base64: string; mimeType: string }
  toolCalls: unknown[]
  tokensUsed: number
  /** Set by set_reply_target tool — outgoing reply should quote this message id. */
  replyTo?: number
  /** bc_conversation.id of the just-persisted assistant row, so the caller can
   *  update it with the outbound external_message_id once the channel send returns. */
  assistantRowId?: string
}

export async function runBetsy(input: RunBetsyInput): Promise<BetsyResponse> {
  const { workspaceId, userMessage, channel, deps } = input
  const ttsSpeak = deps.ttsSpeak ?? realSpeak

  const workspace = await deps.wsRepo.findById(workspaceId)
  if (!workspace) throw new Error(`workspace not found: ${workspaceId}`)

  const persona = await deps.personaRepo.findByWorkspace(workspaceId)
  if (!persona) throw new Error(`persona not found for workspace: ${workspaceId}`)

  const runContext = createRunContext()

  const context = await loadAgentContext({
    factsRepo: deps.factsRepo,
    convRepo: deps.convRepo,
    workspaceId,
    factLimit: Number(process.env.BC_FACT_LIMIT ?? 100),
    historyLimit: Number(process.env.BC_HISTORY_LIMIT ?? 200),
    userQuery: userMessage,
    gemini: deps.gemini,
  })

  // Wave 1B: bridge per-workspace MCP server tools, if a registry is wired in.
  // Failures are isolated — agent always runs even if MCP is misconfigured.
  const mcpLoaded = await loadMcpToolsSafe(deps.mcpRegistry, workspaceId)

  // Wave 1A-iii: centralised tool composition. Builds leaf tools, sub-agent
  // delegation tools, and skill tools in one place so runBetsy + runBetsyStream
  // stay in sync.
  const bundle = buildRootTools(deps, {
    workspaceId,
    channel,
    currentChatId: input.currentChatId,
    runContext,
    mcpLoaded,
  })

  const agent = createBetsyAgent({
    workspace,
    persona,
    ownerFacts: context.factContents,
    // Pass the pre-assembled flat list via the legacy field shape: leafTools
    // already includes memory/reminder/selfie/search/recall/mcp, so we hand
    // them through as one bucket plus the new delegation/skill buckets.
    tools: {
      memoryTools: bundle.leafTools,
      reminderTools: [],
      delegationTools: bundle.delegationTools,
      skillTools: bundle.skillTools,
    },
    currentChannel: channel,
  })

  log().info('runBetsy: start', {
    workspaceId,
    channel,
    userMsgLen: userMessage.length,
    skipAppendUser: input.skipAppendUser,
    mcpToolCount: mcpLoaded?.getTools().length ?? 0,
    delegationToolCount: bundle.delegationTools.length,
    skillToolCount: bundle.skillTools.length,
  })

  // Store user message first (unless caller already did it for retry semantics)
  if (!input.skipAppendUser) {
    try {
      await deps.convRepo.append(workspaceId, {
        channel,
        role: 'user',
        content: userMessage,
        chatId: input.currentChatId,
      })
      log().info('runBetsy: user message appended', { workspaceId })
    } catch (e) {
      log().error('runBetsy: append user failed', {
        workspaceId,
        error: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
  }

  let result: { text: string; toolCalls: unknown[]; tokensUsed: number }
  try {
    result = await deps.agentRunner(agent, userMessage, context.history)
    log().info('runBetsy: agent done', {
      workspaceId,
      textLen: result.text?.length ?? 0,
      toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
      tokensUsed: result.tokensUsed,
    })
  } catch (e) {
    log().error('runBetsy: agentRunner failed', {
      workspaceId,
      error: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    })
    throw e
  }

  // Store assistant reply
  let assistantRowId: string | undefined
  try {
    const row = await deps.convRepo.append(workspaceId, {
      channel,
      role: 'assistant',
      content: result.text,
      toolCalls: result.toolCalls,
      tokensUsed: result.tokensUsed,
      chatId: input.currentChatId,
    })
    assistantRowId = row.id
    log().info('runBetsy: assistant message appended', { workspaceId, rowId: row.id })
  } catch (e) {
    log().error('runBetsy: append assistant failed', {
      workspaceId,
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }

  // Background: rolling-window summarization (don't block reply)
  fireAndForgetSummarize(deps, workspaceId)
  // Background: passive fact extraction from this exchange
  fireAndForgetExtract(deps, workspaceId, userMessage, result.text)
  // Background: backfill embeddings for any facts that are missing them
  fireAndForgetBackfillEmbeddings(deps, workspaceId)

  // Decide whether to speak
  const voiceBehavior = persona.behaviorConfig.voice
  const shouldSpeak = voiceBehavior === 'voice_always'

  let audio: BetsyResponse['audio'] | undefined
  if (shouldSpeak) {
    try {
      const tts = await ttsSpeak(deps.gemini, result.text, persona.voiceId)
      audio = { base64: tts.audioBase64, mimeType: tts.mimeType }
    } catch {
      // TTS failure is non-fatal — return text only
    }
  }

  // Graceful MCP shutdown — fire-and-forget so we don't delay reply.
  if (mcpLoaded) {
    void mcpLoaded.closeAll().catch(() => {})
  }

  return {
    text: result.text,
    audio,
    toolCalls: result.toolCalls,
    tokensUsed: result.tokensUsed,
    replyTo: runContext.replyTarget,
    assistantRowId,
  }
}

export interface RunBetsyStreamResult {
  /** Full-text-so-far accumulating async iterable; consumed by channel adapters
   *  that support streaming (e.g. Telegram sendMessageDraft). */
  textStream: AsyncIterable<string>
  /** Resolves once the assistant message has been fully generated and persisted. */
  done: Promise<{ text: string; toolCalls: unknown[]; tokensUsed: number; replyTo?: number }>
  /** Resolves (same as `done`) with just the reply target, for the channel
   *  adapter's streamMessage to await before its final send. */
  replyToPromise: Promise<number | undefined>
  /** The bc_conversation row id of the assistant message once it has been
   *  persisted. */
  assistantRowIdPromise: Promise<string | undefined>
}

/**
 * Streaming variant of {@link runBetsy}. Loads workspace + persona + context
 * exactly the same way, persists the user message, then drives Gemini in
 * streaming mode and exposes a textStream the caller can pipe into a channel
 * adapter's streamMessage. After the stream completes, the assistant reply is
 * persisted to the conversation log.
 *
 * Note: voice/TTS is intentionally NOT supported by the streaming path — voice
 * needs the full text up front. Callers that require voice should fall back to
 * the non-streaming runBetsy.
 */
export async function runBetsyStream(input: RunBetsyInput): Promise<RunBetsyStreamResult> {
  const { workspaceId, userMessage, channel, deps } = input

  const workspace = await deps.wsRepo.findById(workspaceId)
  if (!workspace) throw new Error(`workspace not found: ${workspaceId}`)

  const persona = await deps.personaRepo.findByWorkspace(workspaceId)
  if (!persona) throw new Error(`persona not found for workspace: ${workspaceId}`)

  const runContext = createRunContext()

  const context = await loadAgentContext({
    factsRepo: deps.factsRepo,
    convRepo: deps.convRepo,
    workspaceId,
    factLimit: Number(process.env.BC_FACT_LIMIT ?? 100),
    historyLimit: Number(process.env.BC_HISTORY_LIMIT ?? 200),
    userQuery: userMessage,
    gemini: deps.gemini,
  })

  const mcpLoaded = await loadMcpToolsSafe(deps.mcpRegistry, workspaceId)

  // Wave 1A-iii: shared tool composition (see runBetsy above for rationale).
  const bundle = buildRootTools(deps, {
    workspaceId,
    channel,
    currentChatId: input.currentChatId,
    runContext,
    mcpLoaded,
  })

  const agent = createBetsyAgent({
    workspace,
    persona,
    ownerFacts: context.factContents,
    tools: {
      memoryTools: bundle.leafTools,
      reminderTools: [],
      delegationTools: bundle.delegationTools,
      skillTools: bundle.skillTools,
    },
    currentChannel: channel,
  })

  log().info('runBetsyStream: agent built', {
    workspaceId,
    channel,
    userMsgLen: userMessage.length,
    ownerFactsCount: context.factContents.length,
    historyCount: context.history.length,
    mcpToolCount: mcpLoaded?.getTools().length ?? 0,
    delegationToolCount: bundle.delegationTools.length,
    skillToolCount: bundle.skillTools.length,
  })

  if (!input.skipAppendUser) {
    try {
      await deps.convRepo.append(workspaceId, {
        channel,
        role: 'user',
        content: userMessage,
        chatId: input.currentChatId,
      })
    } catch (e) {
      log().error('runBetsyStream: append user failed', {
        workspaceId,
        error: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
  }

  const { textStream: rawStream, finalize } = await runWithGeminiToolsStream(
    deps.gemini,
    agent,
    userMessage,
    context.history,
    { forceTool: input.forceTool },
  )

  // Wrap raw stream so the consumer can iterate exactly once and we still get
  // a chance to observe completion before resolving `done`.
  const wrappedStream: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      for await (const text of rawStream) {
        yield text
      }
    },
  }

  // Two resolvers exposed so the channel adapter can await the reply target
  // before its final send.
  let resolveReply!: (v: number | undefined) => void
  let resolveRowId!: (v: string | undefined) => void
  const replyToPromise: Promise<number | undefined> = new Promise((r) => {
    resolveReply = r
  })
  const assistantRowIdPromise: Promise<string | undefined> = new Promise((r) => {
    resolveRowId = r
  })

  const done = (async () => {
    let result: { text: string; toolCalls: unknown[]; tokensUsed: number }
    try {
      result = await finalize()
    } catch (e) {
      resolveReply(undefined)
      resolveRowId(undefined)
      throw e
    }
    // Agent loop is done — the reply target is now stable.
    resolveReply(runContext.replyTarget)

    log().info('runBetsyStream: agent done', {
      workspaceId,
      textLen: result.text?.length ?? 0,
      toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
      tokensUsed: result.tokensUsed,
      replyTo: runContext.replyTarget,
    })

    let assistantRowId: string | undefined
    try {
      const row = await deps.convRepo.append(workspaceId, {
        channel,
        role: 'assistant',
        content: result.text,
        toolCalls: result.toolCalls,
        tokensUsed: result.tokensUsed,
        chatId: input.currentChatId,
      })
      assistantRowId = row.id
      resolveRowId(assistantRowId)
    } catch (e) {
      resolveRowId(undefined)
      log().error('runBetsyStream: append assistant failed', {
        workspaceId,
        error: e instanceof Error ? e.message : String(e),
      })
      throw e
    }

    fireAndForgetSummarize(deps, workspaceId)
    fireAndForgetExtract(deps, workspaceId, userMessage, result.text)
    fireAndForgetBackfillEmbeddings(deps, workspaceId)

    if (mcpLoaded) {
      void mcpLoaded.closeAll().catch(() => {})
    }

    return {
      text: result.text,
      toolCalls: result.toolCalls,
      tokensUsed: result.tokensUsed,
      replyTo: runContext.replyTarget,
    }
  })()

  return { textStream: wrappedStream, done, replyToPromise, assistantRowIdPromise }
}
