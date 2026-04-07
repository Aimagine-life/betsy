/**
 * Dialogue Simulation Harness — validates Betsy's recall pipeline end-to-end.
 *
 * Usage (on VPS):
 *   node dist/multi/sim/dialogue-sim.js
 *
 * Environment: same as betsy-multi (.env.multi).
 */
import { Pool } from 'pg'
import { buildGemini, getGemini } from '../gemini/client.js'
import { asAdmin, withWorkspace } from '../db/rls.js'
import { embedText, toPgVector } from '../memory/embeddings.js'
import { WorkspaceRepo } from '../workspaces/repo.js'
import { PersonaRepo } from '../personas/repo.js'
import { FactsRepo } from '../memory/facts-repo.js'
import { ConversationRepo } from '../memory/conversation-repo.js'
import { RemindersRepo } from '../reminders/repo.js'
import { runBetsy } from '../agents/runner.js'
import { runWithGeminiTools } from '../agents/gemini-runner.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SIM_OWNER_TG_ID = 999_999_001
const SIM_CHAT_ID = '99999900'
const SIM_DISPLAY_NAME = 'SimTest'

interface SeedMessage {
  externalMessageId: number
  role: 'user' | 'assistant'
  content: string
}

const SEED_MESSAGES: SeedMessage[] = [
  {
    externalMessageId: 1001,
    role: 'user',
    content: 'Купил вчера новую кофемашину Delonghi La Specialista, варит отличный эспрессо',
  },
  {
    externalMessageId: 1002,
    role: 'assistant',
    content: 'Круто! La Specialista — отличный выбор, у неё двойной бойлер',
  },
  {
    externalMessageId: 1003,
    role: 'user',
    content: 'Аня записалась на йогу по вторникам и четвергам в зал на Тверской',
  },
  {
    externalMessageId: 1004,
    role: 'assistant',
    content:
      'Здорово что Аня нашла регулярные занятия, йога отлично снимает стресс',
  },
  {
    externalMessageId: 1005,
    role: 'user',
    content: 'Читаю сейчас книгу Sapiens Харари, очень зашло про когнитивную революцию',
  },
  {
    externalMessageId: 1006,
    role: 'assistant',
    content:
      'Sapiens крутая, особенно главы про сельскохозяйственную революцию',
  },
]

interface TestQuery {
  label: string
  userMessage: string
  expectedReplyTo: number | number[]
}

