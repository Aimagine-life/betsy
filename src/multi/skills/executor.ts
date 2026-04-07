// Wave 1C — Workspace skills: step executor with hard limits.
import type { MemoryTool } from '../agents/tools/memory-tools.js'
import type { SkillStep, WorkspaceSkill, SkillRunResult } from './types.js'
import { renderTemplate, renderValue } from './template.js'
import { safeEvalBool } from './safe-eval.js'

export interface SkillLLM {
  /** Short single-turn prompt → text. */
  generateText(prompt: string): Promise<string>
}

export interface SkillLogger {
  info(msg: string, meta?: Record<string, any>): void
  warn(msg: string, meta?: Record<string, any>): void
  error(msg: string, meta?: Record<string, any>): void
}

export interface ExecuteSkillContext {
  workspaceId: string
  availableTools: MemoryTool[]
  llm: SkillLLM
  logger: SkillLogger
  /** Initial variables. Becomes the `vars` root in expressions. */
  vars?: Record<string, any>
  /** Optional limit overrides (testing). */
  limits?: Partial<typeof DEFAULT_LIMITS>
}

export const DEFAULT_LIMITS = {
  maxSteps: 50,
  maxWallClockMs: 30_000,
  maxLlmCalls: 5,
}

export class SkillExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillExecutionError'
  }
}

interface RunState {
  vars: Record<string, any>
  scope: Record<string, any>
  stepsExecuted: number
  llmCalls: number
  startedAt: number
  limits: typeof DEFAULT_LIMITS
  ctx: ExecuteSkillContext
}

function checkLimits(state: RunState): void {
  if (state.stepsExecuted >= state.limits.maxSteps) {
    throw new SkillExecutionError(
      `step limit exceeded (${state.limits.maxSteps})`,
    )
  }
  if (Date.now() - state.startedAt > state.limits.maxWallClockMs) {
    throw new SkillExecutionError(
      `wall-clock limit exceeded (${state.limits.maxWallClockMs}ms)`,
    )
  }
}

async function runStep(step: SkillStep, state: RunState): Promise<void> {
  checkLimits(state)
  state.stepsExecuted++
  state.ctx.logger.info('skill: step', {
    workspaceId: state.ctx.workspaceId,
    kind: step.kind,
    n: state.stepsExecuted,
  })

  switch (step.kind) {
    case 'tool': {
      const tool = state.ctx.availableTools.find((t) => t.name === step.tool)
      if (!tool) {
        throw new SkillExecutionError(`tool not found: ${step.tool}`)
      }
      const renderedParams = renderValue(step.params ?? {}, state.scope)
      let result: unknown
      try {
        result = await tool.execute(renderedParams)
      } catch (e) {
        throw new SkillExecutionError(
          `tool "${step.tool}" failed: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      if (step.saveAs) state.vars[step.saveAs] = result
      return
    }
    case 'prompt': {
      if (state.llmCalls >= state.limits.maxLlmCalls) {
        throw new SkillExecutionError(
          `LLM call limit exceeded (${state.limits.maxLlmCalls})`,
        )
      }
      state.llmCalls++
      const rendered = renderTemplate(step.prompt, state.scope)
      const text = await state.ctx.llm.generateText(rendered)
      if (step.saveAs) state.vars[step.saveAs] = text
      return
    }
    case 'condition': {
      const cond = safeEvalBool(step.if, state.scope)
      const branch = cond ? step.then : step.else ?? []
      for (const s of branch) await runStep(s, state)
      return
    }
    case 'loop': {
      const iterable = state.scope[step.over] ?? state.vars[step.over]
      if (!Array.isArray(iterable)) {
        throw new SkillExecutionError(
          `loop.over "${step.over}" did not resolve to an array`,
        )
      }
      // Hard cap on iterations to prevent runaway loops; still bounded by maxSteps.
      const cap = Math.min(iterable.length, state.limits.maxSteps)
      for (let i = 0; i < cap; i++) {
        const prev = state.scope[step.as]
        state.scope[step.as] = iterable[i]
        try {
          for (const s of step.do) await runStep(s, state)
        } finally {
          if (prev === undefined) delete state.scope[step.as]
          else state.scope[step.as] = prev
        }
      }
      return
    }
  }
}

export async function executeSkill(
  skill: WorkspaceSkill,
  ctx: ExecuteSkillContext,
): Promise<SkillRunResult> {
  const limits = { ...DEFAULT_LIMITS, ...(ctx.limits ?? {}) }
  const vars: Record<string, any> = { ...(ctx.vars ?? {}) }
  const state: RunState = {
    vars,
    // The scope object is what expressions see. `vars` is the canonical bag.
    // We expose `vars` plus loop iterators which are added/removed dynamically.
    scope: { vars },
    stepsExecuted: 0,
    llmCalls: 0,
    startedAt: Date.now(),
    limits,
    ctx,
  }

  ctx.logger.info('skill: start', {
    workspaceId: ctx.workspaceId,
    name: skill.name,
    steps: skill.steps.length,
  })

  try {
    for (const step of skill.steps) await runStep(step, state)
    ctx.logger.info('skill: done', {
      workspaceId: ctx.workspaceId,
      name: skill.name,
      stepsExecuted: state.stepsExecuted,
    })
    return {
      success: true,
      output: vars,
      stepsExecuted: state.stepsExecuted,
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    ctx.logger.error('skill: failed', {
      workspaceId: ctx.workspaceId,
      name: skill.name,
      stepsExecuted: state.stepsExecuted,
      error: message,
    })
    return {
      success: false,
      output: vars,
      stepsExecuted: state.stepsExecuted,
      error: message,
    }
  }
}
