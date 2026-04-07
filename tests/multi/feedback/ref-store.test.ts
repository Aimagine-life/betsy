import { describe, it, expect } from 'vitest'
import {
  FeedbackRefStore,
  getFeedbackRefStore,
  __resetFeedbackRefStoreForTests,
} from '../../../src/multi/feedback/ref-store.js'

describe('FeedbackRefStore', () => {
  it('generates 12-char hex refIds', () => {
    const id = FeedbackRefStore.newRefId()
    expect(id).toMatch(/^[a-f0-9]{12}$/)
    // Stays well under telegram's 64-byte callback_data limit
    expect(Buffer.byteLength(`fb:down:${id}`)).toBeLessThan(32)
  })

  it('set/get round-trips data', () => {
    const store = new FeedbackRefStore(10)
    store.set('abc', {
      workspaceId: 'ws1',
      channel: 'telegram',
      chatId: '100',
      rawText: 'hi',
    })
    const got = store.get('abc')
    expect(got?.workspaceId).toBe('ws1')
    expect(got?.rawText).toBe('hi')
  })

  it('update merges into existing entry', () => {
    const store = new FeedbackRefStore(10)
    store.set('x', { workspaceId: 'w', channel: 'telegram', chatId: '1' })
    store.update('x', { messageId: '42' })
    expect(store.get('x')?.messageId).toBe('42')
    expect(store.get('x')?.workspaceId).toBe('w')
  })

  it('update is a no-op for missing refs', () => {
    const store = new FeedbackRefStore(10)
    store.update('ghost', { messageId: '1' })
    expect(store.get('ghost')).toBeUndefined()
  })

  it('evicts oldest entry when full (FIFO)', () => {
    const store = new FeedbackRefStore(3)
    store.set('a', { workspaceId: 'w', channel: 'telegram', chatId: '1' })
    store.set('b', { workspaceId: 'w', channel: 'telegram', chatId: '2' })
    store.set('c', { workspaceId: 'w', channel: 'telegram', chatId: '3' })
    store.set('d', { workspaceId: 'w', channel: 'telegram', chatId: '4' })

    expect(store.size).toBe(3)
    expect(store.get('a')).toBeUndefined()
    expect(store.get('b')).toBeDefined()
    expect(store.get('d')).toBeDefined()
  })

  it('delete removes an entry', () => {
    const store = new FeedbackRefStore()
    store.set('k', { workspaceId: 'w', channel: 'telegram', chatId: '1' })
    store.delete('k')
    expect(store.get('k')).toBeUndefined()
  })

  it('singleton is reset-friendly for tests', () => {
    const a = getFeedbackRefStore()
    a.set('shared', { workspaceId: 'w', channel: 'telegram', chatId: '1' })
    __resetFeedbackRefStoreForTests()
    const b = getFeedbackRefStore()
    expect(b.get('shared')).toBeUndefined()
    expect(a).not.toBe(b)
  })
})
