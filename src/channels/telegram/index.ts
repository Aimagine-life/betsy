import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import type { Channel, MessageHandler } from "../types.js";
import type { OutgoingMessage } from "../../core/types.js";
import { registerHandlers, type SetReferencePhotoFn, type OnOwnerClaimedFn } from "./handlers.js";

/**
 * Telegram channel adapter.
 *
 * Wraps a grammY Bot and exposes the unified Channel interface
 * so the core agent can drive it without knowing Telegram specifics.
 */
export class TelegramChannel implements Channel {
  name = "telegram";
  requiredConfig = ["token"];

  private bot: Bot | null = null;
  private handler: MessageHandler | null = null;
  private ownerChatId: number | null = null;
  private _avatarUrl: string | null = null;
  private _onSetReferencePhoto: SetReferencePhotoFn | undefined;
  private _onOwnerClaimed: OnOwnerClaimedFn | undefined;

  /** Bot avatar URL fetched at startup. */
  get avatarUrl(): string | null { return this._avatarUrl; }

  /** Set callback for /setphoto command. */
  set onSetReferencePhoto(fn: SetReferencePhotoFn) { this._onSetReferencePhoto = fn; }

  /** Set callback for first-user ownership claim. */
  set onOwnerClaimed(fn: OnOwnerClaimedFn) { this._onOwnerClaimed = fn; }

  async start(config: Record<string, string>): Promise<void> {
    this.bot = new Bot(config.token);
    this.bot.api.config.use(autoRetry());
    this.ownerChatId = config.owner_chat_id ? parseInt(config.owner_chat_id, 10) : null;

    if (!this.handler) {
      throw new Error("TelegramChannel: call onMessage() before start()");
    }

    // Fetch bot avatar for selfie reference
    try {
      const me = await this.bot.api.getMe();
      const photos = await this.bot.api.getUserProfilePhotos(me.id, { limit: 1 });
      if (photos.total_count > 0) {
        const fileId = photos.photos[0][photos.photos[0].length - 1].file_id;
        const file = await this.bot.api.getFile(fileId);
        this._avatarUrl = `https://api.telegram.org/file/bot${config.token}/${file.file_path}`;
      }
    } catch {
      // Non-critical — selfie will use config fallback
    }

    registerHandlers(this.bot, this.handler, this.ownerChatId, this._onSetReferencePhoto, this._onOwnerClaimed);
    this.bot.start();
  }

  async stop(): Promise<void> {
    await this.bot?.stop();
  }

  async send(userId: string, message: OutgoingMessage): Promise<void> {
    await this.bot?.api.sendMessage(parseInt(userId, 10), message.text);
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }
}
