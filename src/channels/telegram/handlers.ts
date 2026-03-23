import type { Bot, Context } from "grammy";
import type { IncomingMessage, OutgoingMessage, ProgressCallback } from "../../core/types.js";
import type { MessageHandler } from "../types.js";
import { sendVoiceResponse } from "./voice.js";
import { sendVideoNote } from "./video.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
      // Extract markdown links before escaping HTML (urls contain & etc.)
      const linkPlaceholders: string[] = [];
      let withPlaceholders = segment.replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        (_match, label, url) => {
          const idx = linkPlaceholders.length;
          linkPlaceholders.push(
            `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`,
          );
          return `\x00LINK${idx}\x00`;
        },
      );
      let html = escapeHtml(withPlaceholders);
      // Restore link placeholders
      html = html.replace(/\x00LINK(\d+)\x00/g, (_m, i) => linkPlaceholders[Number(i)]);
      // ### heading → <b>heading</b> (strip markdown headers)
      html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
      // **bold** → <b>bold</b>
      html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
      // *italic* → <i>italic</i> (but not inside bold tags)
      html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
      // ~~strikethrough~~ → <s>strikethrough</s>
      html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");
      // > blockquote → <blockquote>
      html = html.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");
      // Merge adjacent blockquotes into one
      html = html.replace(/<\/blockquote>\n<blockquote>/g, "\n");
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

  // If response has a media URL (e.g. from selfie/image_gen tool), send as photo
  if (response.mediaUrl) {
    try {
      let buffer: Buffer;
      if (response.mediaUrl.startsWith("data:")) {
        const base64 = response.mediaUrl.replace(/^data:image\/[^;]+;base64,/, "");
        buffer = Buffer.from(base64, "base64");
      } else {
        const imgRes = await fetch(response.mediaUrl);
        buffer = Buffer.from(await imgRes.arrayBuffer());
      }
      const { InputFile } = await import("grammy");
      const caption = response.text ? markdownToTelegramHtml(response.text) : undefined;
      await ctx.replyWithPhoto(new InputFile(buffer, "selfie.jpg"), {
        caption,
        parse_mode: caption ? "HTML" : undefined,
      });
      return;
    } catch {
      // Fall through to text delivery
    }
  }

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

/** Download a Telegram photo (largest size) as base64. */
async function downloadPhotoBase64(ctx: Context, photo: { file_id: string }[], botToken: string): Promise<string | null> {
  try {
    const fileId = photo[photo.length - 1].file_id;
    const file = await ctx.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const res = await fetch(fileUrl);
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.toString("base64");
  } catch {
    return null;
  }
}

