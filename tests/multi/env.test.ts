import { describe, it, expect } from 'vitest'
import { parseEnv } from '../../src/multi/env.js'

describe('parseEnv', () => {
  it('throws when BC_DATABASE_URL missing', () => {
    expect(() => parseEnv({})).toThrow(/BC_DATABASE_URL/)
  })

  it('throws when GEMINI_API_KEY missing', () => {
    expect(() => parseEnv({
      BC_DATABASE_URL: 'postgres://x',
    })).toThrow(/GEMINI_API_KEY/)
  })

  it('throws when at least one bot token missing', () => {
    expect(() => parseEnv({
      BC_DATABASE_URL: 'postgres://x',
      GEMINI_API_KEY: 'k',
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
