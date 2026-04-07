import { buildSystemPrompt, type PromptConfig } from '../../core/prompt.js'
import type { Persona } from '../personas/types.js'

export interface BuildPromptInput {
  persona: Persona
  userDisplayName: string | null
  addressForm: 'ty' | 'vy'
  /** Facts about the owner loaded from memory (bc_memory_facts kind='fact') */
  ownerFacts: string[]
  /** Optional personality sliders — if omitted, core uses defaults */
  personalitySliders?: Record<string, number>
}

/**
 * Build a system prompt for a Personal Betsy workspace.
 *
 * This function delegates to `src/core/prompt.ts#buildSystemPrompt`
 * — the same prompt builder used by single-mode Betsy. That guarantees
 * Personal Betsy has the exact same vibe, gender handling, tone, and
 * personality as the original single-mode Betsy.
 */
export function buildSystemPromptForPersona(input: BuildPromptInput): string {
  const { persona, userDisplayName, addressForm, ownerFacts, personalitySliders } = input

  const gender: 'female' | 'male' | undefined =
    persona.gender === 'female' ? 'female' : persona.gender === 'male' ? 'male' : undefined

  const config: PromptConfig = {
    name: persona.name,
    gender,
    personality: {
      customInstructions: persona.personalityPrompt ?? undefined,
    },
    personalitySliders,
    owner: {
      name: userDisplayName ?? undefined,
      addressAs: addressForm === 'ty' ? 'на ты' : 'на вы',
      facts: ownerFacts,
    },
  }

  const base = buildSystemPrompt(config)
  return `${base}\n\n${ADDRESS_INSTRUCTIONS}\n\n${FORMATTING_INSTRUCTIONS}`
}

const ADDRESS_INSTRUCTIONS = `## Как обращаться к собеседнику

НЕ называй его по имени в каждом сообщении — это звучит формально и раздражает. Имя используй только когда это уместно:
- В первом приветствии после долгой паузы
- Когда хочешь привлечь внимание к важному
- В очень эмоциональные моменты («Костя, ну ты что!»)

В обычном диалоге обращайся БЕЗ имени — как к близкому человеку. «Привет!», «Как дела?», «Что делаешь?» — а не «Привет, Константин!», «Как дела, Костя?». Натуральное общение друзей не строится на постоянном повторении имени.`

const FORMATTING_INSTRUCTIONS = `## Форматирование ответов

Пиши с лёгкой Markdown-разметкой — её увидят как Telegram HTML:
- **жирный** — для главного / акцентов
- _курсив_ — для лёгких акцентов
- \`код\` — для имён файлов, команд, технических деталей
- \`\`\`блок\`\`\` — для многострочного кода
- Списки через \`- \` в начале строки
- Ссылки в формате [текст](url)

Не злоупотребляй: для коротких реплик форматирование не нужно. Не оборачивай весь ответ в код. Не используй \`#\` заголовки — Telegram их не покажет.`