/** Convert a grammY Context into a channel-neutral IncomingMessage. */
async function toIncoming(ctx: Context, text: string, botToken: string): Promise<IncomingMessage> {
  const reply = ctx.message?.reply_to_message;
  const replyToText = reply?.text ?? reply?.caption;

  // Collect images: from the message itself and from the replied-to message
  const images: string[] = [];
  const msgPhoto = ctx.message?.photo;
  if (msgPhoto?.length) {
    const b64 = await downloadPhotoBase64(ctx, msgPhoto, botToken);
    if (b64) images.push(b64);
  }
  const replyPhoto = reply?.photo;
  if (replyPhoto?.length) {
    const b64 = await downloadPhotoBase64(ctx, replyPhoto, botToken);
    if (b64) images.push(b64);
  }

  return {
    channelName: "telegram",
    userId: String(ctx.chat?.id ?? ctx.from?.id ?? "unknown"),
    text,
    timestamp: Date.now(),
    metadata: {
      messageId: ctx.message?.message_id,
      fromUsername: ctx.from?.username,
      firstName: ctx.from?.first_name,
      ...(replyToText && { replyToText }),
    },
    ...(images.length && { images }),
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

/** Callback to update selfie reference photo URL. */
export type SetReferencePhotoFn = (url: string) => void;

/** Callback when first user claims ownership. */
export type OnOwnerClaimedFn = (chatId: number) => void;

export function registerHandlers(
  bot: Bot,
  handler: MessageHandler,
  ownerChatId: number | null,
  onSetReferencePhoto?: SetReferencePhotoFn,
  onOwnerClaimed?: OnOwnerClaimedFn,
): void {
  // --- Owner-only filter ---
  // Mutable so the first user can claim ownership at runtime.
  let currentOwner = ownerChatId;

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return next();

    // First user claims ownership when no owner is configured.
    if (currentOwner === null) {
      currentOwner = chatId;
      onOwnerClaimed?.(chatId);
      console.log(`🔒 Владелец бота установлен: ${chatId}`);
    }

    if (chatId !== currentOwner) {
      await ctx.reply("Этот бот приватный.");
      return;
    }
    await next();
  });

  // -----------------------------------------------------------------------
  // Native Telegram sendMessageDraft streaming (Bot API Dec 2025)
  // -----------------------------------------------------------------------

  /** Unique draft ID counter — each streaming response gets its own. */
  let nextDraftId = 0;

  /** Call the native sendMessageDraft Bot API method. */
  async function sendDraft(apiObj: Bot["api"], chatId: number, draftId: number, text: string): Promise<void> {
    const raw = apiObj as Bot["api"] & {
      sendMessageDraft?: (chatId: number, draftId: number, text: string, params?: { parse_mode?: string }) => Promise<unknown>;
    };
    if (typeof raw.sendMessageDraft === "function") {
      await raw.sendMessageDraft(chatId, draftId, text);
      return;
    }
    // Fallback: call raw API via grammy's raw method
    await (apiObj as unknown as { raw: { sendMessageDraft: (body: Record<string, unknown>) => Promise<unknown> } })
      .raw.sendMessageDraft({ chat_id: chatId, draft_id: draftId, text });
  }

  /** Handle message with native draft streaming and tool progress. */
  async function handleWithTyping(
    ctx: Context,
    text: string,
    modeOverride?: OutgoingMessage["mode"],
  ): Promise<void> {
    const stopTyping = startTyping(ctx);
    const chatId = ctx.chat!.id;

    // Streaming state
    let streamText = "";
    let draftId = 0;
    let lastDraftTime = 0;
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    let draftSupported = true;
    let statusMsgId: number | null = null;

    /** Flush current accumulated text to draft. */
    const flushDraft = async () => {
      if (!streamText || !draftId || !draftSupported) return;
      try {
        await sendDraft(ctx.api, chatId, draftId, streamText + " ▌");
        lastDraftTime = Date.now();
      } catch {
        // sendMessageDraft not supported — stop trying
        draftSupported = false;
      }
    };

    const onProgress: ProgressCallback = (event) => {
      if (event.type === "text_chunk") {
        streamText += event.chunk;

        // Allocate draft ID on first chunk
        if (!draftId) {
          nextDraftId = nextDraftId >= 2_147_483_647 ? 1 : nextDraftId + 1;
          draftId = nextDraftId;

          // Delete status message if exists
          if (statusMsgId) {
            ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
            statusMsgId = null;
          }
        }

        // Throttle drafts to ~every 500ms
        if (Date.now() - lastDraftTime > 500) {
          flushDraft();
        } else if (!draftTimer) {
          draftTimer = setTimeout(() => {
            draftTimer = null;
            flushDraft();
          }, 500);
        }
        return;
      }

      if (event.type === "tool_start") {
        const label = TOOL_LABELS[event.tool];
        if (!label) return; // skip status for unlisted tools (e.g. selfie)
        const statusText = `⏳ ${label}...`;
        if (statusMsgId) {
          ctx.api.editMessageText(chatId, statusMsgId, statusText).catch(() => {});
        } else {
          ctx.reply(statusText).then((msg) => { statusMsgId = msg.message_id; }).catch(() => {});
        }
        return;
      }

      if (event.type === "turn_complete" && event.turn > 1 && statusMsgId) {
        ctx.api.editMessageText(chatId, statusMsgId, `🔄 Думаю... (шаг ${event.turn})`).catch(() => {});
      }
    };

    try {
      const response = await handler(await toIncoming(ctx, text, bot.token), onProgress);
      stopTyping();
      if (draftTimer) clearTimeout(draftTimer);

      // Clean up status message
      if (statusMsgId) {
        ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
      }

      // Clear the draft — but skip if response has media (photo will carry the text)
      if (draftId && draftSupported && !response.mediaUrl) {
        try {
          await sendDraft(ctx.api, chatId, draftId, response.text);
          await sleep(300);
        } catch { /* ignore */ }
      }

      // Send the final message
      await deliver(ctx, modeOverride ? { ...response, mode: modeOverride } : response);
    } catch (err) {
      stopTyping();
      if (draftTimer) clearTimeout(draftTimer);
      if (statusMsgId) {
        ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
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
    await handleWithTyping(ctx, `Сделай селфи: ${body}`);
  });

  // /setphoto — set reference photo for selfie generation (saved locally)
  bot.command("setphoto", async (ctx) => {
    const photo = ctx.message?.reply_to_message?.photo ?? ctx.message?.photo;
    if (!photo?.length) {
      await ctx.reply("Отправь фото или ответь на фото командой /setphoto");
      return;
    }
    try {
      const fileId = photo[photo.length - 1].file_id;
      const file = await ctx.api.getFile(fileId);
      const token = bot.token;
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      // Download and save locally
      const res = await fetch(fileUrl);
      const buffer = Buffer.from(await res.arrayBuffer());
      const savePath = path.join(os.homedir(), ".betsy", "reference.jpg");
      fs.writeFileSync(savePath, buffer);
      onSetReferencePhoto?.(savePath);
      await ctx.reply("✅ Фото сохранено как референс для селфи");
    } catch {
      await ctx.reply("Не удалось обработать фото");
    }
  });

  // /study
  bot.command("study", (ctx) => handleWithTyping(ctx, "/study"));
  // /settings
  bot.command("settings", (ctx) => handleWithTyping(ctx, "/settings"));

  // Photos: /setphoto saves reference, everything else is sent to the LLM
  bot.on("message:photo", async (ctx) => {
    const caption = ctx.message.caption?.trim();

    // /setphoto — save reference photo
    if (caption === "/setphoto") {
      const photo = ctx.message.photo;
      try {
        const fileId = photo[photo.length - 1].file_id;
        const file = await ctx.api.getFile(fileId);
        const token = bot.token;
        const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        const res = await fetch(fileUrl);
        const buffer = Buffer.from(await res.arrayBuffer());
        const savePath = path.join(os.homedir(), ".betsy", "reference.jpg");
        fs.writeFileSync(savePath, buffer);
        onSetReferencePhoto?.(savePath);
        await ctx.reply("✅ Фото сохранено как референс для селфи");
      } catch {
        await ctx.reply("Не удалось обработать фото");
      }
      return;
    }

    // Regular photo — send to LLM with caption as text
    await handleWithTyping(ctx, caption || "Что на этом фото?");
  });

  // Plain text messages (including unregistered /commands — let LLM handle them)
  bot.on("message:text", async (ctx) => {
    const userText = ctx.message.text;
    await handleWithTyping(ctx, userText);
  });
}
