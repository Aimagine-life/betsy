/**
 * Wave 1A-iii — wiring test for delegation tools.
 *
 * Exercises `buildRootTools` directly: this is the helper both `runBetsy`
 * and `runBetsyStream` call to assemble the root agent's tool list. Testing
 * it in isolation avoids the runner's bigger integration surface (workspaces,
 * gemini, conversation persistence) while still catching the regression we
 * care about — that delegation tools end up in `allRootTools` and that they
 * actually invoke the sub-agent runner when called.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildRootTools } from '../../../src/multi/agents/root-tools.js'
import { createRunContext } from '../../../src/multi/agents/run-context.js'

function makeDeps() {
  return {
    factsRepo: {
      list: vi.fn().mockResolvedValue([]),
      listByKind: vi.fn().mockResolvedValue([]),
      listMissingEmbeddings: vi.fn().mockResolvedValue([]),
      searchByEmbedding: vi.fn().mockResolvedValue([]),
    } as any,
    convRepo: {
      recent: vi.fn().mockResolvedValue([]),
      append: vi.fn().mockResolvedValue({ id: 'row1' }),
      searchByEmbedding: vi.fn().mockResolvedValue([]),
    } as any,
    remindersRepo: {} as any,
    personaRepo: {} as any,
    s3: {} as any,
    gemini: {
      models: {
        generateContent: vi.fn(),
        generateContentStream: vi.fn(),
      },
    } as any,
  }
}

describe('buildRootTools — delegation wiring', () => {
  it('exposes all four delegate_to_* tools to the root agent', () => {
    const deps = makeDeps()
    const bundle = buildRootTools(deps, {
      workspaceId: 'ws-test',
      channel: 'telegram',
      currentChatId: 'chat-1',
      runContext: createRunContext(),
      mcpLoaded: null,
    })

    const names = bundle.delegationTools.map((t) => t.name).sort()
    expect(names).toEqual([
      'delegate_to_creative',
      'delegate_to_memory',
      'delegate_to_planner',
      'delegate_to_research',
    ])

    // delegationTools must be present in allRootTools too
    const rootNames = new Set(bundle.allRootTools.map((t) => t.name))
    expect(rootNames.has('delegate_to_memory')).toBe(true)
    expect(rootNames.has('delegate_to_research')).toBe(true)
    expect(rootNames.has('delegate_to_planner')).toBe(true)
    expect(rootNames.has('delegate_to_creative')).toBe(true)
  })

  it('also includes fetch_url in the leaf pool (so research sub-agent gets it)', () => {
    const deps = makeDeps()
    const bundle = buildRootTools(deps, {
      workspaceId: 'ws-test',
      channel: 'telegram',
      currentChatId: 'chat-1',
      runContext: createRunContext(),
      mcpLoaded: null,
    })

    const leafNames = new Set(bundle.leafTools.map((t) => t.name))
    expect(leafNames.has('fetch_url')).toBe(true)
    expect(leafNames.has('google_search')).toBe(true)
    // root keeps direct access to leaves (additive wiring)
    const rootNames = new Set(bundle.allRootTools.map((t) => t.name))
    expect(rootNames.has('fetch_url')).toBe(true)
  })

  it('omits skill tools when no SkillManager is wired in', () => {
    const deps = makeDeps()
    const bundle = buildRootTools(deps, {
      workspaceId: 'ws-test',
      channel: 'telegram',
      currentChatId: 'chat-1',
      runContext: createRunContext(),
      mcpLoaded: null,
    })

    expect(bundle.skillTools).toEqual([])
    const rootNames = new Set(bundle.allRootTools.map((t) => t.name))
    expect(rootNames.has('run_skill')).toBe(false)
    expect(rootNames.has('list_skills')).toBe(false)
  })

  it('delegate_to_research execute() launches the inner runner via bridge', async () => {
    const deps = makeDeps()
    const bundle = buildRootTools(deps, {
      workspaceId: 'ws-test',
      channel: 'telegram',
      currentChatId: 'chat-1',
      runContext: createRunContext(),
      mcpLoaded: null,
    })

    const research = bundle.delegationTools.find(
      (t) => t.name === 'delegate_to_research',
    )
    expect(research).toBeDefined()

    // Stub Gemini so the inner runner returns a deterministic text response.
    deps.gemini.models.generateContent = vi.fn().mockResolvedValue({
      candidates: [
        {
          content: { parts: [{ text: 'нашёл 3 новости про AI' }] },
        },
      ],
      usageMetadata: { totalTokenCount: 10 },
    })

    const result: any = await research!.execute({ task: 'найди новости про AI' })
    expect(result.ok).toBe(true)
    expect(result.agent).toBe('research')
    expect(result.output).toContain('AI')
    // generateContent was actually invoked by the inner gemini-runner
    expect(deps.gemini.models.generateContent).toHaveBeenCalled()
  })

  it('returns an error result (not a throw) when the sub-agent runner fails', async () => {
    const deps = makeDeps()
    deps.gemini.models.generateContent = vi
      .fn()
      .mockRejectedValue(new Error('upstream 500'))

    const bundle = buildRootTools(deps, {
      workspaceId: 'ws-test',
      channel: 'telegram',
      currentChatId: 'chat-1',
      runContext: createRunContext(),
      mcpLoaded: null,
    })

    const memory = bundle.delegationTools.find(
      (t) => t.name === 'delegate_to_memory',
    )
    const result: any = await memory!.execute({ task: 'forget password' })
    expect(result.error).toBeDefined()
    expect(result.error).toContain('upstream 500')
  })
})
