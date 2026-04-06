import type { BuildPromptInput } from './types.js'

/**
 * Build a Gemini-ready system prompt for a persona.
 *
 * Uses the persona's own personalityPrompt when set, otherwise constructs
 * a default prompt that gives Betsy her vibe: warm, smart, personal assistant
 * with a distinctive voice.
 *
 * Keeps the prompt deterministic (no timestamps, no random) so implicit
 * caching via Gemini works maximally.
 */
export function buildSystemPromptForPersona(input: BuildPromptInput): string {
  const { persona, userDisplayName, addressForm } = input

  const lines: string[] = []

  // Identity
  lines.push(`Тебя зовут ${persona.name}.`)
  if (persona.gender) {
    lines.push(`Твой пол — ${persona.gender}.`)
  }

  // Core vibe: either the user-customized prompt, or default Betsy flavor
  if (persona.personalityPrompt && persona.personalityPrompt.trim().length > 0) {
    lines.push('')
    lines.push(persona.personalityPrompt.trim())
  } else {
    lines.push('')
    lines.push(
      'Ты — личный AI-помощник с характером. Тёплая, умная, остроумная, внимательная к деталям.',
    )
    lines.push(
      'Ты помнишь важные факты о собеседнике и используешь их естественно, без подчёркнутого «я помню».',
    )
    lines.push(
      'Ты говоришь живым человеческим языком — без канцеляризма, без шаблонов, без формальных вступлений и извинений.',
    )
    lines.push(
      'Ты можешь шутить, быть серьёзной, поддержать в трудную минуту, помочь с задачей. Главное — быть рядом как друг.',
    )
  }

  // Biography if set
  if (persona.biography && persona.biography.trim().length > 0) {
    lines.push('')
    lines.push(`О тебе: ${persona.biography.trim()}`)
  }

  // User context
  lines.push('')
  if (userDisplayName) {
    lines.push(`Твоего собеседника зовут ${userDisplayName}.`)
  }
  lines.push(
    addressForm === 'ty'
      ? 'Обращайся к нему на ты, как к близкому другу.'
      : 'Обращайся к нему на вы, вежливо и с уважением.',
  )

  // Tool usage guidance
  lines.push('')
  lines.push(
    'У тебя есть инструменты: поиск в интернете (Google Search), память (запомнить факт / вспомнить / забыть), напоминания, генерация селфи, озвучивание ответа голосом.',
  )
  lines.push(
    'Используй инструменты естественно, когда это реально помогает. Не зови их без нужды.',
  )

  return lines.join('\n')
}
