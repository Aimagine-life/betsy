/**
 * Load and validate the auth-relay runtime config from environment
 * variables. Produces clear error messages if something essential is
 * missing so operators can diagnose bad deployments in seconds.
 */
export interface RelayConfig {
  port: number
  publicUrl: string
  upstreamUrl: string
  upstreamSecret: string
  allowedReturnTo: string[]
}

export class RelayConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayConfigError'
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]
  if (!v || v.length === 0) {
    throw new RelayConfigError(`missing required env var: ${key}`)
  }
  return v
}

export function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const portRaw = env.BC_RELAY_PORT ?? '3787'
  const port = parseInt(portRaw, 10)
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new RelayConfigError(`BC_RELAY_PORT is not a valid port: ${portRaw}`)
  }

  const publicUrl = required(env, 'BC_RELAY_PUBLIC_URL').replace(/\/+$/, '')
  const upstreamUrl = required(env, 'BC_UPSTREAM_URL').replace(/\/+$/, '')
  const upstreamSecret = required(env, 'BC_OAUTH_RELAY_SECRET')

  const rawList = env.BC_RELAY_ALLOWED_RETURN_TO ?? ''
  const allowedReturnTo = rawList
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (allowedReturnTo.length === 0) {
    throw new RelayConfigError('BC_RELAY_ALLOWED_RETURN_TO must list at least one allowed origin')
  }

  return { port, publicUrl, upstreamUrl, upstreamSecret, allowedReturnTo }
}

/**
 * Returns true if `returnTo` uses an allowed scheme (http/https) and its
 * origin is in the allowlist. Rejects javascript:, data:, file:, etc.
 */
export function isAllowedReturnTo(returnTo: string, allowed: string[]): boolean {
  let u: URL
  try {
    u = new URL(returnTo)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const origin = `${u.protocol}//${u.host}`
  return allowed.some((a) => {
    try {
      const allowedUrl = new URL(a)
      return `${allowedUrl.protocol}//${allowedUrl.host}` === origin
    } catch {
      return false
    }
  })
}
