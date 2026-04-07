// Wave 2A — LearnerAgent: pattern detection.
//
// Two-stage pipeline:
//
//   1. Cheap heuristic filter — group messages by calendar day, extract the
//      sequence of tool names invoked within each day, find sequences of
//      length >= 1 that repeat across at least 2 distinct days.  This is
//      pure TS, zero LLM cost.  It both protects us from burning tokens on
//      workspaces with nothing interesting going on AND gives the LLM a
//      pre-digested "hint" to ground its output on real events.
//
//   2. LLM extraction (Gemini Flash, JSON mode) — given the raw user
//      messages + detected candidate tool sequences, return a list of
//      ConversationPattern.  The LLM can reject or refine the heuristic
//      hints; we then filter by confidence >= 0.6 and frequency >= 2.
//
// Everything is defensive: any failure of the LLM path degrades to "no
// patterns found" — the Learner just wastes a night, it never crashes the
// process.
import type { GoogleGenAI } from '@google/genai'
import type { Conversation } from '../memory/types.js'
import type { ConversationPattern } from './types.js'
import { log } from '../observability/logger.js'

const MODEL = 'gemini-2.5-flash'
const MIN_CONFIDENCE = 0.6
const MIN_FREQUENCY = 2
const MAX_PATTERNS_PER_CALL = 10

export interface PatternDetectorLLM {
  /** Generate raw JSON text. Caller parses. */
  generateJson(systemPrompt: string, userPrompt: string): Promise<string>
}

/** Thin shim around GoogleGenAI that matches intent-classifier's call pattern. */
export function createGeminiPatternLLM(gemini: GoogleGenAI): PatternDetectorLLM {
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

const SYSTEM_PROMPT = `Ты анализируешь историю диалога пользователя с AI-ассистентом Betsy за последние сутки. Твоя задача — найти ПОВТОРЯЮЩИЕСЯ ПАТТЕРНЫ действий пользователя, которые можно автоматизировать как навык (skill).

Критерии валидного паттерна:
- Пользователь делает одно и то же (или структурно похожее) МИНИМУМ 2 раза.
- Паттерн имеет понятный триггер (фразу/намерение) и понятный результат.
- Это не разовый запрос, а рутина.

НЕ придумывай паттерны. Если их нет — верни пустой массив. Честность важнее продуктивности.

Верни СТРОГО JSON в формате:
{
  "patterns": [
    {
      "description": "краткое описание паттерна (на русском)",
      "triggerExamples": ["пример 1", "пример 2"],
      "toolSequence": ["имя_тула_1", "имя_тула_2"],
      "frequency": 3,
      "confidence": 0.85
    }
  ]
}

Без markdown, без обрамляющего текста, ТОЛЬКО JSON.`

interface ToolCallEntry {
  name: string
}

/**
 * Extract tool names from a conversation row's tool_calls JSON. Tolerant to
 * several shapes: array of { name }, array of { tool }, array of strings.
 */
function extractToolNames(toolCalls: unknown): string[] {
  if (!toolCalls) return []
  if (!Array.isArray(toolCalls)) return []
  const names: string[] = []
  for (const tc of toolCalls as any[]) {
    if (!tc) continue
    if (typeof tc === 'string') {
      names.push(tc)
      continue
    }
    if (typeof tc.name === 'string') {
      names.push(tc.name)
      continue
    }
    if (typeof tc.tool === 'string') {
      names.push(tc.tool)
      continue
    }
    if (tc.functionCall?.name) {
      names.push(tc.functionCall.name)
      continue
    }
  }
  return names
}

function dayKey(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Stage 1 — heuristic.  Group tool calls by day, find sequences (of length
 * 1..3) that repeat across at least 2 days.  Returned as joined strings.
 */
export function detectHeuristicPatterns(
  history: Conversation[],
): { sequence: string[]; days: number }[] {
  const byDay = new Map<string, string[]>()
  for (const msg of history) {
    const names = extractToolNames(msg.toolCalls)
    if (names.length === 0) continue
    const key = dayKey(new Date(msg.createdAt))
    const arr = byDay.get(key) ?? []
    arr.push(...names)
    byDay.set(key, arr)
  }

  // For each day, enumerate contiguous sub-sequences of length 1..3.
  const seqToDays = new Map<string, Set<string>>()
  for (const [day, tools] of byDay.entries()) {
    for (let len = 1; len <= 3; len++) {
      for (let i = 0; i + len <= tools.length; i++) {
        const seq = tools.slice(i, i + len).join('>')
        const set = seqToDays.get(seq) ?? new Set<string>()
        set.add(day)
        seqToDays.set(seq, set)
      }
    }
  }

  const out: { sequence: string[]; days: number }[] = []
  for (const [seq, days] of seqToDays.entries()) {
    if (days.size >= MIN_FREQUENCY) {
      out.push({ sequence: seq.split('>'), days: days.size })
    }
  }
  // Longest/most-frequent first — gives the LLM the strongest signal up top.
  out.sort((a, b) => b.days - a.days || b.sequence.length - a.sequence.length)
  return out.slice(0, MAX_PATTERNS_PER_CALL)
}

function buildUserPrompt(
  history: Conversation[],
  heuristics: { sequence: string[]; days: number }[],
): string {
  const msgs = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-120)
    .map((m) => {
      const tools = extractToolNames(m.toolCalls)
      const suffix = tools.length > 0 ? `  [tools: ${tools.join(', ')}]` : ''
      const content = (m.content ?? '').slice(0, 300)
      return `- (${m.role}) ${content}${suffix}`
    })
    .join('\n')

  const hints =
    heuristics.length > 0
      ? heuristics
          .map(
            (h) =>
              `  * ${h.sequence.join(' -> ')} (повторов по дням: ${h.days})`,
          )
          .join('\n')
      : '  (эвристика ничего не нашла)'

  return `ИСТОРИЯ ДИАЛОГА (последние сутки, обрезано):
${msgs}

ЭВРИСТИЧЕСКИЕ ПОДСКАЗКИ (повторяющиеся последовательности тулов):
${hints}

Верни patterns JSON.`
}

function parsePatternsJson(raw: string): ConversationPattern[] {
  if (!raw) return []
  let obj: any
  try {
    obj = JSON.parse(raw)
  } catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return []
    try {
      obj = JSON.parse(m[0])
    } catch {
      return []
    }
  }
  const list = Array.isArray(obj?.patterns) ? obj.patterns : []
  const out: ConversationPattern[] = []
  for (const p of list) {
    if (!p || typeof p !== 'object') continue
    const description = typeof p.description === 'string' ? p.description : ''
    const triggerExamples = Array.isArray(p.triggerExamples)
      ? p.triggerExamples.filter((x: unknown) => typeof x === 'string').slice(0, 10)
      : []
    const toolSequence = Array.isArray(p.toolSequence)
      ? p.toolSequence.filter((x: unknown) => typeof x === 'string').slice(0, 20)
      : []
    const frequency = Number(p.frequency)
    const confidence = Number(p.confidence)
    if (!description || !Number.isFinite(frequency) || !Number.isFinite(confidence)) {
      continue
    }
    out.push({
      description,
      triggerExamples,
      toolSequence,
      frequency,
      confidence,
    })
  }
  return out
}

