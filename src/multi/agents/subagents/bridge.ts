/**
 * Delegation bridge — wave 1A-ii.
 *
 * Turns each sub-agent into a synthetic `MemoryTool` named
 * `delegate_to_<agent.name>`. When the root Betsy agent calls one of these
 * tools, we recursively launch a nested Gemini tool-loop using the sub-agent's
 * own system prompt and toolbox via `runWithGeminiTools`.
 *
 * This module is purely additive: it does not touch the runner, betsy-factory,
 * existing tools, or any other Wave 1A-i / 1B / 1C wiring.
 */
import { z } from 'zod'
import type { GoogleGenAI } from '@google/genai'
import type { MemoryTool } from '../tools/memory-tools.js'
import type { SubAgent } from './types.js'
import type { SubAgentRegistry } from './registry.js'
import { runWithGeminiTools, type GeminiRunResult } from '../gemini-runner.js'
import { log } from '../../observability/logger.js'
import { withSpan } from '../../observability/tracing.js'

/**
 * Maximum nesting depth for delegation. With MAX = 1, root → sub is allowed
 * but a sub-agent cannot delegate further (sub → sub blocked). This keeps the
 * blast radius bounded and avoids accidental recursion / cost spirals.
 */
export const MAX_DELEGATION_DEPTH = 1

/**
 * Inner-runner contract — matches the real `runWithGeminiTools` signature.
 * Exposed as a type so tests can inject a stub via the optional `runner`
 * parameter on `createDelegationTool`.
 */
export type DelegationRunner = (
  gemini: GoogleGenAI,
  agent: { instruction: string; model: string; tools: MemoryTool[] },
  userMessage: string,
  history?: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>,
) => Promise<GeminiRunResult>

export interface DelegationContext {
  /** Gemini client, threaded through from the root runner. */
  gemini: GoogleGenAI
  /** 0 = invoked from root; >=1 = nested delegation. */
  parentDepth?: number
  /** Optional workspace id for log correlation. */
  workspaceId?: string
  /** Optional trace id for log correlation. */
  traceId?: string
}

const taskParameters = z.object({
  task: z
    .string()
    .min(1)
    .describe('Что нужно сделать. Будь конкретен.'),
  context: z
    .string()
    .optional()
    .describe('Релевантный контекст из текущего диалога.'),
})

/**
 * Build a single delegation tool that wraps `agent`. The optional `runner`
 * parameter exists purely for dependency-injection in tests; production
 * callers should leave it undefined so the real `runWithGeminiTools` is used.
 */
export function createDelegationTool(
  agent: SubAgent,
  ctx: DelegationContext,
  runner: DelegationRunner = runWithGeminiTools as unknown as DelegationRunner,
): MemoryTool {
  const name = `delegate_to_${agent.name}`
  const description = `Делегировать задачу помощнику ${agent.name}. ${agent.description}. Передавай в \`task\` чёткую формулировку — помощник вернёт результат текстом.`

  return {
    name,
    description,
    parameters: taskParameters,
    async execute(params: any): Promise<unknown> {
      return withSpan(
        `betsy.subagent.${agent.name}`,
        () => executeImpl(params),
        {
          agent: agent.name,
          depth: ctx.parentDepth ?? 0,
          taskLen: typeof params?.task === 'string' ? params.task.length : 0,
        },
      )
    },
  }

  async function executeImpl(params: any): Promise<unknown> {
      const parsed = taskParameters.safeParse(params ?? {})
      if (!parsed.success) {
        return { error: 'invalid params: ' + parsed.error.message }
      }
      const { task, context } = parsed.data

      const currentDepth = ctx.parentDepth ?? 0
      if (currentDepth >= MAX_DELEGATION_DEPTH) {
        log().warn('subagent: delegation depth exceeded', {
          to: agent.name,
          depth: currentDepth,
          maxDepth: MAX_DELEGATION_DEPTH,
          traceId: ctx.traceId,
          workspaceId: ctx.workspaceId,
        })
        return { error: 'delegation depth exceeded', maxDepth: MAX_DELEGATION_DEPTH }
      }

      const nextDepth = currentDepth + 1
      const startedAt = Date.now()

      log().info('subagent: delegating', {
        from: currentDepth === 0 ? 'root' : `depth-${currentDepth}`,
        to: agent.name,
        depth: nextDepth,
        taskLen: task.length,
        hasContext: !!context,
        traceId: ctx.traceId,
        workspaceId: ctx.workspaceId,
      })

      // Build a fresh DelegationContext for the inner call so any
      // delegate_to_* tool nested inside the sub-agent's own toolbox sees
      // an incremented depth and refuses to recurse.
      const innerCtx: DelegationContext = {
        gemini: ctx.gemini,
        parentDepth: nextDepth,
        workspaceId: ctx.workspaceId,
        traceId: ctx.traceId,
      }
      void innerCtx // currently sub-agents in registry use plain MemoryTools;
      // depth propagation matters only when sub-agent tools are themselves
      // built via createDelegationTool (future wiring). The inner runner does
      // not re-wrap tools, so the existing instances retain their original
      // ctx.parentDepth — still safe because that ctx was constructed with
      // parentDepth = currentDepth, which on the next call check yields
      // currentDepth+1 >= MAX_DELEGATION_DEPTH (when MAX=1).

      const userMessage = context ? `${task}\n\nКонтекст: ${context}` : task

      try {
        const result = await runner(
          ctx.gemini,
          {
            instruction: agent.systemPrompt,
            model: agent.model ?? 'gemini-2.5-flash',
            tools: agent.tools,
          },
          userMessage,
          [],
        )
        const ms = Date.now() - startedAt
        log().info('subagent: delegation done', {
          to: agent.name,
          depth: nextDepth,
          ms,
          ok: true,
          toolCalls: result.toolCalls?.length ?? 0,
          traceId: ctx.traceId,
          workspaceId: ctx.workspaceId,
        })
        return {
          ok: true,
          agent: agent.name,
          output: result.text,
          toolCalls: result.toolCalls?.length ?? 0,
          depth: nextDepth,
        }
      } catch (e) {
        const err = (e as Error).message
        const ms = Date.now() - startedAt
        log().error('subagent: delegation done', {
          to: agent.name,
          depth: nextDepth,
          ms,
          ok: false,
          error: err,
          traceId: ctx.traceId,
          workspaceId: ctx.workspaceId,
        })
        return { error: err }
      }
  }
}

/**
 * Build delegation tools for every sub-agent in `registry`. Returns an empty
 * array when the registry is empty. The optional `runner` parameter is for
 * test injection; leave undefined in production code.
 */
export function createAllDelegationTools(
  registry: SubAgentRegistry,
  ctx: DelegationContext,
  runner?: DelegationRunner,
): MemoryTool[] {
  return registry.list().map((agent) => createDelegationTool(agent, ctx, runner))
}
