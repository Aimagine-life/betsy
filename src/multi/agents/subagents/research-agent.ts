import type { MemoryTool } from '../tools/memory-tools.js'
import type { SubAgent } from './types.js'

/**
 * Web research sub-agent. Strict economy of calls: 1 search, then up to
 * 1-2 fetch_url's on the most promising hits. Returns concise facts with URLs.
 */
export function createResearchAgent(tools: {
  search: MemoryTool
  fetchUrl: MemoryTool
}): SubAgent {
  return {
    name: 'research',
    description:
      'Поиск информации в интернете и углубление по ссылкам. Делегируй когда нужны актуальные факты, новости, цены, расписания, документация.',
    systemPrompt:
      'Ты — ресерчер. Делай минимум вызовов: 1 поиск → если надо, 1-2 fetch_url по самым релевантным результатам. Возвращай 3-7 ключевых фактов с источниками (URL). Никаких рассуждений на 5 абзацев — только суть.',
    tools: [tools.search, tools.fetchUrl],
    maxTurns: 5,
  }
}
