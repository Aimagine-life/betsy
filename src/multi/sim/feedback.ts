/**
 * Wave 2C — feedback loop standalone simulation.
 *
 * Exercises the in-memory ref store + a fake FeedbackService end-to-end
 * without Postgres or Telegram. Three assistant messages are "sent",
 * three callback queries are fired: one 👍, one 👎, one against an
 * evicted refId. The sim asserts the resulting counts and that the
 * expired click was rejected cleanly.
 *
 * Run: npx tsx src/multi/sim/feedback.ts
 * Exit 0 on success, non-zero on assertion failure.
 */

import {
  FeedbackRefStore,
} from '../feedback/ref-store.js'
import type { RecordFeedbackInput } from '../feedback/types.js'

interface FakeFeedbackService {
  submit(input: RecordFeedbackInput): Promise<void>
  records: RecordFeedbackInput[]
}

function makeFakeService(): FakeFeedbackService {
  const records: RecordFeedbackInput[] = []
  return {
    records,
    async submit(input) {
      records.push(input)
    },
  }
}

interface CallbackResult {
  answered: string
  submitted: boolean
}

async function simulateCallback(
  store: FeedbackRefStore,
  service: FakeFeedbackService,
  callbackData: string,
): Promise<CallbackResult> {
  const match = /^fb:(up|down):([a-f0-9]{6,32})$/.exec(callbackData)
  if (!match) return { answered: 'unknown', submitted: false }
  const rating: 1 | -1 = match[1] === 'up' ? 1 : -1
  const refId = match[2]
  const ref = store.get(refId)
  if (!ref) {
    return { answered: 'Эта оценка устарела', submitted: false }
  }
  await service.submit({
    workspaceId: ref.workspaceId,
    conversationId: ref.conversationId,
    channel: ref.channel,
    chatId: ref.chatId,
    messageId: ref.messageId ?? 'unknown',
    rating,
    rawText: ref.rawText,
    userMessage: ref.userMessage,
  })
  store.delete(refId)
  return {
    answered: rating === 1 ? 'Спасибо за 👍' : 'Спасибо, учту 👎',
    submitted: true,
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`ASSERT FAILED: ${msg}`)
    process.exit(1)
  }
}

async function main() {
  const store = new FeedbackRefStore(2) // tiny capacity to force eviction
  const service = makeFakeService()

  // --- Send message 1 (will receive 👍) ---
  const ref1 = FeedbackRefStore.newRefId()
  store.set(ref1, {
    workspaceId: 'ws-sim',
    channel: 'telegram',
    chatId: '100',
    rawText: 'Hello, user!',
    userMessage: 'Hi Betsy',
    messageId: '1001',
  })

  // --- Send message 2 (will receive 👎) ---
  const ref2 = FeedbackRefStore.newRefId()
  store.set(ref2, {
    workspaceId: 'ws-sim',
    channel: 'telegram',
    chatId: '100',
    rawText: 'Wrong answer',
    userMessage: 'What is 2+2?',
    messageId: '1002',
  })

  // --- Send message 3 — this evicts ref1 from the tiny store ---
  const ref3 = FeedbackRefStore.newRefId()
  store.set(ref3, {
    workspaceId: 'ws-sim',
    channel: 'telegram',
    chatId: '100',
    rawText: 'Another reply',
    messageId: '1003',
  })

  assert(store.get(ref1) === undefined, 'ref1 should have been evicted')
  assert(store.get(ref2) !== undefined, 'ref2 should still exist')
  assert(store.get(ref3) !== undefined, 'ref3 should still exist')

  // --- Callback #1: 👍 on ref1 — EVICTED ---
  const r1 = await simulateCallback(store, service, `fb:up:${ref1}`)
  assert(r1.submitted === false, '#1 should not submit (expired)')
  assert(r1.answered === 'Эта оценка устарела', '#1 should answer expired')

  // --- Callback #2: 👎 on ref2 ---
  const r2 = await simulateCallback(store, service, `fb:down:${ref2}`)
  assert(r2.submitted === true, '#2 should submit')
  assert(r2.answered.includes('👎'), '#2 should ack thumbs down')

  // --- Callback #3: 👍 on ref3 ---
  const r3 = await simulateCallback(store, service, `fb:up:${ref3}`)
  assert(r3.submitted === true, '#3 should submit')
  assert(r3.answered.includes('👍'), '#3 should ack thumbs up')

  // --- Double-click on ref2 — now expired because we deleted after submit ---
  const r2again = await simulateCallback(store, service, `fb:down:${ref2}`)
  assert(r2again.submitted === false, 'double-click should be no-op')

  // --- Assert recorded distribution ---
  assert(service.records.length === 2, `expected 2 submissions, got ${service.records.length}`)
  const up = service.records.filter((r) => r.rating === 1).length
  const down = service.records.filter((r) => r.rating === -1).length
  assert(up === 1 && down === 1, `expected 1 up + 1 down, got up=${up} down=${down}`)

  console.log('[sim/feedback] ok')
  console.log(`  records: ${service.records.length}, up=${up}, down=${down}`)
  console.log(`  expired clicks rejected: 1`)
  console.log(`  double-clicks rejected: 1`)
  process.exit(0)
}

main().catch((e) => {
  console.error('[sim/feedback] unhandled:', e)
  process.exit(2)
})
