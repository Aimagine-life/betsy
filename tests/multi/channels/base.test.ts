import { describe, it, expect } from 'vitest'
import type { InboundEvent, OutboundMessage, ChannelAdapter, ChannelName } from '../../../src/multi/channels/base.js'

describe('channel base types', () => {
  it('exports channel names', () => {
    const names: ChannelName[] = ['telegram', 'max']
    expect(names).toHaveLength(2)
  })

  it('InboundEvent shape compiles', () => {
    const ev: InboundEvent = {
      channel: 'telegram',
      chatId: '123',
      userId: '456',
      userDisplay: 'Константин',
      text: 'Привет',
      messageId: 'mid1',
      timestamp: new Date(),
      isVoiceMessage: false,
      raw: null,
    }
    expect(ev.channel).toBe('telegram')
  })

  it('OutboundMessage supports text and audio', () => {
    const textOnly: OutboundMessage = { chatId: '1', text: 'Hello' }
    const withAudio: OutboundMessage = {
      chatId: '1',
      text: 'Hello',
      audio: { base64: 'xxx', mimeType: 'audio/ogg' },
    }
    const withImage: OutboundMessage = {
      chatId: '1',
      text: 'Look',
      image: { url: 'https://x/y.png' },
    }
    expect(textOnly.chatId).toBe('1')
    expect(withAudio.audio?.mimeType).toBe('audio/ogg')
    expect(withImage.image && 'url' in withImage.image ? withImage.image.url : '').toContain('https')
  })

  it('ChannelAdapter type can be referenced', () => {
    const _t: ChannelAdapter | null = null
    expect(_t).toBeNull()
  })
})
