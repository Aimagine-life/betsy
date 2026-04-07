import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import pino from 'pino'
import { z } from 'zod'
import {
  __setTracerForTest,
  __resetForTest,
} from '../../../src/multi/observability/tracing.js'
import { runWithTraceId, getCurrentTraceId } from '../../../src/multi/observability/trace-context.js'
import { runWithGeminiTools } from '../../../src/multi/agents/gemini-runner.js'
import { createDelegationTool } from '../../../src/multi/agents/subagents/bridge.js'
import { executeSkill } from '../../../src/multi/skills/executor.js'
import type { WorkspaceSkill } from '../../../src/multi/skills/types.js'

interface FakeSpan {
  name: string
  attributes: Record<string, unknown>
  status?: { code: number; message?: string }
  exceptions: Error[]
  ended: boolean
  spanContext: () => { traceId: string; spanId: string; traceFlags: number }
  setAttributes: (a: Record<string, unknown>) => void
  setStatus: (s: { code: number; message?: string }) => void
  recordException: (e: Error) => void
  end: () => void
}

function makeFakeTracer() {
  const spans: FakeSpan[] = []
  const tracer = {
    startActiveSpan: (name: string, fn: (span: FakeSpan) => unknown) => {
      const span: FakeSpan = {
        name,
        attributes: {},
        exceptions: [],
        ended: false,
        spanContext: () => ({
          traceId: 'trace-' + name,
          spanId: 'span-' + name,
          traceFlags: 1,
        }),
        setAttributes(a) {
          Object.assign(this.attributes, a)
        },
        setStatus(s) {
          this.status = s
        },
        recordException(e) {
          this.exceptions.push(e)
        },
        end() {
          this.ended = true
        },
      }
      spans.push(span)
      return fn(span)
    },
  }
  return { tracer, spans }
}

beforeEach(() => __resetForTest())
afterEach(() => __resetForTest())

describe('gemini-runner instrumentation', () => {
  it('wraps runWithGeminiTools in a betsy.gemini.run span with attributes', async () => {
    const { tracer, spans } = makeFakeTracer()
    __setTracerForTest(tracer as never)

    // Fake Gemini client — returns a single text turn, no tool calls.
    const gemini: any = {
      models: {
        generateContent: async () => ({
          usageMetadata: { totalTokenCount: 7 },
          candidates: [{ content: { parts: [{ text: 'hi' }] } }],
        }),
      },
    }
    const agent = { instruction: 'sys', model: 'gemini-2.5-flash', tools: [] }
    const r = await runWithGeminiTools(gemini, agent, 'hello', [
      { role: 'user', content: 'prev' },
    ])
    expect(r.text).toBe('hi')
    expect(r.tokensUsed).toBe(7)
    const runSpan = spans.find((s) => s.name === 'betsy.gemini.run')
    expect(runSpan).toBeDefined()
    expect(runSpan!.attributes).toMatchObject({
      model: 'gemini-2.5-flash',
      toolCount: 0,
      historyLen: 1,
    })
    expect(runSpan!.ended).toBe(true)
  })

  it('wraps each tool call in its own betsy.tool.<name> span', async () => {
    const { tracer, spans } = makeFakeTracer()
    __setTracerForTest(tracer as never)

    const tool = {
      name: 'echo_tool',
      description: 'echoes',
      parameters: z.object({ x: z.number() }),
      async execute(args: any) {
        return { ok: true, args }
      },
    }

    let turn = 0
    const gemini: any = {
      models: {
        generateContent: async () => {
          turn++
          if (turn === 1) {
            return {
              usageMetadata: { totalTokenCount: 3 },
              candidates: [
                {
                  content: {
                    parts: [{ functionCall: { name: 'echo_tool', args: { x: 1 } } }],
                  },
                },
              ],
            }
          }
          return {
            usageMetadata: { totalTokenCount: 2 },
            candidates: [{ content: { parts: [{ text: 'done' }] } }],
          }
        },
      },
    }

    const agent = { instruction: 'sys', model: 'gemini-2.5-flash', tools: [tool] }
    const r = await runWithGeminiTools(gemini, agent, 'go')
    expect(r.text).toBe('done')
    expect(r.toolCalls).toHaveLength(1)

    const toolSpan = spans.find((s) => s.name === 'betsy.tool.echo_tool')
    expect(toolSpan).toBeDefined()
    expect(toolSpan!.attributes).toMatchObject({ name: 'echo_tool' })
    expect(toolSpan!.attributes.argsBytes).toBeTypeOf('number')
    // argsBytes must reflect size, not the actual args
    expect(toolSpan!.attributes.argsBytes).toBeGreaterThan(0)
  })

  it('runWithGeminiTools behaves unchanged with null tracer', async () => {
    __setTracerForTest(null)
    const gemini: any = {
      models: {
        generateContent: async () => ({
          usageMetadata: { totalTokenCount: 4 },
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        }),
      },
    }
    const r = await runWithGeminiTools(
      gemini,
      { instruction: '', model: 'gemini-2.5-flash', tools: [] },
      'hi',
    )
    expect(r.text).toBe('ok')
    expect(r.tokensUsed).toBe(4)
  })
})

