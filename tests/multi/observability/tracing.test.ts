import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  withSpan,
  initTracing,
  __setTracerForTest,
  __resetForTest,
  getTracer,
} from '../../../src/multi/observability/tracing.js'

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
        spanContext: () => ({ traceId: 'trace-' + name, spanId: 'span-' + name, traceFlags: 1 }),
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

describe('withSpan', () => {
  it('passes through when no tracer is configured', async () => {
    __setTracerForTest(null)
    const r = await withSpan('foo', async (span) => {
      expect(span).toBeNull()
      return 42
    })
    expect(r).toBe(42)
  })

  it('creates a span and runs fn when a tracer is configured', async () => {
    const { tracer, spans } = makeFakeTracer()
    __setTracerForTest(tracer as never)
    const r = await withSpan('foo', async (span) => {
      expect(span).not.toBeNull()
      return 'ok'
    })
    expect(r).toBe('ok')
    expect(spans).toHaveLength(1)
    expect(spans[0].ended).toBe(true)
    expect(spans[0].status?.code).toBe(1) // OK
  })

  it('records exceptions and rethrows', async () => {
    const { tracer, spans } = makeFakeTracer()
    __setTracerForTest(tracer as never)
    const err = new Error('boom')
    await expect(
      withSpan('foo', async () => {
        throw err
      }),
    ).rejects.toThrow('boom')
    expect(spans[0].exceptions).toContain(err)
    expect(spans[0].status?.code).toBe(2) // ERROR
    expect(spans[0].ended).toBe(true)
  })

  it('forwards attributes', async () => {
    const { tracer, spans } = makeFakeTracer()
    __setTracerForTest(tracer as never)
    await withSpan('foo', async () => 1, { workspaceId: 'ws-1', model: 'g' })
    expect(spans[0].attributes).toMatchObject({ workspaceId: 'ws-1', model: 'g' })
  })
})

describe('initTracing', () => {
  it('is a no-op when BC_OTEL_ENABLED is unset', async () => {
    delete process.env.BC_OTEL_ENABLED
    await initTracing()
    expect(getTracer()).toBeNull()
  })

  it('is idempotent', async () => {
    delete process.env.BC_OTEL_ENABLED
    await initTracing()
    await initTracing()
    expect(getTracer()).toBeNull()
  })

  it('does not throw when enabled (SDK present or absent)', async () => {
    process.env.BC_OTEL_ENABLED = '1'
    // initTracing must never throw. Whether the tracer ends up non-null
    // depends on whether the optional SDK packages are installed; both
    // outcomes are valid no-op-safe behavior. We only assert it resolves.
    await expect(initTracing()).resolves.toBeUndefined()
    delete process.env.BC_OTEL_ENABLED
  })
})
