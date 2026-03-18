import type { IncomingMessage, OutgoingMessage } from "./types.js";
import type { LLMClient, LLMMessage, ToolDefinition } from "./llm/types.js";
import type { ToolRegistry } from "./tools/registry.js";
import { buildSystemPrompt, type PromptConfig } from "./prompt.js";
import { searchKnowledge } from "./memory/knowledge.js";

const MAX_TURNS = 20;
const MAX_HISTORY = 40;

export interface EngineDeps {
  llm: { fast(): LLMClient; strong(): LLMClient };
  config: PromptConfig;
  tools: ToolRegistry;
}

export class Engine {
  private deps: EngineDeps;
  private histories: Map<string, LLMMessage[]> = new Map();

  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  async process(msg: IncomingMessage): Promise<OutgoingMessage> {
    const llm = this.deps.llm.fast();
    const userId = msg.userId;

    // Get or create history for this user
    if (!this.histories.has(userId)) {
      this.histories.set(userId, []);
    }
    const history = this.histories.get(userId)!;

    // Build system prompt with memory context
    const systemPrompt = this.buildPromptWithMemory(msg.text, userId);

    // Add user message
    history.push({ role: "user", content: msg.text });

    // Trim history to avoid context overflow
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }

    // Build tool definitions for the LLM
    const tools = this.buildToolDefinitions();

    try {
      // Agentic loop: LLM → tool calls → execute → repeat
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const messages: LLMMessage[] = [
          { role: "system", content: systemPrompt },
          ...history,
        ];

        const response = await llm.chat(messages, tools.length ? tools : undefined);

        // If LLM didn't request tools, return the text response
        if (response.stopReason !== "tool_use" || !response.toolCalls?.length) {
          const text = response.text || "...";
          history.push({ role: "assistant", content: text });
          return { text };
        }

        // Add assistant message with tool calls to history
        history.push({
          role: "assistant",
          content: response.text || "",
          toolCalls: response.toolCalls,
        });

        // Execute each tool and add results to history
        for (const tc of response.toolCalls) {
          const result = await this.executeTool(tc.name, tc.arguments);
          history.push({
            role: "tool",
            content: result,
            toolCallId: tc.id,
          });
        }

        console.log(`🔧 Turn ${turn + 1}: executed ${response.toolCalls.map(t => t.name).join(", ")}`);
      }

      // Max turns exceeded
      const text = "Достигнут лимит итераций. Попробуй переформулировать задачу.";
      history.push({ role: "assistant", content: text });
      return { text };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("Engine error:", errorMsg);
      return { text: `Ошибка: ${errorMsg}` };
    }
  }

  /** Build system prompt and inject relevant memory context. */
  private buildPromptWithMemory(userMessage: string, chatId: string): string {
    let prompt = buildSystemPrompt(this.deps.config, userMessage, chatId);

    // Search knowledge base for context relevant to the user's message
    try {
      const hits = searchKnowledge(userMessage, 5);
      if (hits.length > 0) {
        const memoryContext = hits
          .map((h, i) => `${i + 1}. [${h.topic}] ${h.insight}`)
          .join("\n");
        prompt += `\n\n## Релевантные знания из памяти\n\n${memoryContext}`;
      }
    } catch {
      // Memory not initialized yet — skip
    }

    return prompt;
  }

  /** Execute a single tool by name. Returns result string for the LLM. */
  private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.deps.tools.get(name);
    if (!tool) {
      return `Error: unknown tool "${name}"`;
    }

    try {
      const result = await tool.execute(args);
      return result.success
        ? result.output
        : `Error: ${result.error || result.output}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Convert our ToolParam[] format to OpenAI function-calling ToolDefinition[]. */
  private buildToolDefinitions(): ToolDefinition[] {
    return this.deps.tools.list().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object" as const,
          properties: Object.fromEntries(
            tool.parameters.map((p) => [
              p.name,
              { type: p.type, description: p.description },
            ]),
          ),
          required: tool.parameters
            .filter((p) => p.required)
            .map((p) => p.name),
        },
      },
    }));
  }
}
