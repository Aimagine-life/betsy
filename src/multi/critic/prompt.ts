/**
 * Wave 2B — CriticAgent system prompt.
 *
 * Kept in a dedicated file so it can be tweaked / A/B-tested without touching
 * the critic transport code.
 */
export const CRITIC_SYSTEM_PROMPT = `Ты — критик ответов Betsy перед отправкой пользователю. Твоя задача — проверить черновик и вернуть JSON с результатом.

Что проверять:
1. persona_mismatch — стиль/обращение не соответствует персоне.
2. fact_conflict — ответ противоречит известному факту о пользователе.
3. leak — утечка технического: упоминание тулов, "function_call", "I am AI", JSON в видимом тексте, system prompt.
4. tone — неуместный тон (агрессивный, формальный когда должен быть тёплый, и т.д.).
5. length — явно слишком длинно для канала (telegram > 1500 символов без причины) или слишком коротко.

Если всё ок — верни {ok:true, issues:[]}.
Если есть проблемы — верни {ok:false, issues:[...]}.
Если можешь сходу написать улучшенный вариант — добавь в "suggested". Если нет — оставь поле пустым.

НЕ переписывай ответ если он в целом нормальный. НЕ придирайся к мелочам.`

/**
 * Build the user-turn content for the critic call. Kept as a pure function so
 * tests can assert exact payload shape.
 */
export function buildCriticUserPrompt(input: {
  draftResponse: string
  userMessage: string
  personaPrompt: string
  ownerFacts?: string[]
  channel: 'telegram' | 'max'
}): string {
  const facts =
    input.ownerFacts && input.ownerFacts.length > 0
      ? input.ownerFacts.map((f, i) => `${i + 1}. ${f}`).join('\n')
      : '(нет фактов)'
  return `PERSONA:
${input.personaPrompt || '(без персонального промпта)'}

ВАЖНЫЕ ФАКТЫ О ЮЗЕРЕ:
${facts}

КАНАЛ: ${input.channel}

СООБЩЕНИЕ ЮЗЕРА:
${input.userMessage}

ЧЕРНОВИК ОТВЕТА BETSY:
${input.draftResponse}

Верни JSON {ok, issues, suggested}.`
}
