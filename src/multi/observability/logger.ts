import pino from 'pino'
import { getCurrentTraceId } from './trace-context.js'

const SECRET_KEYS = /^(token|secret|password|api[_-]?key|jwt|access[_-]?key|auth)$/i

export function maskSecrets(obj: unknown): Record<string, unknown> {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj as Record<string, unknown>
  }
  if (Array.isArray(obj)) {
    return obj.map(maskSecrets) as unknown as Record<string, unknown>
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_KEYS.test(k)) {
      out[k] = '***masked***'
    } else if (v && typeof v === 'object') {
      out[k] = maskSecrets(v)
    } else {
      out[k] = v
    }
  }
  return out
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void
  info(msg: string, ctx?: Record<string, unknown>): void
  warn(msg: string, ctx?: Record<string, unknown>): void
  error(msg: string, ctx?: Record<string, unknown>): void
  child(ctx: Record<string, unknown>): Logger
}

function wrap(pinoInstance: pino.Logger): Logger {
  return {
    debug: (msg, ctx) => pinoInstance.debug(maskSecrets(ctx ?? {}), msg),
    info: (msg, ctx) => pinoInstance.info(maskSecrets(ctx ?? {}), msg),
    warn: (msg, ctx) => pinoInstance.warn(maskSecrets(ctx ?? {}), msg),
    error: (msg, ctx) => pinoInstance.error(maskSecrets(ctx ?? {}), msg),
    child: (ctx) => wrap(pinoInstance.child(maskSecrets(ctx))),
  }
}

export function createLogger(level: LogLevel = 'info'): Logger {
  return wrap(
    pino({
      level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      // Automatically tag every log line with the current traceId when the
      // call happens inside a `runWithTraceId(...)` scope (set by `withSpan`).
      mixin: () => {
        const t = getCurrentTraceId()
        return t ? { traceId: t } : {}
      },
    }),
  )
}

let rootLogger: Logger | null = null

export function log(): Logger {
  if (!rootLogger) {
    const level = (process.env.BC_LOG_LEVEL as LogLevel | undefined) ?? 'info'
    rootLogger = createLogger(level)
  }
  return rootLogger
}
