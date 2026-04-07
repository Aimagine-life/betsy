import { describe, it, expect, vi } from 'vitest'
import { createReminderTools } from '../../../../src/multi/agents/tools/reminder-tools.js'

function mockRepo() {
  return {
    create: vi.fn().mockResolvedValue({ id: 'r1', fireAt: new Date(), text: 'X' }),
    listPending: vi.fn().mockResolvedValue([
      { id: 'r1', fireAt: new Date(), text: 'Купить молоко', preferredChannel: 'telegram' },
    ]),
    cancel: vi.fn().mockResolvedValue(undefined),
  }
}

describe('createReminderTools', () => {
  it('set_reminder creates reminder with current channel', async () => {
    const repo = mockRepo()
    const tools = createReminderTools({
      remindersRepo: repo as any,
      workspaceId: 'ws1',
      currentChannel: 'telegram',
    })
    const set = tools.find((t) => t.name === 'set_reminder')!
    const fireAt = new Date(Date.now() + 3600_000).toISOString()
    await set.execute({ fire_at: fireAt, text: 'Купить молоко' })
    expect(repo.create).toHaveBeenCalledWith('ws1', {
      fireAt: expect.any(Date),
      text: 'Купить молоко',
      preferredChannel: 'telegram',
    })
  })

  it('list_reminders returns pending list', async () => {
    const repo = mockRepo()
    const tools = createReminderTools({
      remindersRepo: repo as any,
      workspaceId: 'ws1',
      currentChannel: 'telegram',
    })
    const list = tools.find((t) => t.name === 'list_reminders')!
    const result = await list.execute({})
    expect((result as any).reminders).toHaveLength(1)
  })

  it('cancel_reminder cancels by id', async () => {
    const repo = mockRepo()
    const tools = createReminderTools({
      remindersRepo: repo as any,
      workspaceId: 'ws1',
      currentChannel: 'telegram',
    })
    const cancel = tools.find((t) => t.name === 'cancel_reminder')!
    await cancel.execute({ id: '550e8400-e29b-41d4-a716-446655440000' })
    expect(repo.cancel).toHaveBeenCalledWith('ws1', '550e8400-e29b-41d4-a716-446655440000')
  })
})
