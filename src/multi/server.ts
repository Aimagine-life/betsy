import { loadEnv } from './env.js'
import { log } from './observability/logger.js'
import { buildPool, closePool } from './db/pool.js'
import { runMigrations } from './db/migrate.js'
import { buildS3Storage } from './storage/s3.js'
import { buildGemini } from './gemini/client.js'
import { startHealthzServer } from './http/healthz.js'

export async function startMultiServer(): Promise<void> {
  let env
  try {
    env = loadEnv()
  } catch (e) {
    console.error('[betsy-multi] env validation failed:', (e as Error).message)
    process.exit(1)
  }

  const logger = log()
  logger.info('betsy-multi starting', {
    logLevel: env.BC_LOG_LEVEL,
    httpPort: env.BC_HTTP_PORT,
    healthzPort: env.BC_HEALTHZ_PORT,
  })

  // Postgres
  const pool = buildPool(env.BC_DATABASE_URL)
  const applied = await runMigrations(pool)
  logger.info('migrations applied', { count: applied.length, files: applied })

  // S3 (only if credentials present)
  if (env.BC_S3_ACCESS_KEY && env.BC_S3_SECRET_KEY) {
    buildS3Storage({
      endpoint: env.BC_S3_ENDPOINT,
      region: env.BC_S3_REGION,
      bucket: env.BC_S3_BUCKET,
      accessKeyId: env.BC_S3_ACCESS_KEY,
      secretAccessKey: env.BC_S3_SECRET_KEY,
    })
    logger.info('s3 storage initialized', { bucket: env.BC_S3_BUCKET })
  } else {
    logger.warn('s3 credentials missing, storage disabled')
  }

  // Gemini client
  buildGemini(env.GEMINI_API_KEY)
  logger.info('gemini client initialized', {
    models: [
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-3.1-flash-image-preview',
      'gemini-2.5-flash-preview-tts',
    ],
  })

  // Healthz
  const healthzServer = startHealthzServer(env.BC_HEALTHZ_PORT, pool)
  logger.info('healthz server listening', { port: env.BC_HEALTHZ_PORT })

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info('shutdown received', { signal })
    const hardTimeout = setTimeout(() => {
      logger.error('shutdown timeout, force exit')
      process.exit(1)
    }, 30_000)
    hardTimeout.unref()

    try {
      await new Promise<void>((resolve) => healthzServer.close(() => resolve()))
      await closePool()
      logger.info('shutdown complete')
      process.exit(0)
    } catch (e) {
      logger.error('shutdown failed', { error: String(e) })
      process.exit(1)
    }
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))

  logger.info('betsy-multi started')
}
