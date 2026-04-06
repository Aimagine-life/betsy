import { z } from 'zod'

const envSchema = z.object({
  // Core
  BETSY_MODE: z.string().optional(),
  BC_DATABASE_URL: z.string().min(1, 'BC_DATABASE_URL is required'),
  BC_ENCRYPTION_KEY: z.string().optional(),

  // Google
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),

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
})

export type Env = z.infer<typeof envSchema>

export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.parse(raw)
  if (!parsed.BC_TELEGRAM_BOT_TOKEN && !parsed.BC_MAX_BOT_TOKEN) {
    throw new Error('At least one of BC_TELEGRAM_BOT_TOKEN or BC_MAX_BOT_TOKEN must be set')
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
