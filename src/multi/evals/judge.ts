/**
 * Wave 4 — LLM judge.
 *
 * Given a piece of agent output and a list of natural-language properties
 * (e.g. "ответ на ты", "не упоминает gemini"), asks Gemini Flash to mark
 * each property as satisfied or violated. Returns a normalized score
 * (satisfied / total).
 *
 * The actual model call is injected so unit tests can pass a stub. The
 * default implementation expects a Gemini-shaped client with a
 * `models.generateContent` method that returns a JSON object matching
 * { satisfied: string[], violated: string[] }.
 */

export interface JudgeResult {
  score: number
  perProperty: Record<string, boolean>
}

export type JudgeFn = (text: string, properties: string[]) => Promise<JudgeResult>

export interface GeminiLikeClient {
  models: {
    generateContent: (req: {
      model: string
      contents: unknown
      config?: unknown
    }) => Promise<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }>
  }
}

const JUDGE_PROMPT = `Ты — строгий judge. Оцени, удовлетворяет ли текст ассистента каждому свойству из списка.
Верни строго JSON: {"satisfied": ["свойство1", ...], "violated": ["свойство2", ...]}.
Каждое свойство из входа должно попасть ровно в один из массивов.`

export function makeJudge(client: GeminiLikeClient, model = 'gemini-2.5-flash'): JudgeFn {
  return async function judge(text: string, properties: string[]): Promise<JudgeResult> {
    if (properties.length === 0) {
      return { score: 1, perProperty: {} }
    }
    const userPrompt = `Текст ассистента:\n"""\n${text}\n"""\n\nСвойства:\n${properties
      .map((p, i) => `${i + 1}. ${p}`)
      .join('\n')}`

    const resp = await client.models.generateContent({
      model,
      contents: [
        { role: 'user', parts: [{ text: JUDGE_PROMPT + '\n\n' + userPrompt }] },
      ],
      config: { responseMimeType: 'application/json' },
    })

    const raw = resp.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
    let parsed: { satisfied?: string[]; violated?: string[] }
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`judge: invalid JSON from model: ${raw.slice(0, 200)}`)
    }

    const satisfied = new Set(parsed.satisfied ?? [])
    const perProperty: Record<string, boolean> = {}
    let satisfiedCount = 0
    for (const p of properties) {
      const ok = satisfied.has(p)
      perProperty[p] = ok
      if (ok) satisfiedCount += 1
    }
    return {
      score: satisfiedCount / properties.length,
      perProperty,
    }
  }
}

/** Convenience export so callers can import directly. */
export const judge: JudgeFn = async () => {
  throw new Error('judge: no LLM configured — pass a JudgeFn from makeJudge() instead')
}
