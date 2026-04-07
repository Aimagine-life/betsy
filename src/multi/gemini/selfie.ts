import type { GoogleGenAI } from '@google/genai'
import { log } from '../observability/logger.js'

function isRetryable(e: any): { retry: boolean; reason: string } {
  const msg = String(e?.message ?? e ?? '')
  const status = e?.status ?? e?.response?.status ?? e?.code
  if (
    status === 429 ||
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('Resource exhausted')
  ) {
    return { retry: true, reason: '429' }
  }
  if (
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    msg.includes(' 500') ||
    msg.includes(' 502') ||
    msg.includes(' 503') ||
    msg.includes(' 504') ||
    msg.includes('INTERNAL') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('DEADLINE_EXCEEDED')
  ) {
    return { retry: true, reason: '5xx' }
  }
  return { retry: false, reason: '' }
}

async function withImageRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delays = [2000, 5000, 10000]
  let lastErr: any
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn()
    } catch (e: any) {
      lastErr = e
      const { retry, reason } = isRetryable(e)
      if (!retry || attempt === delays.length) throw e
      log().warn('selfie: retryable error, backing off', {
        label,
        reason,
        attempt: attempt + 1,
        delayMs: delays[attempt],
        error: String(e?.message ?? e),
      })
      await new Promise((r) => setTimeout(r, delays[attempt]))
    }
  }
  throw lastErr
}

export interface ReferenceImage {
  base64: string
  mimeType: string
}

export interface SelfieInput {
  references: ReferenceImage[]
  personaName: string
  scene: string
  aspectRatio: '3:4' | '1:1' | '9:16'
}

export interface SelfieOutput {
  imageBase64: string
  mimeType: string
}

function buildParts(input: SelfieInput): any[] {
  const parts: any[] = []
  for (const ref of input.references) {
    parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.base64 } })
  }
  parts.push({
    text:
      `Это ${input.personaName}. Запомни её лицо, волосы, стиль — сохрани максимально точно. ` +
      `Сгенерируй селфи в сцене: ${input.scene}. ` +
      `Ракурс — селфи-камера, натуральный свет, живое выражение лица.`,
  })
  return parts
}

async function callModel(
  gemini: GoogleGenAI,
  model: string,
  input: SelfieInput,
): Promise<SelfieOutput> {
  const response = await gemini.models.generateContent({
    model,
    contents: [{ role: 'user', parts: buildParts(input) }],
    config: {
      responseModalities: ['IMAGE'],
      imageConfig: {
        aspectRatio: input.aspectRatio,
        imageSize: '1K',
      },
    } as any,
  })

  const candidates = (response as any).candidates ?? []
  for (const c of candidates) {
    for (const p of c.content?.parts ?? []) {
      if (p.inlineData?.data) {
        return {
          imageBase64: p.inlineData.data,
          mimeType: p.inlineData.mimeType ?? 'image/png',
        }
      }
    }
  }
  throw new Error(`${model} returned no image`)
}

export async function generateSelfie(
  gemini: GoogleGenAI,
  input: SelfieInput,
  fallbackGemini?: GoogleGenAI,
): Promise<SelfieOutput> {
  const primaryModel = 'gemini-3.1-flash-image-preview'
  const fallbackModel = 'gemini-2.5-flash-image'
  try {
    const out = await withImageRetry(`${primaryModel}@global`, () =>
      callModel(gemini, primaryModel, input),
    )
    log().info('selfie: generated', { model: primaryModel, location: 'global' })
    return out
  } catch (primaryErr: any) {
    log().warn('selfie: primary model failed after retries, trying fallback', {
      model: primaryModel,
      error: String(primaryErr?.message ?? primaryErr),
    })
    if (!fallbackGemini) {
      throw primaryErr
    }
    try {
      const out = await withImageRetry(`${fallbackModel}@us-central1`, () =>
        callModel(fallbackGemini, fallbackModel, input),
      )
      log().info('selfie: generated via fallback', {
        model: fallbackModel,
        location: 'us-central1',
      })
      return out
    } catch (fallbackErr: any) {
      log().error('selfie: both primary and fallback failed', {
        primary: String(primaryErr?.message ?? primaryErr),
        fallback: String(fallbackErr?.message ?? fallbackErr),
      })
      throw fallbackErr
    }
  }
}
