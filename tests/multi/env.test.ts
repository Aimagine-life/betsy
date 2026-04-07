import { describe, it, expect } from 'vitest'
import { parseEnv } from '../../src/multi/env.js'

describe('parseEnv', () => {
  it('throws when BC_DATABASE_URL missing', () => {
    expect(() => parseEnv({})).toThrow(/BC_DATABASE_URL/)
  })

  it('throws when GEMINI_API_KEY missing in AI Studio mode', () => {
    expect(() => parseEnv({
      BC_DATABASE_URL: 'postgres://x',
      BC_TELEGRAM_BOT_TOKEN: 't',
    })).toThrow(/GEMINI_API_KEY/)
  })

  it('accepts Vertex AI mode without GEMINI_API_KEY', () => {
    const env = parseEnv({
      BC_DATABASE_URL: 'postgres://x',
      BC_TELEGRAM_BOT_TOKEN: 't',
      BC_GEMINI_VERTEX: '1',
      BC_GCP_PROJECT: 'my-project',
      GOOGLE_APPLICATION_CREDENTIALS: '/path/to/sa.json',
    })
    expect(env.BC_GEMINI_VERTEX).toBe('1')
    expect(env.BC_GCP_PROJECT).toBe('my-project')
  })

  it('throws when Vertex mode missing project', () => {
    expect(() => parseEnv({
      BC_DATABASE_URL: 'postgres://x',
      BC_TELEGRAM_BOT_TOKEN: 't',
      BC_GEMINI_VERTEX: '1',
      GOOGLE_APPLICATION_CREDENTIALS: '/x',
    })).toThrow(/BC_GCP_PROJECT/)
  })

  it('throws when Vertex mode missing credentials', () => {
    expect(() => parseEnv({
      BC_DATABASE_URL: 'postgres://x',
      BC_TELEGRAM_BOT_TOKEN: 't',
      BC_GEMINI_VERTEX: '1',
      BC_GCP_PROJECT: 'p',
    })).toThrow(/GOOGLE_APPLICATION_CREDENTIALS/)
  })

  it('throws when at least one bot token missing', () => {
    expect(() => parseEnv({
      BC_DATABASE_URL: 'postgres://x',
    })).toThrow(/BC_TELEGRAM_BOT_TOKEN/)
  })

  it('accepts telegram only', () => {
    const env = parseEnv({
      BC_DATABASE_URL: 'postgres://x',
      GEMINI_API_KEY: 'k',
      BC_TELEGRAM_BOT_TOKEN: 't',
    })
    expect(env.BC_DATABASE_URL).toBe('postgres://x')
    expect(env.BC_TELEGRAM_BOT_TOKEN).toBe('t')
    expect(env.BC_HTTP_PORT).toBe(8080)
    expect(env.BC_HEALTHZ_PORT).toBe(8081)
    expect(env.BC_LOG_LEVEL).toBe('info')
  })

  it('accepts max only', () => {
    const env = parseEnv({
      BC_DATABASE_URL: 'postgres://x',
      GEMINI_API_KEY: 'k',
      BC_MAX_BOT_TOKEN: 'm',
    })
    expect(env.BC_MAX_BOT_TOKEN).toBe('m')
  })

  it('coerces numeric ports from strings', () => {
    const env = parseEnv({
      BC_DATABASE_URL: 'postgres://x',
      GEMINI_API_KEY: 'k',
      BC_TELEGRAM_BOT_TOKEN: 't',
      BC_HTTP_PORT: '9000',
      BC_HEALTHZ_PORT: '9001',
    })
    expect(env.BC_HTTP_PORT).toBe(9000)
    expect(env.BC_HEALTHZ_PORT).toBe(9001)
  })
})
