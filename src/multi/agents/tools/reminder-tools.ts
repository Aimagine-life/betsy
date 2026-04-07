import { z } from 'zod'
import type { RemindersRepo } from '../../reminders/repo.js'
import type { MemoryTool } from './memory-tools.js'

export interface ReminderToolsDeps {
  remindersRepo: RemindersRepo
  workspaceId: string
  currentChannel: 'telegram' | 'max'
}

export function createReminderTools(deps: ReminderToolsDeps): MemoryTool[] {
  const { remindersRepo, workspaceId, currentChannel } = deps

  const setParams = z.object({
    fire_at: z.string().describe('ISO 8601 timestamp when the reminder should fire'),
    text: z.string().min(1).max(500),
  })
  const setReminder: MemoryTool = {
    name: 'set_reminder',
    description:
      'Поставить напоминание на конкретное время. fire_at — ISO timestamp. Напоминание придёт в тот же канал где юзер сейчас общается.',
    parameters: setParams,
    async execute(params) {
      const parsed = setParams.parse(params)
      const fireAt = new Date(parsed.fire_at)
      if (isNaN(fireAt.getTime())) {
        return { success: false, error: 'Invalid fire_at — must be ISO timestamp' }
      }
      const r = await remindersRepo.create(workspaceId, {
        fireAt,
        text: parsed.text,
        preferredChannel: currentChannel,
      })
      return { success: true, id: r.id }
    },
  }

  const listParams = z.object({})
  const listReminders: MemoryTool = {
    name: 'list_reminders',
    description: 'Показать все ожидающие напоминания юзера.',
    parameters: listParams,
    async execute() {
      const list = await remindersRepo.listPending(workspaceId)
      return {
        reminders: list.map((r) => ({
          id: r.id,
          fire_at: r.fireAt.toISOString(),
          text: r.text,
          channel: r.preferredChannel,
        })),
      }
    },
  }

  const cancelParams = z.object({
    id: z.string().uuid(),
  })
  const cancelReminder: MemoryTool = {
    name: 'cancel_reminder',
    description: 'Отменить напоминание по id.',
    parameters: cancelParams,
    async execute(params) {
      const parsed = cancelParams.parse(params)
      await remindersRepo.cancel(workspaceId, parsed.id)
      return { success: true }
    },
  }

  return [setReminder, listReminders, cancelReminder]
}