describe('subagent bridge instrumentation', () => {
  it('wraps delegation tool execution in betsy.subagent.<name> span', async () => {
    const { tracer, spans } = makeFakeTracer()
    __setTracerForTest(tracer as never)

    const subAgent = {
      name: 'researcher',
      description: 'finds facts',
      systemPrompt: 'you are a researcher',
      model: 'gemini-2.5-flash',
      tools: [],
    } as any

    const fakeRunner = async () => ({
      text: 'research result',
      toolCalls: [],
      tokensUsed: 10,
    })

    const tool = createDelegationTool(
      subAgent,
      { gemini: {} as any, parentDepth: 0, workspaceId: 'ws-1' },
      fakeRunner as any,
    )

    const out: any = await tool.execute({ task: 'find X' })
    expect(out.ok).toBe(true)
    expect(out.output).toBe('research result')

    const span = spans.find((s) => s.name === 'betsy.subagent.researcher')
    expect(span).toBeDefined()
    expect(span!.attributes).toMatchObject({
      agent: 'researcher',
      depth: 0,
      taskLen: 'find X'.length,
    })
  })
})

describe('skills executor instrumentation', () => {
  it('wraps executeSkill in betsy.skill.<name> span', async () => {
    const { tracer, spans } = makeFakeTracer()
    __setTracerForTest(tracer as never)

    const skill: WorkspaceSkill = {
      name: 'hello_skill',
      description: 'says hi',
      steps: [
        {
          kind: 'prompt',
          prompt: 'say hi',
          saveAs: 'greeting',
        } as any,
      ],
    } as any

    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
    }

    const result = await executeSkill(skill, {
      workspaceId: 'ws-1',
      availableTools: [],
      llm: { generateText: async () => 'hi there' },
      logger,
    })
    expect(result.success).toBe(true)

    const span = spans.find((s) => s.name === 'betsy.skill.hello_skill')
    expect(span).toBeDefined()
    expect(span!.attributes).toMatchObject({
      name: 'hello_skill',
      stepCount: 1,
    })
  })
})

describe('pino traceId mixin', () => {
  // We build a fresh pino logger with the same mixin code the production
  // `createLogger` uses, capturing output via a custom stream. This avoids
  // coupling the test to the process-wide rootLogger singleton.
  function buildCapturingLogger() {
    const lines: any[] = []
    const stream = {
      write(chunk: string) {
        try {
          lines.push(JSON.parse(chunk))
        } catch {
          lines.push({ raw: chunk })
        }
      },
    }
    const logger = pino(
      {
        level: 'info',
        base: undefined,
        mixin: () => {
          const t = getCurrentTraceId()
          return t ? { traceId: t } : {}
        },
      },
      stream as any,
    )
    return { logger, lines }
  }

  it('emits traceId inside runWithTraceId scope', () => {
    const { logger, lines } = buildCapturingLogger()
    runWithTraceId('abc123', () => {
      logger.info({ foo: 'bar' }, 'inside')
    })
    const entry = lines.find((l) => l.msg === 'inside')
    expect(entry).toBeDefined()
    expect(entry.traceId).toBe('abc123')
    expect(entry.foo).toBe('bar')
  })

  it('does not emit traceId outside any scope', () => {
    const { logger, lines } = buildCapturingLogger()
    logger.info('outside')
    const entry = lines.find((l) => l.msg === 'outside')
    expect(entry).toBeDefined()
    expect(entry.traceId).toBeUndefined()
  })
})
