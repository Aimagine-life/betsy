import { describe, it, expect, vi } from 'vitest'
import { handleHealthz } from '../../../src/multi/http/healthz.js'

describe('handleHealthz', () => {
  it('returns 200 when db check passes', async () => {
    const dbCheck = vi.fn().mockResolvedValue(true)
    const res = await handleHealthz({ dbCheck })
    expect(res.status).toBe(200)
    expect(res.body).toBe('{"status":"ok"}')
  })

  it('returns 503 when db check fails', async () => {
    const dbCheck = vi.fn().mockRejectedValue(new Error('down'))
    const res = await handleHealthz({ dbCheck })
    expect(res.status).toBe(503)
    expect(res.body).toBe('{"status":"error"}')
  })

  it('returns 503 when db check returns false', async () => {
    const dbCheck = vi.fn().mockResolvedValue(false)
    const res = await handleHealthz({ dbCheck })
    expect(res.status).toBe(503)
  })
})