export interface DetectOptions {
  minConfidence?: number
  minFrequency?: number
}

/**
 * Full two-stage detection. Returns [] on any LLM error, never throws.
 */
export async function detectPatterns(
  history: Conversation[],
  llm: PatternDetectorLLM,
  options: DetectOptions = {},
): Promise<ConversationPattern[]> {
  const minConf = options.minConfidence ?? MIN_CONFIDENCE
  const minFreq = options.minFrequency ?? MIN_FREQUENCY

  if (history.length < 10) {
    log().debug('learner.detect: history too short, skipping', {
      size: history.length,
    })
    return []
  }

  const heuristics = detectHeuristicPatterns(history)
  log().info('learner.detect: heuristics computed', {
    messages: history.length,
    heuristicCount: heuristics.length,
  })

  let raw: string
  try {
    raw = await llm.generateJson(SYSTEM_PROMPT, buildUserPrompt(history, heuristics))
  } catch (e) {
    log().warn('learner.detect: llm failed', {
      error: e instanceof Error ? e.message : String(e),
    })
    return []
  }

  const parsed = parsePatternsJson(raw)
  // Dedupe by description (case-insensitive).
  const seen = new Set<string>()
  const unique: ConversationPattern[] = []
  for (const p of parsed) {
    const key = p.description.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(p)
  }

  const filtered = unique.filter(
    (p) => p.confidence >= minConf && p.frequency >= minFreq,
  )
  log().info('learner.detect: done', {
    rawCount: parsed.length,
    uniqueCount: unique.length,
    filteredCount: filtered.length,
  })
  return filtered
}
