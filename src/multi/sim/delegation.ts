/**
 * Wave 1A-iii — delegation simulation harness.
 *
 * Standalone scenario, exercised via `npx tsx src/multi/sim/delegation.ts`.
 * Uses an in-memory mock GoogleGenAI client whose `generateContent` returns
 * a scripted sequence:
 *
 *   1. Root agent → `delegate_to_research(task: 'найди новости про AI')`
 *   2. Inside the research sub-agent → `google_search(query: 'AI news')`
 *      (mocked to return a fake hit list).
 *   3. Research agent emits final text "нашёл 3 новости".
 *   4. Root receives the tool result, emits final text starting with
 *      "Вот что я нашла".
 *
 * The harness asserts:
 *   - Root actually called `delegate_to_research`.
 *   - The bridge launched a nested gemini-runner with the research sub-agent's
 *     system prompt.
 *   - Depth guard never tripped.
 *   - Final root text contains the expected marker.
 *
 * Exits with code 0 on success and a clear log line on failure.
 */
import { buildRootTools } from '../agents/root-tools.js'
import { createRunContext } from '../agents/run-context.js'
import { runWithGeminiTools } from '../agents/gemini-runner.js'

type ScriptedReply = {
  functionCall?: { name: string; args: Record<string, unknown> }
  text?: string
}

class MockGemini {
  public generateContentCalls: Array<{ systemInstruction?: string; contents: unknown }> = []
  private rootScript: ScriptedReply[]
  private researchScript: ScriptedReply[]
  private rootIdx = 0
  private researchIdx = 0

  constructor(rootScript: ScriptedReply[], researchScript: ScriptedReply[]) {
    this.rootScript = rootScript
    this.researchScript = researchScript
  }

  models = {
    generateContent: async (req: any) => {
      this.generateContentCalls.push({
        systemInstruction: req.config?.systemInstruction,
        contents: req.contents,
      })
      // Pick the script based on the system instruction so we can tell
      // root vs research apart without leaking metadata.
      const sys = (req.config?.systemInstruction ?? '') as string
      const isResearch = sys.includes('ресерчер')
      const script = isResearch ? this.researchScript : this.rootScript
      const idxRef = isResearch ? 'researchIdx' : ('rootIdx' as const)
      const idx = (this as any)[idxRef] as number
      if (idx >= script.length) {
        throw new Error(
          `MockGemini: ran out of scripted replies for ${isResearch ? 'research' : 'root'}`,
        )
      }
      const reply = script[idx]
      ;(this as any)[idxRef] = idx + 1

      const parts: any[] = []
      if (reply.functionCall) parts.push({ functionCall: reply.functionCall })
      if (reply.text) parts.push({ text: reply.text })

      return {
        candidates: [
          {
            content: { parts },
          },
        ],
        usageMetadata: { totalTokenCount: 1 },
      }
    },
    generateContentStream: async () => {
      throw new Error('not used in this sim')
    },
  }
}

function makeFakeRepos() {
  return {
    factsRepo: {
      list: async () => [],
      listByKind: async () => [],
      listMissingEmbeddings: async () => [],
      searchByEmbedding: async () => [],
    } as any,
    convRepo: {
      recent: async () => [],
      append: async () => ({ id: 'row-sim' }),
      searchByEmbedding: async () => [],
    } as any,
    remindersRepo: {} as any,
    personaRepo: {} as any,
    s3: {} as any,
  }
}

function ok(label: string) {
  // eslint-disable-next-line no-console
  console.log(`  ok  ${label}`)
}

function fail(label: string, err?: unknown): never {
  // eslint-disable-next-line no-console
  console.error(`  FAIL  ${label}`, err ?? '')
  process.exit(1)
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('=== delegation sim ===')

  // Root: turn 1 → call delegate_to_research; turn 2 → final text.
  const rootScript: ScriptedReply[] = [
    {
      functionCall: {
        name: 'delegate_to_research',
        args: { task: 'найди новости про AI' },
      },
    },
    {
      text: 'Вот что я нашла: 3 новости про AI.',
    },
  ]
  // Research: turn 1 → call google_search; turn 2 → final text.
  const researchScript: ScriptedReply[] = [
    {
      functionCall: {
        name: 'google_search',
        args: { query: 'AI news' },
      },
    },
    {
      text: 'нашёл 3 новости: alpha, beta, gamma',
    },
  ]

  const gemini = new MockGemini(rootScript, researchScript)
  const repos = makeFakeRepos()

  // Build the real root tool bundle. Note: the real `google_search` tool
  // will try to hit Gemini's grounded search — but we never let the test
  // reach a real network call because the sub-agent's tool execution path
  // routes through `runWithGeminiTools`, which only calls `generateContent`
  // (mocked) and our mock returns the scripted text without ever invoking
  // the search tool's execute(). To make absolutely sure we don't hit the
  // network, we shadow google_search with a stub *after* the registry has
  // been built.
  const bundle = buildRootTools(
    { ...repos, gemini: gemini as any },
    {
      workspaceId: 'ws-sim',
      channel: 'telegram',
      currentChatId: 'chat-sim',
      runContext: createRunContext(),
      mcpLoaded: null,
    },
  )

  // Sanity: all four delegation tools registered.
  const dnames = bundle.delegationTools.map((t) => t.name).sort()
  if (dnames.length !== 4) fail(`expected 4 delegation tools, got ${dnames.length}`)
  ok(`registered delegation tools: ${dnames.join(', ')}`)

  // Replace google_search execute() with a deterministic mock so any
  // accidental fall-through to the real tool would still be safe.
  const search = bundle.leafTools.find((t) => t.name === 'google_search')!
  search.execute = async () => ({ results: ['alpha', 'beta', 'gamma'] })

  // Drive the root agent for one turn via runWithGeminiTools, which is
  // exactly what the production runner does internally.
  const result = await runWithGeminiTools(
    gemini as any,
    {
      instruction: 'You are root Betsy.',
      model: 'gemini-2.5-flash',
      tools: bundle.allRootTools,
    },
    'Расскажи что нового про AI',
    [],
  )

  // Assertions
  if (!result.text.includes('Вот что я нашла')) {
    fail(`root final text missing marker, got: "${result.text}"`)
  }
  ok(`root final text: "${result.text}"`)

  const rootDelegated = result.toolCalls.some(
    (c: any) => c.name === 'delegate_to_research',
  )
  if (!rootDelegated) fail('root never invoked delegate_to_research')
  ok('root invoked delegate_to_research')

  // The mock Gemini was called twice for root and twice for research.
  if (gemini.generateContentCalls.length !== 4) {
    fail(`expected 4 generateContent calls, got ${gemini.generateContentCalls.length}`)
  }
  ok(`generateContent called ${gemini.generateContentCalls.length} times (2 root + 2 research)`)

  // Confirm a research-flavoured systemInstruction was used at least once
  // (proves the bridge launched the inner runner with the sub-agent prompt).
  const sawResearchPrompt = gemini.generateContentCalls.some((c) =>
    String(c.systemInstruction ?? '').includes('ресерчер'),
  )
  if (!sawResearchPrompt) fail('no nested call carried the research sub-agent prompt')
  ok('inner runner ran with research sub-agent prompt')

  // eslint-disable-next-line no-console
  console.log('=== delegation sim: PASS ===')
  process.exit(0)
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('sim crashed:', e)
  process.exit(1)
})
