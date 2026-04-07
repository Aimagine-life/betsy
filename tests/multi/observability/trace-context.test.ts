import { describe, it, expect } from 'vitest'
import {
  runWithTraceId,
  getCurrentTraceId,
  getCurrentSpanId,
} from '../../../src/multi/observability/trace-context.js'

describe('trace-context (AsyncLocalStorage)', () => {
  it('returns undefined outside any context', () => {
    expect(getCurrentTraceId()).toBeUndefined()
    expect(getCurrentSpanId()).toBeUndefined()
  })

  it('exposes traceId/spanId inside runWithTraceId', () => {
    const result = runWithTraceId(
      'tr-1',
      () => {
        return { trace: getCurrentTraceId(), span: getCurrentSpanId() }
      },
      'sp-1',
    )
    expect(result.trace).toBe('tr-1')
    expect(result.span).toBe('sp-1')
  })

  it('does not leak context across async boundaries outside the run', async () => {
    runWithTraceId('inner', () => {
      expect(getCurrentTraceId()).toBe('inner')
    })
    expect(getCurrentTraceId()).toBeUndefined()
  })
})
