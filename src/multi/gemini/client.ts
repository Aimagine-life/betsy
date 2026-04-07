import { GoogleGenAI } from '@google/genai'

let instance: GoogleGenAI | null = null

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
  } else {
    if (!cfg.apiKey) {
      throw new Error('AI Studio mode requires "apiKey" — set GEMINI_API_KEY')
    }
    instance = new GoogleGenAI({ apiKey: cfg.apiKey })
  }

  return instance
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
