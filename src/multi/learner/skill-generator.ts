// Wave 2A — LearnerAgent: skill candidate generation.
//
// Takes a detected ConversationPattern plus the list of currently-available
// tool names and asks Gemini Flash to produce a YAML document matching the
// WorkspaceSkill schema. The YAML is then:
//
//   1. Parsed + validated through parseSkillYaml (existing Wave-1C code).
//   2. Checked for tool references that don't exist in availableTools.
//   3. Step count capped (defensive — parser already has bounds).
//
// Any failure at any stage throws — the Learner catches and skips that
// particular pattern, logging the reason.
import type { GoogleGenAI } from '@google/genai'
import { parseSkillYaml, SkillParseError } from '../skills/parser.js'
import type { WorkspaceSkill, SkillStep } from '../skills/types.js'
import type { ConversationPattern, GeneratedCandidate } from './types.js'
import { log } from '../observability/logger.js'

const MODEL = 'gemini-2.5-flash'
const MAX_STEPS = 50

export interface SkillGeneratorLLM {
  generateJson(systemPrompt: string, userPrompt: string): Promise<string>
}

export function createGeminiSkillGeneratorLLM(
  gemini: GoogleGenAI,
): SkillGeneratorLLM {
  return {
    async generateJson(systemPrompt, userPrompt) {
      const resp: any = await gemini.models.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json',
          maxOutputTokens: 2000,
          temperature: 0.2,
        } as any,
      })
      return (
        (resp as any).text ??
        (resp as any).candidates?.[0]?.content?.parts?.[0]?.text ??
        ''
      )
    },
  }
}

function buildSystemPrompt(availableTools: string[]): string {
  return `Ты — генератор YAML-скилов для AI-ассистента Betsy.

Тебе дают обнаруженный поведенческий паттерн пользователя. Твоя задача — сгенерировать YAML-навык (workspace skill), который автоматизирует этот паттерн.

СХЕМА YAML:
name: короткое_snake_case_имя
description: что делает навык (на русском, 1-2 предложения)
trigger:
  type: manual | cron | keyword | event
  cron: "<cron если type=cron>"
  keywords: ["список", "слов"] # если type=keyword
  event: "<событие>"             # если type=event
steps:
  - kind: tool
    tool: имя_тула
    params:
      ключ: значение
    saveAs: имя_переменной  # опционально
  - kind: prompt
    prompt: "текст промпта"
  - kind: condition
    if: "vars.x > 0"
    then: [ ... ]
    else: [ ... ]
  - kind: loop
    over: "vars.list"
    as: "item"
    do: [ ... ]

ДОСТУПНЫЕ ТУЛЫ (используй ТОЛЬКО их имена в step.tool):
${availableTools.length > 0 ? availableTools.map((t) => `- ${t}`).join('\n') : '(список пуст — используй только kind: prompt)'}

ПРАВИЛА:
- ТОЛЬКО JSON-ответ вида: { "name": "...", "description": "...", "yaml": "...", "rationale": "..." }
- Поле yaml — строка с валидным YAML по схеме выше.
- Не выдумывай тулы, которых нет в списке выше.
- Минимум 1 шаг, максимум ${MAX_STEPS} шагов.
- Имя в snake_case, до 60 символов, без пробелов.
- rationale — одно предложение: почему этот скил полезен юзеру.
- Если паттерн явно требует запуска по расписанию (например утром) — используй trigger.type=cron.  Иначе — manual.
- Никакого markdown, никаких обрамлений, ТОЛЬКО JSON.`
}

function buildUserPrompt(pattern: ConversationPattern): string {
  return `ПАТТЕРН:
- Описание: ${pattern.description}
- Примеры триггерных сообщений: ${pattern.triggerExamples.slice(0, 5).join(' | ')}
- Последовательность тулов: ${pattern.toolSequence.join(' -> ') || '(нет тулов, чистый промпт)'}
- Частота: ${pattern.frequency}
- Confidence: ${pattern.confidence}

Сгенерируй YAML-кандидата в виде JSON.`
}

