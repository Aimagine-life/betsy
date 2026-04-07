import { describe, it, expect, vi } from 'vitest'
import { generateSelfie } from '../../../src/multi/gemini/selfie.js'

function mockGemini(response: any) {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue(response),
    },
  } as any
}

describe('generateSelfie', () => {
  it('calls Nano Banana 2 with 3 references and scene prompt', async () => {
    const fakeImageBase64 = Buffer.from('fake-png').toString('base64')
    const gemini = mockGemini({
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { mimeType: 'image/png', data: fakeImageBase64 } },
            ],
          },
        },
      ],
    })
    const result = await generateSelfie(gemini, {
      references: [
        { base64: 'ref1', mimeType: 'image/png' },
        { base64: 'ref2', mimeType: 'image/png' },
        { base64: 'ref3', mimeType: 'image/png' },
      ],
      personaName: 'Betsy',
      scene: 'в уютном кафе утром',
      aspectRatio: '3:4',
    })
    expect(result.imageBase64).toBe(fakeImageBase64)
    expect(gemini.models.generateContent).toHaveBeenCalledTimes(1)
    const call = gemini.models.generateContent.mock.calls[0][0]
    expect(call.model).toBe('gemini-3.1-flash-image-preview')
    expect(call.contents[0].parts).toHaveLength(4)
    expect(call.contents[0].parts[3].text).toContain('Betsy')
    expect(call.contents[0].parts[3].text).toContain('уютном кафе')
  })

  it('throws when no image returned', async () => {
    const gemini = mockGemini({
      candidates: [{ content: { parts: [{ text: 'refused' }] } }],
    })
    await expect(
      generateSelfie(gemini, {
        references: [],
        personaName: 'Betsy',
        scene: 'anywhere',
        aspectRatio: '3:4',
      }),
    ).rejects.toThrow(/no image/i)
  })
})
