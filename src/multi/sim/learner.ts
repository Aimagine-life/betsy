/**
 * Learner Sim — standalone scenario validating end-to-end pattern detection
 * and candidate generation using mocked LLMs and in-memory repos.  No DB,
 * no network.  Exits 0 on success, non-zero on assertion failure.
 *
 *   npx tsx src/multi/sim/learner.ts
 */
import { Learner } from '../learner/learner.js'
import type { Conversation } from '../memory/types.js'
import type { PatternDetectorLLM } from '../learner/pattern-detector.js'
import type { SkillGeneratorLLM } from '../learner/skill-generator.js'

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log('[sim:learner]', ...args)
}

function mkMsg(
  i: number,
  role: 'user' | 'assistant',
  content: string,
  toolCalls: unknown = null,
  hoursAgo = 0,
): Conversation {
  const d = new Date(Date.now() - hoursAgo * 3600_000)
  return {
    id: `m${i}`,
    workspaceId: 'ws-sim',
    channel: 'telegram',
    role,
    content,
    toolCalls,
    tokensUsed: 0,
    meta: {},
    chatId: 'chat-sim',
    externalMessageId: i,
    createdAt: d,
  }
}

// Simulated 24h where the user asks about weather 3 times with the same
// recall -> google_search tool pattern.
const HISTORY: Conversation[] = [
  mkMsg(1, 'user', 'какая сегодня погода?', null, 23),
  mkMsg(2, 'assistant', 'Проверяю', [{ name: 'recall' }, { name: 'google_search' }], 23),
  mkMsg(3, 'assistant', '+5, облачно', null, 23),
  mkMsg(4, 'user', 'спасибо', null, 23),

  mkMsg(5, 'user', 'привет, расскажи про погоду', null, 15),
  mkMsg(6, 'assistant', 'Секунду', [{ name: 'recall' }, { name: 'google_search' }], 15),
  mkMsg(7, 'assistant', '+3, дождь', null, 15),

  mkMsg(8, 'user', 'погода на сегодня?', null, 2),
  mkMsg(9, 'assistant', 'Смотрю', [{ name: 'recall' }, { name: 'google_search' }], 2),
  mkMsg(10, 'assistant', '+7, солнце', null, 2),
  mkMsg(11, 'user', 'спасибо', null, 2),
  mkMsg(12, 'user', 'отлично', null, 1),
]

const patternLLM: PatternDetectorLLM = {
  async generateJson() {
    return JSON.stringify({
      patterns: [
        {
          description: 'Утренний запрос погоды через recall + google_search',
          triggerExamples: ['какая сегодня погода?', 'погода на сегодня?'],
          toolSequence: ['recall', 'google_search'],
          frequency: 3,
          confidence: 0.92,
        },
      ],
    })
  },
}

const generatorLLM: SkillGeneratorLLM = {
  async generateJson() {
    return JSON.stringify({
      name: 'morning_weather_brief',
      description: 'Утренний прогноз погоды',
      yaml: `name: morning_weather_brief
description: Утренний прогноз погоды
trigger:
  type: cron
  cron: "0 7 * * *"
steps:
  - kind: tool
    tool: google_search
    params:
      query: погода сегодня
`,
      rationale: 'Юзер каждое утро спрашивает погоду — автоматизируем.',
    })
  },
}

async function main(): Promise<void> {
  const inserted: Array<{ name: string; yaml: string }> = []
  const deps: any = {
    pool: {},
    convRepo: {
      async listSince() {
        return HISTORY
      },
    },
    skillsRepo: {
      async list() {
        return []
      },
    },
    candidatesRepo: {
      async expireOld() {
        return 0
      },
      async list() {
        return []
      },
      async insert(_ws: string, input: any) {
        inserted.push({ name: input.name, yaml: input.yaml })
        return { id: 'cand-1', ...input }
      },
    },
    patternLLM,
    generatorLLM,
    availableTools: () => ['google_search', 'recall'],
  }

  const learner = new Learner(deps)
  const result = await learner.runForWorkspace('ws-sim')
  log('result:', result)
  log('inserted:', inserted)

  const assert = (cond: boolean, msg: string): void => {
    if (!cond) {
      console.error('[sim:learner] ASSERT FAIL:', msg)
      process.exit(1)
    }
  }

  assert(result.patternsFound >= 1, 'expected at least one pattern')
  assert(result.candidatesCreated >= 1, 'expected at least one candidate created')
  assert(inserted.length >= 1, 'expected inserted candidates recorded')
  assert(
    /weather|brief/i.test(inserted[0].name) || inserted[0].name.length > 0,
    'candidate should have a reasonable name',
  )
  assert(
    inserted[0].yaml.includes('google_search'),
    'candidate YAML should reference google_search tool',
  )

  log('OK — all assertions passed')
  process.exit(0)
}

main().catch((e) => {
  console.error('[sim:learner] unexpected error:', e)
  process.exit(1)
})
