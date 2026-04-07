import { describe, it, expect, vi } from 'vitest'
import { buildInboundFromMaxUpdate, MaxAdapter } from '../../../src/multi/channels/max.js'

describe('buildInboundFromMaxUpdate', () => {
  it('maps message_created with chat recipient', () => {
    const update: any = {
      update_type: 'message_created',
      message: {
        body: { mid: 'm1', text: 'Привет' },
        recipient: { chat_id: 1001 },
        sender: { user_id: 500, name: 'Константин' },
      },
      timestamp: 1700000000000,
    }
    const ev = buildInboundFromMaxUpdate(update)
    expect(ev).not.toBeNull()
    expect(ev!.channel).toBe('max')
    expect(ev!.chatId).toBe('1001')
    expect(ev!.userId).toBe('500')
    expect(ev!.userDisplay).toBe('Константин')
    expect(ev!.text).toBe('Привет')
  })

  it('falls back to sender.user_id as chat when no recipient.chat_id', () => {
    const update: any = {
      update_type: 'message_created',
      message: {
        body: { mid: 'm1', text: 'Hi' },
        recipient: {},
        sender: { user_id: 500, name: 'K' },
      },
    }
    const ev = buildInboundFromMaxUpdate(update)
    expect(ev!.chatId).toBe('500')
  })

  it('returns null for non-message updates', () => {
    expect(buildInboundFromMaxUpdate({ update_type: 'something_else' } as any)).toBeNull()
  })
})

describe('MaxAdapter.sendMessage (via mocked fetch)', () => {
  it('POSTs to /messages with chat_id param and JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    })
    const adapter = new MaxAdapter('test-token', fetchMock as any)
    await adapter.sendMessage({ chatId: '42', text: 'Привет' })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, options] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/messages')
    expect(String(url)).toContain('chat_id=42')
    expect((options as any).method).toBe('POST')
    expect((options as any).headers['Authorization']).toBe('test-token')
    const body = JSON.parse((options as any).body)
    expect(body.text).toBe('Привет')
  })
})
