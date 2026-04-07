import { GoogleGenAI } from '@google/genai'

let instance: GoogleGenAI | null = null

export function buildGemini(apiKey: string): GoogleGenAI {
  if (!instance) {
    instance = new GoogleGenAI({ apiKey })
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
