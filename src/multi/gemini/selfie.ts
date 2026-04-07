import type { GoogleGenAI } from '@google/genai'

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

export async function generateSelfie(
  gemini: GoogleGenAI,
  input: SelfieInput,
): Promise<SelfieOutput> {
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

  const response = await gemini.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: [{ role: 'user', parts }],
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
  throw new Error('Nano Banana 2 returned no image')
}
