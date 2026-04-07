import type { GoogleGenAI } from '@google/genai'
import { log } from '../observability/logger.js'

export const EMBEDDING_DIM = 768
export const EMBEDDING_MODEL = 'text-embedding-004'

/** Max characters to send to the embedding model (defensive truncation). */
const MAX_INPUT_CHARS = 8_000

/**
 * Compute a text embedding using Gemini text-embedding-004.
 * Throws on failure — caller decides whether to swallow.
 */
export async function embedText(gemini: GoogleGenAI, text: string): Promise<number[]> {
  const input = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text

  let resp: any
  try {
    resp = await gemini.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: input,
    })
  } catch (e) {
    log().error('embedText: embedContent call failed', {
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }

  // EmbedContentResponse.embeddings is ContentEmbedding[]; each has .values
  const values: number[] | undefined = resp?.embeddings?.[0]?.values
  if (!values || values.length === 0) {
    const err = new Error(`embedText: empty embedding returned (model=${EMBEDDING_MODEL})`)
    log().error(err.message, { respKeys: Object.keys(resp ?? {}) })
    throw err
  }

  return values
}

/**
 * Format a float array as a pgvector literal, e.g. "[0.1,0.2,...]".
 * Pass directly to a $N::vector parameter placeholder.
 */
export function toPgVector(v: number[]): string {
  return '[' + v.join(',') + ']'
}
