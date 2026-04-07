import { describe, it, expect, vi } from 'vitest'
import { handleCommand } from '../../../src/multi/bot-router/commands.js'

function mockDeps() {
  const workspace = {
    id: 'ws1',
    ownerTgId: 1,
    ownerMaxId: null,
    displayName: 'Konstantin',
    plan: 'personal',
    status: 'active',
    tokensUsedPeriod: 120000,
    tokensLimitPeriod: 1000000,
    balanceKopecks: 0,
    lastActiveChannel: 'telegram',
    notifyChannelPref: 'auto',
  }
  return {
    workspace,
    wsRepo: {
      findById: vi.fn().mockResolvedValue(workspace),
      updateNotifyPref: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    linkingSvc: {
      generateCode: vi.fn().mockResolvedValue('123456'),
    },
    factsRepo: {
      forgetAll: vi.fn().mockResolvedValue(undefined),
    },
  }
}

describe('handleCommand /help', () => {
  it('returns help text', async () => {
    const deps = mockDeps()
    const result = await handleCommand('/help', deps.workspace as any, deps as any)
    expect(result?.text).toMatch(/help|команд/i)
  })
})

describe('handleCommand /status', () => {
  it('shows plan, tokens, and balance', async () => {
    const deps = mockDeps()
    const result = await handleCommand('/status', deps.workspace as any, deps as any)
    expect(result?.text).toContain('personal')
    expect(result?.text).toContain('120000')
    expect(result?.text).toContain('1000000')
  })
})

describe('handleCommand /notify', () => {
  it('shows current preference', async () => {
    const deps = mockDeps()
    const result = await handleCommand('/notify', deps.workspace as any, deps as any)
    expect(result?.text).toMatch(/auto|текущий/i)
  })

  it('updates preference when argument provided', async () => {
    const deps = mockDeps()
    const result = await handleCommand('/notify max', deps.workspace as any, deps as any)
    expect(deps.wsRepo.updateNotifyPref).toHaveBeenCalledWith('ws1', 'max')
    expect(result?.text).toMatch(/max/i)
  })

  it('rejects invalid value', async () => {
    const deps = mockDeps()
    const result = await handleCommand('/notify foo', deps.workspace as any, deps as any)
    expect(deps.wsRepo.updateNotifyPref).not.toHaveBeenCalled()
    expect(result?.text).toMatch(/telegram|max|auto/i)
  })
})

describe('handleCommand /link', () => {
  it('generates and returns a 6-digit code', async () => {
    const deps = mockDeps()
    const result = await handleCommand('/link', deps.workspace as any, deps as any)
    expect(result?.text).toContain('123456')
    expect(deps.linkingSvc.generateCode).toHaveBeenCalledWith('ws1')
  })
})

describe('handleCommand /forget', () => {
  it('asks for confirmation when not confirmed', async () => {
    const deps = mockDeps()
    const result = await handleCommand('/forget', deps.workspace as any, deps as any)
    expect(deps.factsRepo.forgetAll).not.toHaveBeenCalled()
    expect(result?.text).toMatch(/подтвер|confirm/i)
  })

  it('wipes memory on /forget confirm', async () => {
    const deps = mockDeps()
    const result = await handleCommand('/forget confirm', deps.workspace as any, deps as any)
    expect(deps.factsRepo.forgetAll).toHaveBeenCalledWith('ws1')
    expect(result?.text).toMatch(/забыл|cleared/i)
  })
})

describe('handleCommand /cancel', () => {
  it('marks status as canceled', async () => {
    const deps = mockDeps()
    const result = await handleCommand('/cancel confirm', deps.workspace as any, deps as any)
    expect(deps.wsRepo.updateStatus).toHaveBeenCalledWith('ws1', 'canceled')
    expect(result?.text).toMatch(/отмен|canceled/i)
  })
})

describe('handleCommand unknown', () => {
  it('returns null for non-command', async () => {
    const deps = mockDeps()
    const result = await handleCommand('just a message', deps.workspace as any, deps as any)
    expect(result).toBeNull()
  })
})