const TEST_QUERIES: TestQuery[] = [
  {
    label: 'Q1',
    userMessage: 'напомни что я говорил про кофемашину',
    expectedReplyTo: 1001,
  },
  {
    label: 'Q2',
    userMessage: 'когда ты в прошлый раз говорила про книги',
    expectedReplyTo: 1006,
  },
  {
    label: 'Q3',
    userMessage: 'что я писал про спорт',
    expectedReplyTo: 1003,
  },
  {
    label: 'Q4',
    userMessage: 'напомни всё про когнитивную революцию',
    expectedReplyTo: [1005, 1006],
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(msg: string, ...args: any[]) {
  const ts = new Date().toISOString()
  console.log(`[${ts}] ${msg}`, ...args)
}

function buildPool(url: string): Pool {
  return new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const dbUrl = process.env.BC_DATABASE_URL
  if (!dbUrl) {
    throw new Error('BC_DATABASE_URL is required')
  }

  // Build Gemini
  if (process.env.BC_GEMINI_VERTEX === '1') {
    buildGemini({
      vertexai: true,
      project: process.env.BC_GCP_PROJECT,
      location: process.env.BC_GCP_LOCATION ?? 'us-central1',
    })
    log('gemini: vertex ai mode', {
      project: process.env.BC_GCP_PROJECT,
      location: process.env.BC_GCP_LOCATION,
    })
  } else {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY required in non-vertex mode')
    buildGemini({ apiKey: process.env.GEMINI_API_KEY })
    log('gemini: ai studio mode')
  }
  const gemini = getGemini()

  const pool = buildPool(dbUrl)
  log('postgres pool created')

  const wsRepo = new WorkspaceRepo(pool)
  const personaRepo = new PersonaRepo(pool)
  const factsRepo = new FactsRepo(pool, gemini)
  const convRepo = new ConversationRepo(pool, gemini)
  const remindersRepo = new RemindersRepo(pool)

  // Stub s3 — recall doesn't use it
  const s3Stub: any = {
    download: async () => Buffer.from(''),
    upload: async () => 'sim://stub',
    getSignedUrl: async () => 'sim://stub',
    delete: async () => {},
  }

  const runBetsyDeps = {
    wsRepo,
    personaRepo,
    factsRepo,
    convRepo,
    remindersRepo,
    s3: s3Stub,
    gemini,
    agentRunner: async (
      agent: any,
      userMessage: string,
      history?: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>,
    ) => {
      return runWithGeminiTools(gemini, agent, userMessage, history ?? [])
    },
  }

  // -------------------------------------------------------------------------
  // Setup: create test workspace
  // -------------------------------------------------------------------------
  let workspaceId: string | null = null

  try {
    log(`=== Dialogue Simulation: Setup ===`)

    // Create workspace via asAdmin
    workspaceId = await asAdmin(pool, async (client) => {
      // First, clear any stale sim workspace
      await client.query(
        `delete from workspaces where owner_tg_id = $1`,
        [SIM_OWNER_TG_ID],
      )

      const { rows } = await client.query(
        `insert into workspaces (owner_tg_id, display_name, plan, status)
         values ($1, $2, 'trial', 'active')
         returning id`,
        [SIM_OWNER_TG_ID, SIM_DISPLAY_NAME],
      )
      return rows[0].id as string
    })
    log(`workspace created: ${workspaceId}`)

    // Create persona via withWorkspace (RLS scoped)
    await withWorkspace(pool, workspaceId, async (client) => {
      await client.query(
        `insert into bc_personas
          (workspace_id, name, voice_id, behavior_config)
         values ($1, 'Betsy', 'Aoede', '{"voice":"text_only","selfie":"on_request","video":"on_request"}')`,
        [workspaceId],
      )
    })
    log('persona created')

    // -------------------------------------------------------------------------
    // Seed 6 messages with real embeddings, far in the past
    // -------------------------------------------------------------------------
    log('seeding 6 messages with embeddings...')

    for (let i = 0; i < SEED_MESSAGES.length; i++) {
      const msg = SEED_MESSAGES[i]

      // Compute embedding
      log(`  embedding message ${msg.externalMessageId}: "${msg.content.slice(0, 50)}..."`)
      const vec = await embedText(gemini, msg.content)
      const pgVec = toPgVector(vec)

      // Insert 7 days ago so excludeRecentN skips them from the live context
      const daysAgo = 7
      const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)

      await withWorkspace(pool, workspaceId!, async (client) => {
        await client.query(
          `insert into bc_conversation
            (workspace_id, channel, role, content, chat_id, external_message_id, embedding, created_at)
           values ($1, 'telegram', $2, $3, $4, $5, $6::vector, $7)`,
          [workspaceId, msg.role, msg.content, SIM_CHAT_ID, msg.externalMessageId, pgVec, createdAt],
        )
      })
      log(`  seeded message ${msg.externalMessageId} (${msg.role})`)
    }

    log('all 6 messages seeded with real embeddings')

    // -------------------------------------------------------------------------
    // Run 4 test queries
    // -------------------------------------------------------------------------
    console.log('\n=== Dialogue Simulation Results ===\n')
    console.log(`Setup: created test workspace ${workspaceId}, seeded 6 messages\n`)

    let passCount = 0
    const results: { label: string; pass: boolean; details: string }[] = []

    for (const q of TEST_QUERIES) {
      log(`--- Running ${q.label}: "${q.userMessage}" ---`)

      let response: Awaited<ReturnType<typeof runBetsy>> | null = null
      let runError: string | null = null

      try {
        response = await runBetsy({
          workspaceId: workspaceId!,
          userMessage: q.userMessage,
          channel: 'telegram',
          currentChatId: SIM_CHAT_ID,
          deps: runBetsyDeps,
        })
      } catch (e) {
        runError = e instanceof Error ? `${e.message}\n${e.stack}` : String(e)
        log(`ERROR running ${q.label}:`, runError)
      }

      // Analyze tool calls
      const toolCalls = response?.toolCalls ?? []
      const toolCallList = (toolCalls as any[]).map((tc: any) => ({
        name: tc.name,
        args: tc.args,
        result: tc.result,
        error: tc.error,
      }))

      const recallCall = toolCallList.find((tc) => tc.name === 'recall_messages')
      const replyTargetCall = toolCallList.find((tc) => tc.name === 'set_reply_target')

      const recallCalled = recallCall != null
      const matchesCount = recallCall?.result?.matches?.length ?? 0
      const topSimilarity =
        recallCall?.result?.matches?.[0]?.similarity ?? 'n/a'

      const setReplyTargetCalled = replyTargetCall != null
      const setReplyTargetId = replyTargetCall?.args?.externalMessageId ?? undefined
      const actualReplyTo = response?.replyTo

      // Check PASS/FAIL
      const expectedIds = Array.isArray(q.expectedReplyTo)
        ? q.expectedReplyTo
        : [q.expectedReplyTo]
      const pass =
        !runError &&
        actualReplyTo != null &&
        expectedIds.includes(actualReplyTo as number)

      if (pass) passCount++

      // Format output
      const expectedStr = Array.isArray(q.expectedReplyTo)
        ? q.expectedReplyTo.join(' or ')
        : String(q.expectedReplyTo)

      const lines = [
        `${q.label}: "${q.userMessage}"`,
        `  recall_messages called: ${recallCalled ? 'yes' : 'NO'}`,
        `  matches returned: ${matchesCount}, top similarity: ${topSimilarity}`,
        `  set_reply_target called: ${setReplyTargetCalled ? `yes, with externalMessageId: ${setReplyTargetId}` : 'NO'}`,
        `  response.replyTo: ${actualReplyTo ?? 'undefined'}`,
        `  response.text: "${(response?.text ?? '').slice(0, 200)}"`,
        `  tool call sequence: [${toolCallList.map((tc) => tc.name).join(', ')}]`,
        `  EXPECTED replyTo=${expectedStr}, GOT replyTo=${actualReplyTo ?? 'undefined'}`,
        runError ? `  ERROR: ${runError.slice(0, 500)}` : null,
        `  VERDICT: ${pass ? 'PASS' : 'FAIL'}`,
      ]
        .filter(Boolean)
        .join('\n')

      console.log(lines)
      console.log()

      results.push({ label: q.label, pass, details: lines })
    }

    // -------------------------------------------------------------------------
    // Final verdict
    // -------------------------------------------------------------------------
    const overallPass = passCount === TEST_QUERIES.length
    console.log(`OVERALL: ${overallPass ? 'PASS' : 'FAIL'} (${passCount}/${TEST_QUERIES.length} queries succeeded)`)
  } finally {
    // -------------------------------------------------------------------------
    // Cleanup — always run
    // -------------------------------------------------------------------------
    log('\n=== Cleanup ===')
    if (workspaceId) {
      try {
        const deleted = await asAdmin(pool, async (client) => {
          // Delete conversation rows first (FK constraint), then persona, then workspace
          const convResult = await client.query(
            `delete from bc_conversation where workspace_id = $1`,
            [workspaceId],
          )
          const personaResult = await client.query(
            `delete from bc_personas where workspace_id = $1`,
            [workspaceId],
          )
          const factsResult = await client.query(
            `delete from bc_memory_facts where workspace_id = $1`,
            [workspaceId],
          )
          const wsResult = await client.query(
            `delete from workspaces where id = $1`,
            [workspaceId],
          )
          return {
            conv: convResult.rowCount ?? 0,
            persona: personaResult.rowCount ?? 0,
            facts: factsResult.rowCount ?? 0,
            ws: wsResult.rowCount ?? 0,
          }
        })
        console.log(
          `Cleanup: deleted workspace ${workspaceId} and ${deleted.conv} conversation rows, ${deleted.persona} personas, ${deleted.facts} facts, ${deleted.ws} workspace rows`,
        )
      } catch (cleanupErr) {
        console.error(
          `Cleanup FAILED for workspace ${workspaceId} — clean up manually!`,
          cleanupErr,
        )
      }
    } else {
      log('No workspace was created, nothing to clean up')
    }

    await pool.end()
    log('pool closed, exiting')
  }
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
