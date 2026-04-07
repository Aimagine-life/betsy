import type { MemoryTool } from '../tools/memory-tools.js'
import type { SubAgent } from './types.js'

/** Creative sub-agent — currently selfie generation. */
export function createCreativeAgent(tools: { selfie: MemoryTool }): SubAgent {
  return {
    name: 'creative',
    description:
      'Креативные генерации: селфи Бэтси в разных сценах. Делегируй когда юзер просит фотку, картинку или селфи.',
    systemPrompt:
      'Ты — креативный помощник Бэтси. Генерируешь селфи. Перед вызовом тула уточни короткое описание сцены, если запрос неполный. Не выдумывай детали внешности — бери их из персоны Бэтси.',
    tools: [tools.selfie],
    maxTurns: 3,
  }
}
