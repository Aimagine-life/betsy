import { describe, it, expect, vi } from 'vitest'
import { LinkingService } from '../../../src/multi/linking/service.js'

function mockRepos() {
  const codes = {
    create: vi.fn().mockResolvedValue({
      code: '123456',
      workspaceId: 'ws1',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      createdAt: new Date(),
    }),
    consume: vi.fn().mockResolvedValue({
      code: '123456',
      workspaceId: 'ws1',
      expiresAt: new Date(),
      createdAt: new Date(),
    }),
    countRecentForWorkspace: vi.fn().mockResolvedValue(0),
  }
  const ws = {
    findById: vi.fn().mockResolvedValue({
      id: 'ws1',
      ownerTgId: 123,
      ownerMaxId: null,
      displayName: 'K',
      plan: 'personal',
      status: 'active',
    }),
    updateOwnerMax: vi.fn().mockResolvedValue(undefined),
    updateOwnerTg: vi.fn().mockResolvedValue(undefined),
  }
  return { codes, ws }
}

describe('LinkingService.generateCode', () => {
  it('creates code for workspace', async () => {
    const repos = mockRepos()
    const svc = new LinkingService(repos.codes as any, repos.ws as any)
    const code = await svc.generateCode('ws1')
    expect(code).toBe('123456')
    expect(repos.codes.create).toHaveBeenCalledWith('ws1', 10 * 60 * 1000)
  })

  it('throws rate limit error when > 5 codes in past hour', async () => {
    const repos = mockRepos()
    repos.codes.countRecentForWorkspace.mockResolvedValue(5)
    const svc = new LinkingService(repos.codes as any, repos.ws as any)
    await expect(svc.generateCode('ws1')).rejects.toThrow(/rate limit/i)
  })
})

describe('LinkingService.verifyAndLink', () => {
  it('links max id to existing workspace', async () => {
    const repos = mockRepos()
    const svc = new LinkingService(repos.codes as any, repos.ws as any)
    const result = await svc.verifyAndLink('123456', {
      fromChannel: 'max',
      newChannelUserId: 555,
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.workspaceId).toBe('ws1')
    expect(repos.ws.updateOwnerMax).toHaveBeenCalledWith('ws1', 555)
  })

  it('returns success=false when code invalid', async () => {
    const repos = mockRepos()
    repos.codes.consume.mockResolvedValue(null)
    const svc = new LinkingService(repos.codes as any, repos.ws as any)
    const result = await svc.verifyAndLink('000000', {
      fromChannel: 'max',
      newChannelUserId: 555,
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('invalid_or_expired')
  })

  it('returns already_linked if max id is already set on a different workspace', async () => {
    const repos = mockRepos()
    repos.ws.findById.mockResolvedValue({
      id: 'ws1',
      ownerTgId: 123,
      ownerMaxId: 999,
      displayName: 'K',
      plan: 'personal',
      status: 'active',
    })
    const svc = new LinkingService(repos.codes as any, repos.ws as any)
    const result = await svc.verifyAndLink('123456', {
      fromChannel: 'max',
      newChannelUserId: 555,
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('channel_already_linked')
  })
})
