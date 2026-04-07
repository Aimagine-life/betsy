import { describe, it, expect, vi } from 'vitest'
import { processPendingReminders } from '../../../src/multi/jobs/reminders-worker.js'

function mockDeps(overrides: any = {}) {
  const workspace = {
    id: 'ws1',
    ownerTgId: 123,
    ownerMaxId: 456,
    lastActiveChannel: 'telegram',
    notifyChannelPref: 'auto',
  }
  return {
    workspace,
    wsRepo: { findById: vi.fn().mockResolvedValue(workspace) },
    remindersRepo: {
      listDuePending: vi.fn().mockResolvedValue([
        {
          id: 'r1',
          workspaceId: 'ws1',
          fireAt: new Date(),
          text: 'Купить молоко',
          preferredChannel: 'telegram',
          status: 'pending',
        },
      ]),
      markFired: vi.fn().mockResolvedValue(undefined),
    },
    channels: {
      telegram: { sendMessage: vi.fn() } as any,
      max: { sendMessage: vi.fn() } as any,
    },
    resolveOwnerChatId: vi.fn().mockImplementation(
      (ws: any, channel: string) => (channel === 'telegram' ? String(ws.ownerTgId) : String(ws.ownerMaxId)),
    ),
    ...overrides,
  }
}

describe('processPendingReminders', () => {
  it('sends due reminders via preferred channel', async () => {
    const deps = mockDeps()
    const processed = await processPendingReminders(deps as any)
    expect(processed).toBe(1)
    expect(deps.channels.telegram.sendMessage).toHaveBeenCalledWith({
      chatId: '123',
      text: expect.stringContaining('Купить молоко'),
    })
    expect(deps.remindersRepo.markFired).toHaveBeenCalledWith('ws1', 'r1')
  })

  it('skips reminder when workspace is gone', async () => {
    const deps = mockDeps()
    deps.wsRepo.findById.mockResolvedValue(null)
    const processed = await processPendingReminders(deps as any)
    expect(processed).toBe(0)
    expect(deps.channels.telegram.sendMessage).not.toHaveBeenCalled()
  })

  it('uses fallback channel when preferred unavailable', async () => {
    const deps = mockDeps()
    // No telegram channel, only max
    deps.channels = { max: { sendMessage: vi.fn() } as any }
    const processed = await processPendingReminders(deps as any)
    expect(processed).toBe(1)
    expect((deps.channels.max as any).sendMessage).toHaveBeenCalled()
  })
})
