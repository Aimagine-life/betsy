import type { IncomingMessage, OutgoingMessage, ProgressCallback } from "./types.js";
import type { LLMClient, LLMMessage, ToolDefinition } from "./llm/types.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { ToolResult } from "./tools/types.js";
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

  /** Get conversation history for a user (for scheduler context). */
  getHistory(userId: string): Array<{ role: string; content: string }> {
    const history = this.histories.get(userId);
    if (!history) return [];
    return history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "" }));
  }

  async process(msg: IncomingMessage, onProgress?: ProgressCallback): Promise<OutgoingMessage> {
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
      let lastMediaUrl: string | undefined;

      // Agentic loop: LLM → tool calls → execute → repeat
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        onProgress?.({ type: "thinking" });

        const messages: LLMMessage[] = [
          { role: "system", content: systemPrompt },
          ...history,
        ];

        // Use streaming for text responses, non-streaming for tool calls
        const streamChunk = onProgress
          ? (chunk: string) => onProgress({ type: "text_chunk", chunk })
          : undefined;

        const response = streamChunk
          ? await llm.chatStream(messages, streamChunk, tools.length ? tools : undefined)
          : await llm.chat(messages, tools.length ? tools : undefined);

        // If LLM didn't request tools, return the text response
        if (response.stopReason !== "tool_use" || !response.toolCalls?.length) {
          const text = response.text || "...";
          history.push({ role: "assistant", content: text });
          return { text, mediaUrl: lastMediaUrl };
        }

        // Add assistant message with tool calls to history
        history.push({
          role: "assistant",
          content: response.text || "",
          toolCalls: response.toolCalls,
        });

        // Execute each tool and add results to history
        for (const tc of response.toolCalls) {
          onProgress?.({ type: "tool_start", tool: tc.name, turn: turn + 1 });

          const result = await this.executeTool(tc.name, tc.arguments);
          const resultText = result.success
            ? result.output
            : `Error: ${result.error || result.output}`;

          if (result.mediaUrl) {
            lastMediaUrl = result.mediaUrl;
          }

          history.push({
            role: "tool",
            content: resultText,
            toolCallId: tc.id,
          });

          onProgress?.({ type: "tool_end", tool: tc.name, turn: turn + 1, success: result.success });
        }

        onProgress?.({ type: "turn_complete", turn: turn + 1, totalTurns: MAX_TURNS });
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

  /** Execute a single tool by name. Returns full ToolResult. */
  private async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.deps.tools.get(name);
    if (!tool) {
      return { success: false, output: "", error: `unknown tool "${name}"` };
    }

    try {
      return await tool.execute(args);
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
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
