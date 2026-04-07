import { describe, it, expect } from 'vitest'
import { runWithGeminiToolsStream } from '../../../src/multi/agents/gemini-runner.js'

function fakeChunk(text?: string, fn?: { name: string; args: any }, totalTokens?: number) {
  const parts: any[] = []
  if (text) parts.push({ text })
  if (fn) parts.push({ functionCall: fn })
  return {
    candidates: [{ content: { parts } }],
    ...(totalTokens != null ? { usageMetadata: { totalTokenCount: totalTokens } } : {}),
  }
}

async function* asAsyncIter<T>(items: T[]): AsyncIterable<T> {
  for (const i of items) yield i
}

describe('runWithGeminiToolsStream', () => {
  it('emits accumulating text and resolves finalize with the full text', async () => {
    const fakeGemini: any = {
      models: {
        async generateContentStream(_args: any) {
          return asAsyncIter([
            fakeChunk('Hello'),
            fakeChunk(' world'),
            fakeChunk('!', undefined, 42),
          ])
        },
      },
    }
    const agent = { instruction: 'be nice', model: 'gemini-2.5-flash', tools: [] }
    const { textStream, finalize } = await runWithGeminiToolsStream(
      fakeGemini,
      agent,
      'hi',
    )
    const seen: string[] = []
    for await (const t of textStream) seen.push(t)
    expect(seen).toEqual(['Hello', 'Hello world', 'Hello world!'])
    const result = await finalize()
    expect(result.text).toBe('Hello world!')
    expect(result.tokensUsed).toBe(42)
    expect(result.toolCalls).toEqual([])
  })

  it('handles a tool call between two streams', async () => {
    let call = 0
    const tool = {
      name: 'echo',
      description: 'echo',
      parameters: { _def: {}, parse: () => ({}) } as any,
      async execute(args: any) {
        return { ok: true, args }
      },
    }
    const fakeGemini: any = {
      models: {
        async generateContentStream(_args: any) {
          call++
          if (call === 1) {
            return asAsyncIter([
              fakeChunk('thinking...'),
              fakeChunk(undefined, { name: 'echo', args: { x: 1 } }),
            ])
          }
          return asAsyncIter([fakeChunk(' done', undefined, 7)])
        },
      },
    }
    const agent = { instruction: '', model: 'gemini-2.5-flash', tools: [tool] }
    const { textStream, finalize } = await runWithGeminiToolsStream(
      fakeGemini,
      agent,
      'go',
    )
    const seen: string[] = []
    for await (const t of textStream) seen.push(t)
    const result = await finalize()
    expect(result.text).toBe('thinking... done')
    expect(seen[seen.length - 1]).toBe('thinking... done')
    expect(result.toolCalls).toHaveLength(1)
    expect((result.toolCalls[0] as any).name).toBe('echo')
  })
})