function parseGeneratorResponse(raw: string): {
  name: string
  description: string
  yaml: string
  rationale: string
} {
  if (!raw) throw new Error('empty llm response')
  let obj: any
  try {
    obj = JSON.parse(raw)
  } catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('llm response is not json')
    obj = JSON.parse(m[0])
  }
  if (!obj || typeof obj !== 'object') {
    throw new Error('llm json is not an object')
  }
  const name = String(obj.name ?? '').trim()
  const description = String(obj.description ?? '').trim()
  const yaml = String(obj.yaml ?? '').trim()
  const rationale = String(obj.rationale ?? '').trim()
  if (!name) throw new Error('missing name')
  if (!yaml) throw new Error('missing yaml')
  return { name, description, yaml, rationale }
}

/** Recursively walk SkillStep[] collecting every tool name referenced. */
function collectToolReferences(steps: SkillStep[]): string[] {
  const out: string[] = []
  const visit = (s: SkillStep): void => {
    if (s.kind === 'tool') out.push(s.tool)
    else if (s.kind === 'condition') {
      s.then.forEach(visit)
      s.else?.forEach(visit)
    } else if (s.kind === 'loop') {
      s.do.forEach(visit)
    }
  }
  steps.forEach(visit)
  return out
}

function countSteps(steps: SkillStep[]): number {
  let n = 0
  const visit = (s: SkillStep): void => {
    n += 1
    if (s.kind === 'condition') {
      s.then.forEach(visit)
      s.else?.forEach(visit)
    } else if (s.kind === 'loop') {
      s.do.forEach(visit)
    }
  }
  steps.forEach(visit)
  return n
}

export class SkillGenerationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'SkillGenerationError'
  }
}

/**
 * Generate a validated skill candidate from a detected pattern.  Throws
 * SkillGenerationError on any failure — caller should log and skip.
 */
export async function generateSkillFromPattern(
  pattern: ConversationPattern,
  llm: SkillGeneratorLLM,
  availableTools: string[],
): Promise<GeneratedCandidate> {
  let raw: string
  try {
    raw = await llm.generateJson(
      buildSystemPrompt(availableTools),
      buildUserPrompt(pattern),
    )
  } catch (e) {
    throw new SkillGenerationError(
      `llm call failed: ${e instanceof Error ? e.message : String(e)}`,
      e,
    )
  }

  let parsed: { name: string; description: string; yaml: string; rationale: string }
  try {
    parsed = parseGeneratorResponse(raw)
  } catch (e) {
    throw new SkillGenerationError(
      `failed to parse llm response: ${e instanceof Error ? e.message : String(e)}`,
      e,
    )
  }

  let skill: WorkspaceSkill
  try {
    skill = parseSkillYaml(parsed.yaml)
  } catch (e) {
    if (e instanceof SkillParseError) {
      throw new SkillGenerationError(`generated yaml invalid: ${e.message}`, e)
    }
    throw new SkillGenerationError(
      `generated yaml failed to parse: ${e instanceof Error ? e.message : String(e)}`,
      e,
    )
  }

  // Step count guard.
  const total = countSteps(skill.steps)
  if (total > MAX_STEPS) {
    throw new SkillGenerationError(
      `generated skill has ${total} steps, exceeds max ${MAX_STEPS}`,
    )
  }

  // Tool whitelist check.
  if (availableTools.length > 0) {
    const allowed = new Set(availableTools)
    const refs = collectToolReferences(skill.steps)
    const missing = refs.filter((r) => !allowed.has(r))
    if (missing.length > 0) {
      throw new SkillGenerationError(
        `generated skill references unknown tools: ${[...new Set(missing)].join(', ')}`,
      )
    }
  }

  log().info('learner.generate: ok', {
    name: skill.name,
    steps: total,
  })

  return {
    name: skill.name,
    description: parsed.description || skill.description || '',
    yaml: parsed.yaml,
    rationale: parsed.rationale || '',
  }
}
