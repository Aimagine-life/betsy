import type { IncomingMessage, OutgoingMessage, LLMMessage } from "./types.js";
import type { Tool, ToolResult } from "./tools/types.js";

export interface LLMClient {
  chat(
    messages: LLMMessage[],
    options?: { tools?: unknown[] },
  ): Promise<{
    text?: string;
    tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  }>;
}

export interface ToolRegistry {
  list(): Tool[];
  get(name: string): Tool | undefined;
  getToolDefinitions(): unknown[];
}

export interface EngineDeps {
  llm: { fast(): LLMClient; strong(): LLMClient };
  config: Record<string, unknown>;
  tools: ToolRegistry;
}

const MAX_TURNS = 20;

export class Engine {
  private deps: EngineDeps;
  private history: LLMMessage[] = [];
  private progressHandlers: Array<(status: string) => void> = [];

  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  onProgress(handler: (status: string) => void): void {
    this.progressHandlers.push(handler);
  }

  private emitProgress(status: string): void {
    for (const handler of this.progressHandlers) {
      handler(status);
    }
  }

  async process(msg: IncomingMessage): Promise<OutgoingMessage> {
    const llm = this.deps.llm.fast();
    const toolDefs = this.deps.tools.getToolDefinitions();

    // Build system prompt
    const systemPrompt = this.buildSystemPrompt();

    // Add user message to history
    this.history.push({ role: "user", content: msg.text });

    // Build messages for this call: system + history
    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      ...this.history,
    ];

    // Agentic loop
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await llm.chat(messages, {
        tools: toolDefs.length > 0 ? toolDefs : undefined,
      });

      // If LLM returns text (no tool calls), this is the final response
      if (!response.tool_calls || response.tool_calls.length === 0) {
        const text = response.text ?? "";
        this.history.push({ role: "assistant", content: text });
        return { text };
      }

      // Process tool calls
      for (const toolCall of response.tool_calls) {
        const tool = this.deps.tools.get(toolCall.name);

        if (!tool) {
          // Tool not found — add error result and continue loop
          const errorMsg = `Tool "${toolCall.name}" not found`;
          messages.push({
            role: "assistant",
            content: `Calling tool: ${toolCall.name}`,
          });
          messages.push({
            role: "tool",
            content: JSON.stringify({ success: false, output: "", error: errorMsg }),
            tool_call_id: toolCall.name,
          });
          this.emitProgress(`Tool "${toolCall.name}" not found`);
          continue;
        }

        // Confirmation check
        if (tool.requiresConfirmation) {
          const paramsStr = JSON.stringify(toolCall.arguments);
          this.emitProgress(
            `\u26a0\ufe0f \u0425\u043e\u0447\u0443 \u0432\u044b\u043f\u043e\u043b\u043d\u0438\u0442\u044c: ${tool.name}(${paramsStr}). \u0420\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u044c?`,
          );
        }

        // Execute tool
        let result: ToolResult;
        try {
          result = await tool.execute(toolCall.arguments);
        } catch (err) {
          result = {
            success: false,
            output: "",
            error: err instanceof Error ? err.message : String(err),
          };
        }

        // Add tool call + result to messages
        messages.push({
          role: "assistant",
          content: `Calling tool: ${toolCall.name}`,
        });
        messages.push({
          role: "tool",
          content: JSON.stringify(result),
          tool_call_id: toolCall.name,
        });

        const preview = result.output.slice(0, 100);
        this.emitProgress(`\ud83d\udd27 ${toolCall.name}: ${preview}`);
      }
    }

    // Max turns reached
    const limitText =
      "\u0414\u043e\u0441\u0442\u0438\u0433\u043d\u0443\u0442 \u043b\u0438\u043c\u0438\u0442 \u0438\u0442\u0435\u0440\u0430\u0446\u0438\u0439 \u043e\u0431\u0440\u0430\u0431\u043e\u0442\u043a\u0438. \u041f\u043e\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u0443\u0442\u043e\u0447\u043d\u0438\u0442\u044c \u0437\u0430\u043f\u0440\u043e\u0441.";
    this.history.push({ role: "assistant", content: limitText });
    return { text: limitText };
  }

  private buildSystemPrompt(): string {
    const cfg = this.deps.config;
    const personality = cfg.personality ?? "";
    const knowledge = cfg.knowledge ?? "";
    return [
      "You are Betsy, an autonomous AI assistant.",
      personality ? `Personality: ${String(personality)}` : "",
      knowledge ? `Knowledge: ${String(knowledge)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
}
