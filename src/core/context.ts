import type { LLMMessage } from "./llm/types.js";

export class ContextManager {
  private maxTokens: number;

  constructor(opts: { maxTokens: number }) {
    this.maxTokens = opts.maxTokens;
  }

  /** Estimate token count using the rough heuristic: 4 chars ~ 1 token. */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Trim a message list to fit within maxTokens, keeping the most recent
   * messages. System messages are always preserved at the front.
   */
  trimMessages(messages: LLMMessage[]): LLMMessage[] {
    if (messages.length === 0) return [];

    // Separate system messages (always kept) from conversation messages
    const system: LLMMessage[] = [];
    const conversation: LLMMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        system.push(msg);
      } else {
        conversation.push(msg);
      }
    }

    // Budget remaining after system messages
    const systemTokens = system.reduce(
      (sum, m) => sum + this.estimateTokens(this.messageText(m)),
      0,
    );
    let budget = this.maxTokens - systemTokens;

    if (budget <= 0) {
      // System messages alone exceed the budget; return them anyway
      return system;
    }

    // Walk conversation from newest to oldest, accumulating within budget
    const kept: LLMMessage[] = [];
    for (let i = conversation.length - 1; i >= 0; i--) {
      const tokens = this.estimateTokens(this.messageText(conversation[i]));
      if (tokens > budget) break;
      budget -= tokens;
      kept.push(conversation[i]);
    }
    kept.reverse();

    return [...system, ...kept];
  }

  /** Extract plain text from a message for token estimation. */
  private messageText(msg: LLMMessage): string {
    if (typeof msg.content === "string") return msg.content;
    return JSON.stringify(msg.content);
  }
}
