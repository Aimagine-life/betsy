/**
 * Manual smoke test for Personal Betsy agent pipeline.
 *
 * Usage:
 *   BC_TEST_DATABASE_URL=postgres://... \
 *   GEMINI_API_KEY=... \
 *   npx tsx scripts/smoke-agent.ts
 *
 * Creates a test workspace with persona "Betsy", plants 2 facts about
 * the owner, sends "Привет, Betsy!" through runBetsy, and prints:
 *   - agent response text
 *   - tools called
 *   - tokens used
 *
 * Does NOT clean up — the test workspace persists so you can inspect
 * the database state after.
 */
import { Pool } from 'pg'
import { GoogleGenAI } from '@google/genai'
import { runMigrations } from '../src/multi/db/migrate.js'
import { WorkspaceRepo } from '../src/multi/workspaces/repo.js'
import { PersonaRepo } from '../src/multi/personas/repo.js'
import { FactsRepo } from '../src/multi/memory/facts-repo.js'
import { ConversationRepo } from '../src/multi/memory/conversation-repo.js'
import { RemindersRepo } from '../src/multi/reminders/repo.js'
import { runBetsy } from '../src/multi/agents/runner.js'

async function main() {
  const pgUrl = process.env.BC_TEST_DATABASE_URL ?? process.env.BC_DATABASE_URL
  if (!pgUrl) throw new Error('BC_TEST_DATABASE_URL or BC_DATABASE_URL required')
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY required')

  console.log('[smoke] connecting to postgres...')
  const pool = new Pool({ connectionString: pgUrl })
  await runMigrations(pool)

  const wsRepo = new WorkspaceRepo(pool)
  const personaRepo = new PersonaRepo(pool)
  const factsRepo = new FactsRepo(pool)
  const convRepo = new ConversationRepo(pool)
  const remindersRepo = new RemindersRepo(pool)

  console.log('[smoke] upserting test workspace...')
  const testTgId = 99999999
  const workspace = await wsRepo.upsertForTelegram(testTgId)
  await wsRepo.updateDisplayName(workspace.id, 'Константин')
  await wsRepo.updatePlan(workspace.id, 'personal')
  await wsRepo.updateStatus(workspace.id, 'active')

  console.log('[smoke] ensuring persona...')
  let persona = await personaRepo.findByWorkspace(workspace.id)
  if (!persona) {
    persona = await personaRepo.create(workspace.id, {
      presetId: 'betsy',
      name: 'Betsy',
      gender: 'female',
      voiceId: 'Aoede',
    })
  }

  console.log('[smoke] planting facts about the owner...')
  await factsRepo.remember(workspace.id, {
    kind: 'fact',
    content: 'Работает в Wildbots, строит AI-агентов',
  })
  await factsRepo.remember(workspace.id, {
    kind: 'preference',
    content: 'Пьёт кофе без сахара',
  })

  const gemini = new GoogleGenAI({ apiKey })
  const s3 = {} as any

  console.log('[smoke] calling Betsy...')
  const response = await runBetsy({
    workspaceId: workspace.id,
    userMessage: 'Привет, Betsy! Что ты обо мне помнишь?',
    channel: 'telegram',
    deps: {
      wsRepo,
      personaRepo,
      factsRepo,
      convRepo,
      remindersRepo,
      s3,
      gemini,
      agentRunner: async (agent, userMessage) => {
        const instruction = (agent as any).instruction ?? ''
        const model =
          typeof (agent as any).model === 'string'
            ? (agent as any).model
            : 'gemini-2.5-flash'
        const gResp = await gemini.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ text: userMessage }] }],
          config: {
            systemInstruction: instruction,
          } as any,
        })
        const text =
          (gResp as any).text ??
          (gResp as any).candidates?.[0]?.content?.parts?.[0]?.text ??
          ''
        const usage = (gResp as any).usageMetadata ?? {}
        return {
          text,
          toolCalls: [],
          tokensUsed: (usage.totalTokenCount as number) ?? 0,
        }
      },
    },
  })

  console.log('\n=== BETSY RESPONSE ===')
  console.log(response.text)
  console.log('\n=== TOKENS ===', response.tokensUsed)

  await pool.end()
}

main().catch((e) => {
  console.error('[smoke] failed:', e)
  process.exit(1)
})
