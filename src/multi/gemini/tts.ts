import type { GoogleGenAI } from '@google/genai'

export interface TtsOutput {
  audioBase64: string
  mimeType: string
}

export async function speak(
  gemini: GoogleGenAI,
  text: string,
  voiceName: string,
): Promise<TtsOutput> {
  const response = await gemini.models.generateContent({
    model: 'gemini-2.5-flash-preview-tts',
    contents: [{ role: 'user', parts: [{ text }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName } },
      },
    } as any,
  })

  const candidates = (response as any).candidates ?? []
  for (const c of candidates) {
    for (const p of c.content?.parts ?? []) {
      if (p.inlineData?.data) {
        return {
          audioBase64: p.inlineData.data,
          mimeType: p.inlineData.mimeType ?? 'audio/pcm',
        }
      }
    }
  }
  throw new Error('Gemini TTS returned no audio')
}
