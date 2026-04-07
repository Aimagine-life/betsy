import { GoogleGenAI } from '@google/genai'

let instance: GoogleGenAI | null = null
let imageInstance: GoogleGenAI | null = null
let imageFallbackInstance: GoogleGenAI | null = null
// gemini-3.1-flash-image-preview is only available in the "global" Vertex
// location for our project. us-central1 has stable 2.5-flash-image used as
// fallback when 3.1 flakes out with 5xx errors.
const IMAGE_LOCATION = 'global'
const IMAGE_FALLBACK_LOCATION = 'us-central1'

export interface GeminiConfig {
  /** AI Studio API key (legacy mode, blocked in some regions like Russia) */
  apiKey?: string
  /** When true, use Vertex AI instead of AI Studio (no regional restriction) */
  vertexai?: boolean
  /** GCP project id, required when vertexai=true */
  project?: string
  /** GCP location (e.g. "europe-west4", "us-central1"), required when vertexai=true */
  location?: string
}

export function buildGemini(config: GeminiConfig | string): GoogleGenAI {
  if (instance) return instance

  // Backward-compat: if a plain string is passed, treat it as legacy AI Studio apiKey
  const cfg: GeminiConfig = typeof config === 'string' ? { apiKey: config } : config

  if (cfg.vertexai) {
    if (!cfg.project) {
      throw new Error('Vertex AI mode requires "project" — set BC_GCP_PROJECT')
    }
    instance = new GoogleGenAI({
      vertexai: true,
      project: cfg.project,
      location: cfg.location ?? 'us-central1',
    } as any)
    // Image-gen models (gemini-2.5-flash-image-preview etc.) are NOT available
    // in europe-west4 — they live in us-central1. Build a second client pinned
    // to the image region so selfie generation works regardless of main loc.
    imageInstance = new GoogleGenAI({
      vertexai: true,
      project: cfg.project,
      location: IMAGE_LOCATION,
    } as any)
    imageFallbackInstance = new GoogleGenAI({
      vertexai: true,
      project: cfg.project,
      location: IMAGE_FALLBACK_LOCATION,
    } as any)
  } else {
    if (!cfg.apiKey) {
      throw new Error('AI Studio mode requires "apiKey" — set GEMINI_API_KEY')
    }
    instance = new GoogleGenAI({ apiKey: cfg.apiKey })
    imageInstance = instance
    imageFallbackInstance = instance
  }

  return instance
}

export function getGeminiImage(): GoogleGenAI {
  if (!imageInstance) {
    throw new Error('Gemini image client not initialized — call buildGemini first')
  }
  return imageInstance
}

export function getGeminiImageFallback(): GoogleGenAI {
  if (!imageFallbackInstance) {
    throw new Error('Gemini image fallback client not initialized — call buildGemini first')
  }
  return imageFallbackInstance
}

export function getGemini(): GoogleGenAI {
  if (!instance) {
    throw new Error('Gemini client not initialized — call buildGemini first')
  }
  return instance
}

export function resetGemini(): void {
  instance = null
}
