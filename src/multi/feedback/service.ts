import type { FeedbackEntry, FeedbackSummary, RecordFeedbackInput } from './types.js'
import type { FeedbackRepo } from './repo.js'

/** Slim facade on top of FeedbackRepo — this is what callers (bot router,
 *  telegram adapter callback, future CoachAgent) depend on. Keeps the repo
 *  interface narrow and easy to mock in tests. */
export class FeedbackService {
  constructor(private readonly repo: FeedbackRepo) {}

  async submit(input: RecordFeedbackInput): Promise<FeedbackEntry> {
    return this.repo.record(input)
  }

  async summary(workspaceId: string, days: number = 7): Promise<FeedbackSummary> {
    const { thumbsUp, thumbsDown } = await this.repo.countByRating(workspaceId, days)
    const total = thumbsUp + thumbsDown
    const ratio = total > 0 ? thumbsUp / total : 0
    return { thumbsUp, thumbsDown, total, ratio }
  }
}
