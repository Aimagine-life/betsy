import type { IncomingMessage, OutgoingMessage } from "./types.js";
import type { LLMClient, LLMMessage } from "./llm/types.js";
import { buildSystemPrompt, type PromptConfig } from "./prompt.js";

export interface EngineDeps {
  llm: { fast(): LLMClient; strong(): LLMClient };
  config: PromptConfig;
}

export class Engine {
  private deps: EngineDeps;
  private histories: Map<string, LLMMessage[]> = new Map();

  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  async process(msg: IncomingMessage): Promise<OutgoingMessage> {
    const llm = this.deps.llm.fast();

    // Get or create history for this user
    const userId = msg.userId;
    if (!this.histories.has(userId)) {
      this.histories.set(userId, []);
    }
    const history = this.histories.get(userId)!;

    // Build system prompt
    const systemPrompt = buildSystemPrompt(this.deps.config, msg.text, userId);

    // Add user message
    history.push({ role: "user", content: msg.text });

    // Keep last 20 messages to avoid context overflow
    if (history.length > 40) {
      history.splice(0, history.length - 40);
    }

    // Call LLM
    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      ...history,
    ];

    try {
      const response = await llm.chat(messages);
      const text = response.text || "...";

      // Save assistant response to history
      history.push({ role: "assistant", content: text });

      return { text };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("LLM error:", errorMsg);
      return { text: `Ошибка LLM: ${errorMsg}` };
    }
  }
}
