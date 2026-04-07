import { describe, it, expect } from 'vitest'
import { pickNotifyChannel } from '../../../src/multi/notify/preferences.js'

describe('pickNotifyChannel', () => {
  const baseWs = {
    ownerTgId: 1,
    ownerMaxId: 2,
    lastActiveChannel: 'telegram' as const,
    notifyChannelPref: 'auto' as const,
  }

  it('rule 1: notifyChannelPref override wins', () => {
    const result = pickNotifyChannel({
      workspace: { ...baseWs, notifyChannelPref: 'max' },
      preferredChannel: 'telegram',
      availableChannels: ['telegram', 'max'],
    })
    expect(result.channel).toBe('max')
    expect(result.reason).toBe('user_override')
  })

  it('rule 2: preferred_channel chosen when available', () => {
    const result = pickNotifyChannel({
      workspace: baseWs,
      preferredChannel: 'telegram',
      availableChannels: ['telegram', 'max'],
    })
    expect(result.channel).toBe('telegram')
    expect(result.reason).toBe('preferred_at_creation')
  })

  it('rule 3: fallback to last_active when preferred unavailable', () => {
    const result = pickNotifyChannel({
      workspace: { ...baseWs, lastActiveChannel: 'max' },
      preferredChannel: 'telegram',
      availableChannels: ['max'],
    })
    expect(result.channel).toBe('max')
    expect(result.reason).toBe('last_active')
  })

  it('rule 4: any available when neither preferred nor last_active works', () => {
    const result = pickNotifyChannel({
      workspace: { ...baseWs, lastActiveChannel: null },
      preferredChannel: 'telegram',
      availableChannels: ['max'],
    })
    expect(result.channel).toBe('max')
    expect(result.reason).toBe('any_available')
  })

  it('returns null when no channels at all', () => {
    const result = pickNotifyChannel({
      workspace: baseWs,
      preferredChannel: 'telegram',
      availableChannels: [],
    })
    expect(result.channel).toBeNull()
    expect(result.reason).toBe('no_channels')
  })

  it('does not pick telegram if ownerTgId is null', () => {
    const result = pickNotifyChannel({
      workspace: { ...baseWs, ownerTgId: null },
      preferredChannel: 'telegram',
      availableChannels: ['telegram', 'max'],
    })
    expect(result.channel).toBe('max')
  })

  it('does not pick max if ownerMaxId is null', () => {
    const result = pickNotifyChannel({
      workspace: { ...baseWs, ownerMaxId: null, notifyChannelPref: 'max' },
      preferredChannel: 'max',
      availableChannels: ['telegram', 'max'],
    })
    expect(result.channel).toBe('telegram')
  })
})
