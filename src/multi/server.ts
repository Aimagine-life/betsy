import { loadEnv } from './env.js'
import { log } from './observability/logger.js'
import { buildPool, closePool } from './db/pool.js'
import { runMigrations } from './db/migrate.js'
import { buildS3Storage, getS3Storage } from './storage/s3.js'
import { buildGemini, getGemini } from './gemini/client.js'
import { startHealthzServer } from './http/healthz.js'
import { TelegramAdapter } from './channels/telegram.js'
import { MaxAdapter } from './channels/max.js'
import type { ChannelAdapter, ChannelName } from './channels/base.js'
import { BotRouter } from './bot-router/router.js'
import { WorkspaceRepo } from './workspaces/repo.js'
import { PersonaRepo } from './personas/repo.js'
import { FactsRepo } from './memory/facts-repo.js'
import { ConversationRepo } from './memory/conversation-repo.js'
import { RemindersRepo } from './reminders/repo.js'
import { LinkCodesRepo } from './linking/repo.js'
import { LinkingService } from './linking/service.js'
import { runBetsy, runBetsyStream } from './agents/runner.js'
import { runWithGeminiTools } from './agents/gemini-runner.js'
import { startRemindersWorker } from './jobs/reminders-worker.js'

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

  // Gemini client — Vertex AI mode (no regional restrictions) or AI Studio (legacy)
  if (env.BC_GEMINI_VERTEX === '1') {
    buildGemini({
      vertexai: true,
      project: env.BC_GCP_PROJECT,
      location: env.BC_GCP_LOCATION,
    })
    logger.info('gemini client initialized (vertex)', {
      project: env.BC_GCP_PROJECT,
      location: env.BC_GCP_LOCATION,
      models: [
        'gemini-2.5-flash',
        'gemini-2.5-pro',
        'gemini-3.1-flash-image-preview',
        'gemini-2.5-flash-preview-tts',
      ],
    })
  } else {
    buildGemini({ apiKey: env.GEMINI_API_KEY! })
    logger.info('gemini client initialized (ai studio)', {
      models: [
        'gemini-2.5-flash',
        'gemini-2.5-pro',
        'gemini-3.1-flash-image-preview',
        'gemini-2.5-flash-preview-tts',
      ],
    })
  }

  // Repos
  const wsRepo = new WorkspaceRepo(pool)
  const personaRepo = new PersonaRepo(pool)
  const factsRepo = new FactsRepo(pool)
  const convRepo = new ConversationRepo(pool)
  const remindersRepo = new RemindersRepo(pool)
  const linkCodesRepo = new LinkCodesRepo(pool)
  const linkingSvc = new LinkingService(linkCodesRepo, {
    findById: async (id: string) => {
      const w = await wsRepo.findById(id)
      return w ? { id: w.id, ownerTgId: w.ownerTgId, ownerMaxId: w.ownerMaxId } : null
    },
    updateOwnerTg: (id: string, tgId: number) => wsRepo.updateOwnerTg(id, tgId),
    updateOwnerMax: (id: string, maxId: number) => wsRepo.updateOwnerMax(id, maxId),
  })

  // Channels
  const channels: Partial<Record<ChannelName, ChannelAdapter>> = {}
  if (env.BC_TELEGRAM_BOT_TOKEN) {
    channels.telegram = new TelegramAdapter(env.BC_TELEGRAM_BOT_TOKEN)
    logger.info('telegram adapter configured')
  }
  if (env.BC_MAX_BOT_TOKEN) {
    channels.max = new MaxAdapter(env.BC_MAX_BOT_TOKEN)
    logger.info('max adapter configured')
  }

  // Bot router with runBetsy agent runner
  const runBetsyDeps = {
    wsRepo,
    personaRepo,
    factsRepo,
    convRepo,
    remindersRepo,
    s3: env.BC_S3_ACCESS_KEY ? getS3Storage() : ({} as any),
    gemini: getGemini(),
    agentRunner: async (agent: any, userMessage: string) => {
      return runWithGeminiTools(getGemini(), agent, userMessage)
    },
  }

  const router = new BotRouter({
    wsRepo,
    personaRepo,
    factsRepo,
    linkingSvc,
    channels,
    runBetsyFn: runBetsy,
    runBetsyStreamFn: runBetsyStream,
    runBetsyDeps,
  })
  router.attach()

  for (const adapter of Object.values(channels)) {
    if (adapter) await adapter.start()
  }
  logger.info('channel adapters started', {
    channels: Object.keys(channels),
  })

  // Reminders worker
  const remindersWorker = startRemindersWorker(
    {
      wsRepo,
      remindersRepo,
      channels,
      resolveOwnerChatId: (w, ch) =>
        ch === 'telegram'
          ? (w.ownerTgId ? String(w.ownerTgId) : null)
          : w.ownerMaxId
            ? String(w.ownerMaxId)
            : null,
    },
    env.BC_REMINDERS_POLL_INTERVAL_MS,
  )
  remindersWorker.start()
  logger.info('reminders worker started', {
    intervalMs: env.BC_REMINDERS_POLL_INTERVAL_MS,
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
      await remindersWorker.stop()
      for (const adapter of Object.values(channels)) {
        if (adapter) await adapter.stop()
      }
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
