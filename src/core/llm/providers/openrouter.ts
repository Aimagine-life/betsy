import OpenAI from "openai";
import type { LLMClient, LLMMessage, LLMResponse, ToolDefinition, StreamCallback } from "../types.js";

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
}

/** Convert our LLMMessage[] to OpenAI format. */
function toOpenAIMessages(messages: LLMMessage[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((m) => {
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

    // Multimodal content (text + images) — pass array as-is
    return {
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    } as OpenAI.ChatCompletionMessageParam;
  });
}

/** Parse finish_reason + tool_calls into our LLMResponse. */
function buildResponse(
  content: string,
  finishReason: string | null,
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  usage?: { prompt_tokens: number; completion_tokens: number },
): LLMResponse {
  const stopReason =
    finishReason === "tool_calls" ? "tool_use"
    : finishReason === "stop" ? "end_turn"
    : "end_turn";

  return {
    text: content,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
    stopReason: toolCalls?.length ? "tool_use" : stopReason,
    usage: usage
      ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
      : undefined,
  };
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
      const res = await client.chat.completions.create({
        model: opts.model,
        messages: toOpenAIMessages(messages),
        ...(tools?.length ? { tools } : {}),
      });

      const choice = res.choices[0];
      const message = choice?.message;

      const toolCalls = message?.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>,
      }));

      return buildResponse(
        message?.content ?? "",
        choice?.finish_reason ?? null,
        toolCalls,
        res.usage ? { prompt_tokens: res.usage.prompt_tokens, completion_tokens: res.usage.completion_tokens } : undefined,
      );
    },

    async chatStream(messages: LLMMessage[], onChunk: StreamCallback, tools?: ToolDefinition[]): Promise<LLMResponse> {
      const stream = await client.chat.completions.create({
        model: opts.model,
        messages: toOpenAIMessages(messages),
        ...(tools?.length ? { tools } : {}),
        stream: true,
      });

      let text = "";
      let finishReason: string | null = null;
      // Accumulate tool calls from stream deltas
      const toolCallMap = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // Text content
        if (delta.content) {
          text += delta.content;
          onChunk(delta.content);
        }

        // Tool calls (streamed as deltas with index)
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallMap.has(idx)) {
              toolCallMap.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
            }
            const entry = toolCallMap.get(idx)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }
      }

      const toolCalls = toolCallMap.size > 0
        ? [...toolCallMap.values()].map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: JSON.parse(tc.args || "{}") as Record<string, unknown>,
          }))
        : undefined;

      return buildResponse(text, finishReason, toolCalls);
    },
  };
}
