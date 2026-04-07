/**
 * Wave 2B — CriticAgent sim harness.
 *
 * Runs three scenarios against an in-memory mock Gemini client:
 *   1. ok — draft is fine, critic says ok=true.
 *   2. flagged + suggested — critic returns ok=false with a rewrite; the
 *      runner-side helper shouldApplySuggestion() confirms the suggestion
 *      is eligible to replace the original.
 *   3. gemini failure — critic fails open and returns ok=true.
 *
 * Run: `BC_CRITIC_ENABLED=1 npx tsx src/multi/sim/critic.ts`
 * Exits with code 0 on success, non-zero with an error log on failure.
 */
import { Critic, shouldApplySuggestion } from '../critic/critic.js'
import type { CriticInput } from '../critic/types.js'

type Scenario = 'ok' | 'flagged' | 'fail'

function mockGemini(scenario: Scenario) {
  return {
    models: {
      generateContent: async (_req: any) => {
        if (scenario === 'fail') throw new Error('simulated gemini outage')
        if (scenario === 'ok') {
          return { text: JSON.stringify({ ok: true, issues: [] }) }
        }
        return {
          text: JSON.stringify({
            ok: false,
            issues: [
              { kind: 'tone', detail: 'Слишком сухо, персоне нужна теплота' },
              { kind: 'persona_mismatch', detail: 'Обращение на «вы», а должно быть на «ты»' },
            ],
            suggested:
              'Привет, солнышко! Я тут подумала — у меня есть пара идей для твоего вечера 🙈',
          }),
        }
      },
    },
  } as any
}

const sampleInput: CriticInput = {
  draftResponse: 'Здравствуйте. Вот варианты вашего досуга: 1) прогулка, 2) кино.',
  userMessage: 'Что сегодня вечером делать?',
  personaPrompt: 'Ты Betsy — тёплая подруга, всегда на «ты», лёгкий тон.',
  ownerFacts: ['зовут Костя', 'любит чай', 'живёт в Москве'],
  channel: 'telegram',
}

async function runScenario(name: Scenario): Promise<void> {
  const critic = new Critic({ gemini: mockGemini(name) })
  const res = await critic.review(sampleInput)

  if (name === 'ok') {
    if (!res.ok) throw new Error('[scenario=ok] expected ok=true')
    if (res.issues.length !== 0) throw new Error('[scenario=ok] expected zero issues')
    // eslint-disable-next-line no-console
    console.log(`[ok] passed — ms=${res.durationMs}`)
    return
  }

  if (name === 'flagged') {
    if (res.ok) throw new Error('[scenario=flagged] expected ok=false')
    if (res.issues.length < 2)
      throw new Error(`[scenario=flagged] expected >=2 issues, got ${res.issues.length}`)
    if (!res.suggested) throw new Error('[scenario=flagged] expected suggested rewrite')
    const decision = shouldApplySuggestion(sampleInput.draftResponse, res)
    if (!decision.apply)
      throw new Error(
        `[scenario=flagged] suggestion should be applied, got reason=${decision.reason}`,
      )
    // eslint-disable-next-line no-console
    console.log(
      `[flagged] passed — issues=${res.issues.length}, suggestedLen=${res.suggested.length}, ms=${res.durationMs}`,
    )
    return
  }

  // fail scenario: critic must fail open.
  if (!res.ok) throw new Error('[scenario=fail] expected fail-open ok=true')
  if (res.issues.length !== 0) throw new Error('[scenario=fail] expected empty issues on fail-open')
  // eslint-disable-next-line no-console
  console.log(`[fail] passed — fail-open, ms=${res.durationMs}`)
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('sim/critic: starting scenarios')
  await runScenario('ok')
  await runScenario('flagged')
  await runScenario('fail')
  // eslint-disable-next-line no-console
  console.log('sim/critic: all scenarios passed')
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('sim/critic: FAILED', e)
  process.exit(1)
})
