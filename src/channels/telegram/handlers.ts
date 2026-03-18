import type { Bot, Context } from "grammy";
import type { IncomingMessage, OutgoingMessage, ProgressCallback } from "../../core/types.js";
import type { MessageHandler } from "../types.js";
import { sendVoiceResponse } from "./voice.js";
import { sendVideoNote } from "./video.js";
import { sendSelfie } from "./selfies.js";

/** Max Telegram message length. */
const MAX_MSG_LEN = 4096;

// ---------------------------------------------------------------------------
// Markdown → Telegram HTML (like OpenClaw's format.ts approach)
// ---------------------------------------------------------------------------

/** Escape HTML special chars. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert LLM markdown to Telegram HTML.
 * Handles: **bold**, *italic*, `code`, ```code blocks```, [links](url)
 * Uses HTML parse_mode (more reliable than MarkdownV2).
 */
function markdownToTelegramHtml(text: string): string {
  const parts: string[] = [];
  // Split by code blocks and inline code (preserve them separately)
  const segments = text.split(/(```[\s\S]*?```|`[^`]+`)/g);

  for (const segment of segments) {
    if (segment.startsWith("```") && segment.endsWith("```")) {
      const inner = segment.slice(3, -3);
      const newlineIdx = inner.indexOf("\n");
      if (newlineIdx !== -1) {
        const lang = inner.slice(0, newlineIdx).trim();
        const code = inner.slice(newlineIdx + 1);
        parts.push(
          lang
            ? `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>`
            : `<pre>${escapeHtml(code)}</pre>`,
        );
      } else {
        parts.push(`<pre>${escapeHtml(inner)}</pre>`);
      }
    } else if (segment.startsWith("`") && segment.endsWith("`")) {
      parts.push(`<code>${escapeHtml(segment.slice(1, -1))}</code>`);
    } else {
      // Regular text — convert formatting
      let html = escapeHtml(segment);
      // **bold** → <b>bold</b>
      html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
      // *italic* → <i>italic</i> (but not inside bold tags)
      html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
      // ~~strikethrough~~ → <s>strikethrough</s>
      html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");
      parts.push(html);
    }
  }

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Typing indicator with circuit breaker (like OpenClaw)
// ---------------------------------------------------------------------------

/** Consecutive 401 failures before suspending chat actions. */
const MAX_401_FAILURES = 10;
/** Max backoff between typing pings (ms). */
const MAX_BACKOFF_MS = 300_000; // 5 min

let consecutive401 = 0;
let backoffMs = 4000;
let suspended = false;

/** Start sending "typing" action with circuit breaker. Returns stop function. */
function startTyping(ctx: Context): () => void {
  let running = true;

  const tick = async () => {
    while (running) {
      if (suspended) {
        await sleep(backoffMs);
        continue;
      }
      try {
        await ctx.replyWithChatAction("typing");
        // Success — reset backoff
        if (consecutive401 > 0) {
          consecutive401 = 0;
          backoffMs = 4000;
          suspended = false;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("401") || msg.includes("Unauthorized")) {
          consecutive401++;
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
          if (consecutive401 >= MAX_401_FAILURES) {
            suspended = true;
          }
        }
        // Other errors — just skip this tick
      }
      await sleep(backoffMs);
    }
  };

  tick();
  return () => { running = false; };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Message delivery with chunking
// ---------------------------------------------------------------------------

/** Send text as HTML, chunking if needed. Falls back to plain text on parse error. */
async function replyHtml(ctx: Context, text: string): Promise<void> {
  const html = markdownToTelegramHtml(text);
  const chunks = chunkText(html, MAX_MSG_LEN);

  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch {
      // HTML parse failed — send as plain text
      const plainChunks = chunkText(text, MAX_MSG_LEN);
      for (const pc of plainChunks) {
        await ctx.reply(pc);
      }
      return;
    }
  }
}

/** Split text into chunks respecting max length, trying to break at newlines. */
function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to break at last newline within limit
    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt <= 0) {
      // No good newline — break at last space
      breakAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (breakAt <= 0) {
      // No space either — hard break
      breakAt = maxLen;
    }

    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }

  return chunks;
}

/** Deliver an OutgoingMessage through the appropriate Telegram media type. */
async function deliver(ctx: Context, response: OutgoingMessage): Promise<void> {
  const mode = response.mode ?? "text";

  if (mode === "voice") {
    const sent = await sendVoiceResponse(ctx as never, response.text, {});
    if (!sent) await replyHtml(ctx, response.text);
    return;
  }

  if (mode === "video") {
    const sent = await sendVideoNote(ctx as never, response.text, {}, "", "");
    if (!sent) await replyHtml(ctx, response.text);
    return;
  }

  if (mode === "selfie") {
    const sent = await sendSelfie(ctx as never, response.text, "", "");
    if (!sent) await replyHtml(ctx, response.text);
    return;
  }

  await replyHtml(ctx, response.text);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the text body after a slash-command prefix. */
function commandBody(ctx: Context, command: string): string {
  const raw = ctx.message?.text ?? "";
  return raw.replace(new RegExp(`^/${command}\\s*`), "");
}

/** Convert a grammY Context into a channel-neutral IncomingMessage. */
function toIncoming(ctx: Context, text: string): IncomingMessage {
  return {
    channelName: "telegram",
    userId: String(ctx.chat?.id ?? ctx.from?.id ?? "unknown"),
    text,
    timestamp: Date.now(),
    metadata: {
      messageId: ctx.message?.message_id,
      fromUsername: ctx.from?.username,
      firstName: ctx.from?.first_name,
    },
  };
}

/** Human-readable tool names for status messages. */
const TOOL_LABELS: Record<string, string> = {
  shell: "выполняю команду",
  files: "работаю с файлами",
  http: "делаю HTTP-запрос",
  browser: "открываю браузер",
  memory: "ищу в памяти",
  npm_install: "устанавливаю пакет",
  self_config: "меняю настройки",
  scheduler: "настраиваю расписание",
  ssh: "подключаюсь по SSH",
};

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerHandlers(
  bot: Bot,
  handler: MessageHandler,
  ownerChatId: number | null,
): void {
  // --- Owner-only filter ---
  if (ownerChatId) {
    bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id;
      if (chatId && chatId !== ownerChatId) {
        await ctx.reply("This bot is private.");
        return;
      }
      await next();
    });
  }

  /** Handle message with typing indicator and tool progress. */
  async function handleWithTyping(
    ctx: Context,
    text: string,
    modeOverride?: OutgoingMessage["mode"],
  ): Promise<void> {
    const stopTyping = startTyping(ctx);

    // Progress callback — show tool execution status
    let statusMsgId: number | null = null;
    const onProgress: ProgressCallback = async (event) => {
      try {
        if (event.type === "tool_start") {
          const label = TOOL_LABELS[event.tool] ?? event.tool;
          const statusText = `⏳ ${label}...`;
          if (statusMsgId) {
            await ctx.api.editMessageText(ctx.chat!.id, statusMsgId, statusText);
          } else {
            const msg = await ctx.reply(statusText);
            statusMsgId = msg.message_id;
          }
        } else if (event.type === "turn_complete" && event.turn > 1) {
          const statusText = `🔄 Думаю... (шаг ${event.turn})`;
          if (statusMsgId) {
            await ctx.api.editMessageText(ctx.chat!.id, statusMsgId, statusText);
          }
        }
      } catch {
        // Status message edit failed — not critical
      }
    };

    try {
      const response = await handler(toIncoming(ctx, text), onProgress);
      stopTyping();

      // Delete status message before delivering final response
      if (statusMsgId) {
        try {
          await ctx.api.deleteMessage(ctx.chat!.id, statusMsgId);
        } catch { /* ignore */ }
      }

      await deliver(ctx, modeOverride ? { ...response, mode: modeOverride } : response);
    } catch (err) {
      stopTyping();
      if (statusMsgId) {
        try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsgId); } catch { /* */ }
      }
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Ошибка: ${msg}`);
    }
  }

  // /start
  bot.command("start", (ctx) => handleWithTyping(ctx, "/start"));
  // /status
  bot.command("status", (ctx) => handleWithTyping(ctx, "/status"));
  // /help
  bot.command("help", (ctx) => handleWithTyping(ctx, "/help"));

  // /voice <text>
  bot.command("voice", async (ctx) => {
    const body = commandBody(ctx, "voice");
    if (!body) { await ctx.reply("Usage: /voice <text to speak>"); return; }
    await handleWithTyping(ctx, body, "voice");
  });

  // /video <text>
  bot.command("video", async (ctx) => {
    const body = commandBody(ctx, "video");
    if (!body) { await ctx.reply("Usage: /video <text for lip-sync>"); return; }
    await handleWithTyping(ctx, body, "video");
  });

  // /selfie <prompt>
  bot.command("selfie", async (ctx) => {
    const body = commandBody(ctx, "selfie");
    if (!body) { await ctx.reply("Usage: /selfie <description>"); return; }
    await handleWithTyping(ctx, body, "selfie");
  });

  // /study
  bot.command("study", (ctx) => handleWithTyping(ctx, "/study"));

  // Plain text messages
  bot.on("message:text", async (ctx) => {
    const userText = ctx.message.text;
    if (userText.startsWith("/")) return;
    await handleWithTyping(ctx, userText);
  });
}
