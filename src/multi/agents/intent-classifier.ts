import type { GoogleGenAI } from '@google/genai'
import { log } from '../observability/logger.js'

/**
 * Semantic intent classifier — runs ONE small Gemini Flash call before the
 * main agent turn to decide whether the user's message requires a forced
 * tool call, a clarifying question, or normal free-form processing.
 *
 * Why this exists: regex/keyword matching can't catch all the ways a user
 * asks for a selfie ("а можешь себя сфоткать?", "хочу тебя увидеть"), and
 * can't ask back when intent is ambiguous ("прикинь как ты выглядишь" —
 * unclear if they want a photo or just chat). LLMs reading a long history
 * can also drift ("я уже отправляла, помнишь?") which the main agent loop
 * can't recover from. A dedicated classifier with a tight, single-purpose
 * prompt and no history sees only the latest user message and decides.
 *
 * Output is one of three actions:
 *   - { action: 'force_tool', tool, args }  → main turn forces this tool
 *   - { action: 'clarify', question }       → router replies directly, skips main turn
 *   - { action: 'normal' }                  → main turn runs unconstrained
 */

export type ClassifierAction =
  | { action: 'force_tool'; tool: string; args?: Record<string, any> }
  | { action: 'clarify'; question: string }
  | { action: 'normal' }

const CLASSIFIER_MODEL = 'gemini-2.5-flash'

const SYSTEM = `Ты — классификатор намерений пользователя для AI-ассистентки Betsy.

Тебе на вход даётся ПОСЛЕДНЕЕ сообщение пользователя (или несколько склеенных коротких подряд). Ты должна понять что пользователь хочет, и вернуть СТРОГО ОДИН JSON-объект — без обрамляющего текста, без markdown.

Доступные действия:

1. **force_tool: generate_selfie** — пользователь хочет получить фото/селфи Betsy. Триггеры по смыслу: "пришли селфи", "скинь фотку", "покажи себя", "хочу тебя увидеть", "сфоткайся", "а как ты выглядишь?", "ещё фоточку", "ну где?" (если предыдущий контекст явно про фото) и любые синонимы. Если в тексте есть подсказка о сцене — извлеки её в args.scene на естественном языке. Если сцены нет — оставь scene пустым, бэкенд подставит дефолт. Пример: { "action": "force_tool", "tool": "generate_selfie", "args": { "scene": "пьёт кофе в кафе" } }

2. **force_tool: google_search** — пользователь хочет актуальную информацию из интернета: новости, цены, ссылки, погода, расписания, проверка фактов. Извлеки запрос в args.query. Пример: { "action": "force_tool", "tool": "google_search", "args": { "query": "курс доллара сегодня" } }

3. **clarify** — намерение НЕ ясно или сообщение слишком короткое чтобы понять. Например "а можно?", "ну?", "и?", "ага", "хм". Верни question — короткий естественный переспрос в стиле Betsy (тёплый, на ты). Пример: { "action": "clarify", "question": "Что именно? 🙈" }

4. **normal** — обычное общение, вопрос, рассказ, эмоция, всё что не требует обязательного тула и не требует переспроса. Пример: { "action": "normal" }

ВАЖНО:
- Возвращай ТОЛЬКО JSON, без блоков кода, без комментариев
- Для force_tool: generate_selfie — даже если в истории были отказы или ошибки, ВСЁ РАВНО force_tool. История не твоя забота.
- Не используй force_tool для случаев когда юзер просто упоминает фото в контексте ("у меня есть фотка кота") — только когда он хочет ПОЛУЧИТЬ селфи Betsy.
- clarify используй редко — только если без переспроса невозможно действовать. Большинство сообщений = normal.`

export async function classifyIntent(
  gemini: GoogleGenAI,
  userMessage: string,
): Promise<ClassifierAction> {
  if (!userMessage || userMessage.trim().length === 0) {
    return { action: 'normal' }
  }
  try {
    const t0 = Date.now()
    const resp: any = await gemini.models.generateContent({
      model: CLASSIFIER_MODEL,
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      config: {
        systemInstruction: SYSTEM,
        responseMimeType: 'application/json',
        // Tight token budget — output is at most ~80 tokens
        maxOutputTokens: 200,
        temperature: 0.0,
      } as any,
    })
    const text =
      (resp as any).text ??
      (resp as any).candidates?.[0]?.content?.parts?.[0]?.text ??
      ''
    const ms = Date.now() - t0
    log().info('classifier: response', { ms, raw: String(text).slice(0, 300) })
    if (!text) return { action: 'normal' }
    let parsed: any
    try {
      parsed = JSON.parse(String(text))
    } catch {
      // Try to extract JSON from possibly-wrapped text
      const m = String(text).match(/\{[\s\S]*\}/)
      if (!m) return { action: 'normal' }
      try {
        parsed = JSON.parse(m[0])
      } catch {
        return { action: 'normal' }
      }
    }

    if (parsed?.action === 'force_tool' && typeof parsed.tool === 'string') {
      return {
        action: 'force_tool',
        tool: parsed.tool,
        args: typeof parsed.args === 'object' ? parsed.args : undefined,
      }
    }
    if (parsed?.action === 'clarify' && typeof parsed.question === 'string') {
      return { action: 'clarify', question: parsed.question }
    }
    return { action: 'normal' }
  } catch (e) {
    log().warn('classifier: failed, falling back to normal', {
      error: e instanceof Error ? e.message : String(e),
    })
    return { action: 'normal' }
  }
}
