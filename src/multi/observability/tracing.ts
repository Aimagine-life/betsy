/**
 * Wave 4 — OpenTelemetry tracing with no-op fallback.
 *
 * Design notes:
 *  - `@opentelemetry/api` is the only required dependency. The full SDK
 *    (`sdk-node`, `exporter-trace-otlp-http`, ...) is loaded **dynamically**
 *    so packaging Betsy without it still works.
 *  - Tracing is opt-in via `BC_OTEL_ENABLED=1`. When disabled, `withSpan`
 *    becomes a transparent passthrough — zero overhead, zero risk.
 *  - `initTracing` is idempotent and never throws. A failure to load the SDK
 *    is logged once and the runtime continues without tracing.
 */
import { trace, SpanStatusCode, type Tracer, type Span } from '@opentelemetry/api'
import { log } from './logger.js'
import { runWithTraceId } from './trace-context.js'

let tracer: Tracer | null = null
let initialized = false

/**
 * Initialise tracing. Safe to call multiple times — only the first call
 * has any effect. Never throws.
 */
export async function initTracing(): Promise<void> {
  if (initialized) return
  initialized = true

  if (process.env.BC_OTEL_ENABLED !== '1') {
    log().info('tracing: disabled (BC_OTEL_ENABLED!=1)')
    return
  }

  try {
    // Dynamic imports — these packages are optionalDependencies. If they
    // aren't installed (e.g. when Betsy is packaged for end users) we just
    // fall back to no-op tracing.
    const sdkMod = (await import('@opentelemetry/sdk-node' as string)) as any
    const expMod = (await import('@opentelemetry/exporter-trace-otlp-http' as string)) as any
    const resMod = (await import('@opentelemetry/resources' as string)) as any
    const semMod = (await import('@opentelemetry/semantic-conventions' as string)) as any

    const NodeSDK = sdkMod.NodeSDK
    const OTLPTraceExporter = expMod.OTLPTraceExporter
    const Resource = resMod.Resource
    const SemanticResourceAttributes = semMod.SemanticResourceAttributes

    const sdk = new NodeSDK({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: 'betsy-multi',
        [SemanticResourceAttributes.SERVICE_VERSION]: process.env.BC_VERSION ?? 'dev',
      }),
      traceExporter: new OTLPTraceExporter({
        url: process.env.BC_OTEL_ENDPOINT ?? 'http://localhost:4318/v1/traces',
      }),
    })
    sdk.start()
    tracer = trace.getTracer('betsy')
    log().info('tracing: initialized', {
      endpoint: process.env.BC_OTEL_ENDPOINT ?? 'http://localhost:4318/v1/traces',
    })
  } catch (e) {
    log().warn('tracing: failed to init, using no-op', {
      error: (e as Error).message,
    })
    tracer = null
  }
}

/** Returns the active tracer or null when tracing is disabled / failed. */
export function getTracer(): Tracer | null {
  return tracer
}

/** TEST ONLY — inject a tracer instance. */
export function __setTracerForTest(t: Tracer | null): void {
  tracer = t
}

/** TEST ONLY — reset init flag for re-testing initTracing. */
export function __resetForTest(): void {
  tracer = null
  initialized = false
}

/**
 * Run `fn` inside a new span. If tracing is disabled, this is a transparent
 * passthrough — `fn` still receives `null` for the span argument and the
 * result is returned unchanged. Errors are recorded on the span and rethrown.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span | null) => Promise<T>,
  attributes?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  const t = getTracer()
  if (!t) return fn(null)

  return t.startActiveSpan(name, async (span) => {
    if (attributes) {
      const safe: Record<string, string | number | boolean> = {}
      for (const [k, v] of Object.entries(attributes)) {
        if (v !== undefined) safe[k] = v
      }
      span.setAttributes(safe)
    }
    const ctx = span.spanContext()
    try {
      // Propagate traceId via ALS so log() lines inherit it.
      const result = await runWithTraceId(ctx.traceId, () => fn(span), ctx.spanId)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (e) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (e as Error).message,
      })
      span.recordException(e as Error)
      throw e
    } finally {
      span.end()
    }
  })
}
