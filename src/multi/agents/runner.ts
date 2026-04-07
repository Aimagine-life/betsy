import type { GoogleGenAI } from '@google/genai'
import type { WorkspaceRepo } from '../workspaces/repo.js'
import type { PersonaRepo } from '../personas/repo.js'
import type { FactsRepo } from '../memory/facts-repo.js'
import type { ConversationRepo } from '../memory/conversation-repo.js'
import type { RemindersRepo } from '../reminders/repo.js'
import type { S3Storage } from '../storage/s3.js'
import { loadAgentContext } from './context-loader.js'
import { createMemoryTools } from './tools/memory-tools.js'
import { createReminderTools } from './tools/reminder-tools.js'
import { createSelfieTool } from './tools/selfie-tool.js'
import { createBetsyAgent } from './betsy-factory.js'
import { speak as realSpeak } from '../gemini/tts.js'
import { runWithGeminiToolsStream } from './gemini-runner.js'
import { log } from '../observability/logger.js'
import { Summarizer } from '../memory/summarizer.js'

const SUMMARIZER_THRESHOLD = Number(process.env.BC_SUMMARIZER_THRESHOLD ?? 150)
const SUMMARIZER_KEEP_RECENT = Number(process.env.BC_SUMMARIZER_KEEP_RECENT ?? 50)

function fireAndForgetSummarize(deps: RunBetsyDeps, workspaceId: string): void {
  const summarizer = new Summarizer({
    gemini: deps.gemini,
    convRepo: deps.convRepo,
    factsRepo: deps.factsRepo,
  })
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
}

export interface RunBetsyInput {
  workspaceId: string
  userMessage: string
  channel: 'telegram' | 'max'
  deps: RunBetsyDeps
}

export interface BetsyResponse {
  text: string
  audio?: { base64: string; mimeType: string }
  toolCalls: unknown[]
  tokensUsed: number
}

export async function runBetsy(input: RunBetsyInput): Promise<BetsyResponse> {
  const { workspaceId, userMessage, channel, deps } = input
  const ttsSpeak = deps.ttsSpeak ?? realSpeak

  const workspace = await deps.wsRepo.findById(workspaceId)
  if (!workspace) throw new Error(`workspace not found: ${workspaceId}`)

  const persona = await deps.personaRepo.findByWorkspace(workspaceId)
  if (!persona) throw new Error(`persona not found for workspace: ${workspaceId}`)

  const context = await loadAgentContext({
    factsRepo: deps.factsRepo,
    convRepo: deps.convRepo,
    workspaceId,
    factLimit: Number(process.env.BC_FACT_LIMIT ?? 100),
    historyLimit: Number(process.env.BC_HISTORY_LIMIT ?? 200),
  })

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
    gemini: deps.gemini,
    workspaceId,
  })

  const agent = createBetsyAgent({
    workspace,
    persona,
    ownerFacts: context.factContents,
    tools: { memoryTools, reminderTools, selfieTool },
    currentChannel: channel,
  })

  log().info('runBetsy: start', { workspaceId, channel, userMsgLen: userMessage.length })

  // Store user message first
  try {
    await deps.convRepo.append(workspaceId, {
      channel,
      role: 'user',
      content: userMessage,
    } as any)
    log().info('runBetsy: user message appended', { workspaceId })
  } catch (e) {
    log().error('runBetsy: append user failed', {
      workspaceId,
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
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
  try {
    await deps.convRepo.append(workspaceId, {
      channel,
      role: 'assistant',
      content: result.text,
      toolCalls: result.toolCalls,
      tokensUsed: result.tokensUsed,
    } as any)
    log().info('runBetsy: assistant message appended', { workspaceId })
  } catch (e) {
    log().error('runBetsy: append assistant failed', {
      workspaceId,
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }

  // Background: rolling-window summarization (don't block reply)
  fireAndForgetSummarize(deps, workspaceId)

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

  return {
    text: result.text,
    audio,
    toolCalls: result.toolCalls,
    tokensUsed: result.tokensUsed,
  }
}

export interface RunBetsyStreamResult {
  /** Full-text-so-far accumulating async iterable; consumed by channel adapters
   *  that support streaming (e.g. Telegram sendMessageDraft). */
  textStream: AsyncIterable<string>
  /** Resolves once the assistant message has been fully generated and persisted. */
  done: Promise<{ text: string; toolCalls: unknown[]; tokensUsed: number }>
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

  const context = await loadAgentContext({
    factsRepo: deps.factsRepo,
    convRepo: deps.convRepo,
    workspaceId,
    factLimit: Number(process.env.BC_FACT_LIMIT ?? 100),
    historyLimit: Number(process.env.BC_HISTORY_LIMIT ?? 200),
  })

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
    gemini: deps.gemini,
    workspaceId,
  })

  const agent = createBetsyAgent({
    workspace,
    persona,
    ownerFacts: context.factContents,
    tools: { memoryTools, reminderTools, selfieTool },
    currentChannel: channel,
  })

  log().info('runBetsyStream: agent built', {
    workspaceId,
    channel,
    userMsgLen: userMessage.length,
    ownerFactsCount: context.factContents.length,
    historyCount: context.history.length,
  })

  try {
    await deps.convRepo.append(workspaceId, {
      channel,
      role: 'user',
      content: userMessage,
    } as any)
  } catch (e) {
    log().error('runBetsyStream: append user failed', {
      workspaceId,
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }

  const { textStream: rawStream, finalize } = await runWithGeminiToolsStream(
    deps.gemini,
    agent,
    userMessage,
    context.history,
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

  const done = (async () => {
    const result = await finalize()
    log().info('runBetsyStream: agent done', {
      workspaceId,
      textLen: result.text?.length ?? 0,
      toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
      tokensUsed: result.tokensUsed,
    })
    try {
      await deps.convRepo.append(workspaceId, {
        channel,
        role: 'assistant',
        content: result.text,
        toolCalls: result.toolCalls,
        tokensUsed: result.tokensUsed,
      } as any)
    } catch (e) {
      log().error('runBetsyStream: append assistant failed', {
        workspaceId,
        error: e instanceof Error ? e.message : String(e),
      })
    }
    // Background: rolling-window summarization (don't block reply)
    fireAndForgetSummarize(deps, workspaceId)
    return {
      text: result.text,
      toolCalls: result.toolCalls,
      tokensUsed: result.tokensUsed,
    }
  })()

  return { textStream: wrappedStream, done }
}
