/**
 * Wave 4 — trace context propagation via AsyncLocalStorage.
 *
 * Lets us tag every log line that runs inside `runWithTraceId(...)` with the
 * current OpenTelemetry traceId without threading it through every function.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface TraceStore {
  traceId: string
  spanId?: string
}

const als = new AsyncLocalStorage<TraceStore>()

export function runWithTraceId<T>(traceId: string, fn: () => T, spanId?: string): T {
  return als.run({ traceId, spanId }, fn)
}

export function getCurrentTraceId(): string | undefined {
  return als.getStore()?.traceId
}

export function getCurrentSpanId(): string | undefined {
  return als.getStore()?.spanId
}

/** Test helper — exposed for unit tests, not part of public API. */
export function __getStore(): TraceStore | undefined {
  return als.getStore()
}
