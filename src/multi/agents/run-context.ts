/**
 * Per-turn mutable context shared between tool executions and the runner.
 *
 * Tools that need to influence how the final response is delivered (e.g.
 * set_reply_target, which makes the assistant's reply a Telegram reply-quote
 * of an earlier message) write into this object. The runner reads it after
 * the agent loop completes and propagates the values into BetsyResponse.
 *
 * One instance per turn. Never shared across turns.
 */
export interface RunContext {
  /** When set, the outgoing assistant reply should be sent as a Telegram reply
   *  to the message with this id. */
  replyTarget?: number
}

export function createRunContext(): RunContext {
  return {}
}
