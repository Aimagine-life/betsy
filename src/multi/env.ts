import { z } from 'zod'

const envSchema = z.object({
  // Core
  BETSY_MODE: z.string().optional(),
  BC_DATABASE_URL: z.string().min(1, 'BC_DATABASE_URL is required'),
  BC_ENCRYPTION_KEY: z.string().optional(),

  // Google — either AI Studio (GEMINI_API_KEY) or Vertex AI (BC_GEMINI_VERTEX=1 + BC_GCP_PROJECT)
  GEMINI_API_KEY: z.string().optional(),
  BC_GEMINI_VERTEX: z.enum(['0', '1']).default('0'),
  BC_GCP_PROJECT: z.string().optional(),
  BC_GCP_LOCATION: z.string().default('us-central1'),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),

  // Channels (at least one required, enforced below)
  BC_TELEGRAM_BOT_TOKEN: z.string().optional(),
  BC_MAX_BOT_TOKEN: z.string().optional(),

  // Storage (Beget S3)
  BC_S3_ENDPOINT: z.string().default('https://s3.ru1.storage.beget.cloud'),
  BC_S3_BUCKET: z.string().default('64d9bd04fc15-betsy-ai'),
  BC_S3_ACCESS_KEY: z.string().optional(),
  BC_S3_SECRET_KEY: z.string().optional(),
  BC_S3_REGION: z.string().default('ru1'),

  // Payments (mock by default)
  BC_PAYMENT_PROVIDER: z.enum(['mock', 'tochka']).default('mock'),
  BC_TOCHKA_CUSTOMER_CODE: z.string().optional(),
  BC_TOCHKA_JWT: z.string().optional(),
  BC_TOCHKA_WEBHOOK_USER: z.string().optional(),
  BC_TOCHKA_WEBHOOK_PASS: z.string().optional(),

  // fal.ai for video circles
  FAL_API_KEY: z.string().optional(),

  // HTTP
  BC_HTTP_PORT: z.coerce.number().int().default(8080),
  BC_HEALTHZ_PORT: z.coerce.number().int().default(8081),
  BC_WEBHOOK_BASE_URL: z.string().default('https://crew.betsyai.io'),
  BC_TRUST_PROXY: z.enum(['0', '1']).default('0'),

  // Ops
  BC_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  BC_REMINDERS_POLL_INTERVAL_MS: z.coerce.number().int().default(30_000),

  // Memory window — Gemini 2.5 supports 1M context, so we can be generous
  BC_HISTORY_LIMIT: z.coerce.number().int().min(10).max(1000).default(200),
  BC_FACT_LIMIT: z.coerce.number().int().min(10).max(500).default(100),

  // Auto-summarizer thresholds
  BC_SUMMARIZER_THRESHOLD: z.coerce.number().int().min(20).default(150),
  BC_SUMMARIZER_KEEP_RECENT: z.coerce.number().int().min(10).default(50),
})

export type Env = z.infer<typeof envSchema>

export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.parse(raw)
  if (!parsed.BC_TELEGRAM_BOT_TOKEN && !parsed.BC_MAX_BOT_TOKEN) {
    throw new Error('At least one of BC_TELEGRAM_BOT_TOKEN or BC_MAX_BOT_TOKEN must be set')
  }
  // Either Vertex AI (with project + creds) or AI Studio (with API key) must be configured
  if (parsed.BC_GEMINI_VERTEX === '1') {
    if (!parsed.BC_GCP_PROJECT) {
      throw new Error('BC_GEMINI_VERTEX=1 requires BC_GCP_PROJECT')
    }
    if (!parsed.GOOGLE_APPLICATION_CREDENTIALS) {
      throw new Error('BC_GEMINI_VERTEX=1 requires GOOGLE_APPLICATION_CREDENTIALS pointing to a service account JSON file')
    }
  } else {
    if (!parsed.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is required when not in Vertex AI mode (BC_GEMINI_VERTEX=0)')
    }
  }
  return parsed
}

let cached: Env | null = null

export function loadEnv(): Env {
  if (!cached) cached = parseEnv(process.env)
  return cached
}

export function resetEnv(): void {
  cached = null
}
