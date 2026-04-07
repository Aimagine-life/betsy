import { describe, it, expect, vi } from 'vitest'
import { FeedbackService } from '../../../src/multi/feedback/service.js'
import type { FeedbackRepo } from '../../../src/multi/feedback/repo.js'

function makeRepo(overrides: Partial<FeedbackRepo> = {}): FeedbackRepo {
  return {
    record: vi.fn(async (i: any) => ({
      id: 'fid',
      workspaceId: i.workspaceId,
      channel: i.channel,
      chatId: i.chatId,
      messageId: i.messageId,
      rating: i.rating,
      createdAt: new Date(),
    })),
    listRecent: vi.fn(async () => []),
    countByRating: vi.fn(async () => ({ thumbsUp: 0, thumbsDown: 0 })),
    getByMessage: vi.fn(async () => null),
    ...overrides,
  } as unknown as FeedbackRepo
}

describe('FeedbackService', () => {
  it('submit forwards to repo.record', async () => {
    const repo = makeRepo()
    const svc = new FeedbackService(repo)
    const entry = await svc.submit({
      workspaceId: 'w1',
      channel: 'telegram',
      chatId: '100',
      messageId: '7',
      rating: 1,
    })
    expect(entry.id).toBe('fid')
    expect(repo.record).toHaveBeenCalledOnce()
  })

  it('summary computes ratio from counts', async () => {
    const repo = makeRepo({
      countByRating: vi.fn(async () => ({ thumbsUp: 3, thumbsDown: 1 })),
    })
    const svc = new FeedbackService(repo)
    const s = await svc.summary('w1', 7)
    expect(s.thumbsUp).toBe(3)
    expect(s.thumbsDown).toBe(1)
    expect(s.total).toBe(4)
    expect(s.ratio).toBeCloseTo(0.75)
  })

  it('summary ratio is zero when no feedback', async () => {
    const repo = makeRepo({
      countByRating: vi.fn(async () => ({ thumbsUp: 0, thumbsDown: 0 })),
    })
    const svc = new FeedbackService(repo)
    const s = await svc.summary('w1')
    expect(s.total).toBe(0)
    expect(s.ratio).toBe(0)
  })

  it('summary defaults to 7 days', async () => {
    const repo = makeRepo()
    const svc = new FeedbackService(repo)
    await svc.summary('w1')
    expect(repo.countByRating).toHaveBeenCalledWith('w1', 7)
  })
})
