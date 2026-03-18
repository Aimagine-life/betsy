import OpenAI from "openai";
import type { LLMClient, LLMMessage, LLMResponse, ToolDefinition } from "../types.js";

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
}

export function createOpenRouterClient(opts: OpenRouterOptions): LLMClient {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/Aimagine-life/betsy",
      "X-Title": "Betsy",
    },
  });

  return {
    async chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
      // Convert our messages to OpenAI format
      const openaiMessages: OpenAI.ChatCompletionMessageParam[] = messages.map((m) => {
        if (m.role === "tool") {
          return {
            role: "tool" as const,
            tool_call_id: m.toolCallId!,
            content: m.content,
          };
        }

        if (m.role === "assistant" && m.toolCalls?.length) {
          return {
            role: "assistant" as const,
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          };
        }

        return {
          role: m.role as "system" | "user" | "assistant",
          content: m.content,
        };
      });

      const res = await client.chat.completions.create({
        model: opts.model,
        messages: openaiMessages,
        ...(tools?.length ? { tools } : {}),
      });

      const choice = res.choices[0];
      const message = choice?.message;

      // Parse tool calls from response
      const toolCalls = message?.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>,
      }));

      // Map finish_reason to our stopReason
      const stopReason =
        choice?.finish_reason === "tool_calls" ? "tool_use"
        : choice?.finish_reason === "stop" ? "end_turn"
        : "end_turn";

      return {
        text: message?.content ?? "",
        toolCalls,
        stopReason: toolCalls?.length ? "tool_use" : stopReason,
        usage: res.usage
          ? {
              promptTokens: res.usage.prompt_tokens,
              completionTokens: res.usage.completion_tokens,
            }
          : undefined,
      };
    },
  };
}
