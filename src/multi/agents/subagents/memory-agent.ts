import type { MemoryTool } from '../tools/memory-tools.js'
import type { SubAgent } from './types.js'

/** Tool names this sub-agent is allowed to call. */
const MEMORY_TOOL_NAMES = new Set([
  'remember',
  'forget_fact',
  'forget_recent_messages',
  'forget_all',
])

/**
 * Long-term memory custodian. Decides what to keep, what to drop,
 * and how to resolve contradictions in stored facts.
 */
export function createMemoryAgent(tools: { memory: MemoryTool[] }): SubAgent {
  const filtered = tools.memory.filter((t) => MEMORY_TOOL_NAMES.has(t.name))
  return {
    name: 'memory',
    description:
      'Управление долговременной памятью: запомнить устойчивый факт, забыть тему, разрешить противоречие. Делегируй сюда когда нужно изменить что Бэтси знает о юзере.',
    systemPrompt:
      'Ты — модуль долговременной памяти Бэтси. Твоя зона: что помнить о пользователе, что забывать, как разрешать противоречия. Сохраняй только устойчивые факты, не сплетни и не сиюминутные мелочи. На запрос отвечай коротко: что сделал и что сохранил/удалил.',
    tools: filtered,
    maxTurns: 5,
  }
}
