import type { MemoryTool } from '../tools/memory-tools.js'
import type { SubAgent } from './types.js'

const PLANNER_TOOL_NAMES = new Set([
  'set_reminder',
  'list_reminders',
  'cancel_reminder',
])

/** Time- and reminder-management sub-agent. */
export function createPlannerAgent(tools: { reminders: MemoryTool[] }): SubAgent {
  const filtered = tools.reminders.filter((t) => PLANNER_TOOL_NAMES.has(t.name))
  return {
    name: 'planner',
    description:
      'Работа с напоминаниями и расписанием: создать, посмотреть, отменить напоминание. Делегируй когда юзер просит ему о чём-то напомнить.',
    systemPrompt:
      'Ты — планировщик. Работаешь с датами, временем и таймзонами пользователя. Если время неоднозначное (сегодня/завтра/утром) — уточни у вызывающего через текст ответа, не создавай напоминание наугад. Подтверждай создание коротко: что и когда.',
    tools: filtered,
    maxTurns: 5,
  }
}
