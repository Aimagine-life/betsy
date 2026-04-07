import { describe, it, expect, vi } from 'vitest'
import { speak } from '../../../src/multi/gemini/tts.js'

function mockGemini(response: any) {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue(response),
    },
  } as any
}

describe('speak', () => {
  it('calls Gemini TTS with voice name and returns audio', async () => {
    const fakeAudio = Buffer.from('fake-pcm').toString('base64')
    const gemini = mockGemini({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { mimeType: 'audio/pcm', data: fakeAudio } }],
          },
        },
      ],
    })
    const out = await speak(gemini, 'Привет!', 'Aoede')
    expect(out.audioBase64).toBe(fakeAudio)
    const call = gemini.models.generateContent.mock.calls[0][0]
    expect(call.model).toBe('gemini-2.5-flash-preview-tts')
    expect(call.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Aoede')
  })

  it('throws when no audio returned', async () => {
    const gemini = mockGemini({
      candidates: [{ content: { parts: [{ text: 'blocked' }] } }],
    })
    await expect(speak(gemini, 'Hi', 'Aoede')).rejects.toThrow(/no audio/i)
  })
})
