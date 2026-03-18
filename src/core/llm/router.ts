import type { LLMClient, LLMMessage, LLMResponse, ToolDefinition, StreamCallback } from "./types.js";
import { createOpenRouterClient } from "./providers/openrouter.js";
import { isBillingError, isRateLimitError, checkBalance } from "./providers/openrouter.js";

const DEFAULT_FALLBACKS = [
  "google/gemini-2.5-flash:free",
  "deepseek/deepseek-v3.2-20251201:free",
];

const BALANCE_CHECK_INTERVAL = 10 * 60 * 1000; // 10 minutes
const FALLBACK_RETRY_DELAY = 1000; // 1 second between fallback attempts (fixed, not exponential)

export interface LLMRouterConfig {
  provider: string;
  api_key: string;
  fast_model: string;
  strong_model: string;
  fallback_models?: string[];
}

export class LLMRouter {
  private readonly config: LLMRouterConfig;
  private readonly fallbackModels: string[];

  // Proxies returned to consumers — created once, delegate internally
  private fastProxy: LLMClient | undefined;
  private strongProxy: LLMClient | undefined;

  // Fallback state
  private _mode: "normal" | "degraded" = "normal";
  private currentFallbackIndex = 0;
  private pendingNotification: string | null = null;
  private balanceCheckTimer: ReturnType<typeof setInterval> | null = null;

  // Current active delegates — swapped on fallback
  private fastDelegate!: LLMClient;
  private strongDelegate!: LLMClient;

  constructor(config: LLMRouterConfig) {
    this.config = config;
    this.fallbackModels = config.fallback_models?.length
      ? config.fallback_models
      : DEFAULT_FALLBACKS;

    // Eagerly init delegates so they are always defined
    this.fastDelegate = this.createClient(config.fast_model);
    this.strongDelegate = this.createClient(config.strong_model);
  }

  get mode(): "normal" | "degraded" {
    return this._mode;
  }

  fast(): LLMClient {
    if (!this.fastProxy) {
      this.fastProxy = this.createProxy(() => this.fastDelegate);
    }
    return this.fastProxy;
  }

  strong(): LLMClient {
    if (!this.strongProxy) {
      this.strongProxy = this.createProxy(() => this.strongDelegate);
    }
    return this.strongProxy;
  }

  destroy(): void {
    this.stopBalanceCheck();
  }

  private createClient(model: string): LLMClient {
    switch (this.config.provider) {
      case "openrouter":
        return createOpenRouterClient({ apiKey: this.config.api_key, model });
      default:
        throw new Error(`Unknown LLM provider: ${this.config.provider}`);
    }
  }

  private createProxy(getDelegate: () => LLMClient): LLMClient {
    return {
      chat: async (messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> => {
        const maxAttempts = this.fallbackModels.length + 1; // main + all fallbacks
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          try {
            const response = await getDelegate().chat(messages, tools);
            return this.attachNotification(response);
          } catch (err) {
            if (isBillingError(err) || isRateLimitError(err)) {
              const switched = await this.handleLLMError(err);
              if (switched) {
                continue; // retry with new delegate
              }
            }
            throw err;
          }
        }
        // Should not reach here, but just in case
        throw new Error("All LLM fallback attempts exhausted");
      },

      chatStream: async (messages: LLMMessage[], onChunk: StreamCallback, tools?: ToolDefinition[]): Promise<LLMResponse> => {
        try {
          const response = await getDelegate().chatStream(messages, onChunk, tools);
          return this.attachNotification(response);
        } catch (err) {
          if (isBillingError(err) || isRateLimitError(err)) {
            // Switch model for next call, but do NOT retry mid-stream
            // (chunks may have already been sent to user via onChunk)
            await this.handleLLMError(err);
          }
          throw err;
        }
      },
    };
  }

  /**
   * Handle a billing or rate limit error by switching models.
   * Returns true if successfully switched and caller should retry.
   */
  private async handleLLMError(err: unknown): Promise<boolean> {
    if (this._mode === "normal") {
      return this.enterDegradedMode();
    }

    // Already degraded — try next fallback
    return this.tryNextFallback();
  }

  private enterDegradedMode(): boolean {
    this.currentFallbackIndex = 0;
    const model = this.fallbackModels[0];
    if (!model) return false;

    console.log(`⚠️ LLM: переключение на fallback модель: ${model}`);
    this._mode = "degraded";
    this.switchDelegates(model);
    this.pendingNotification =
      "⚠️ Баланс OpenRouter исчерпан, работаю на бесплатной модели. Когда баланс будет пополнен, автоматически вернусь на основную модель.";
    this.startBalanceCheck();
    return true;
  }

  private async tryNextFallback(): Promise<boolean> {
    this.currentFallbackIndex++;
    if (this.currentFallbackIndex >= this.fallbackModels.length) {
      // All exhausted — reset to first for next attempt
      this.currentFallbackIndex = 0;
      this.switchDelegates(this.fallbackModels[0]);
      console.log("⚠️ LLM: все fallback модели исчерпаны");
      return false;
    }

    const model = this.fallbackModels[this.currentFallbackIndex];
    console.log(`⚠️ LLM: переключение на следующую fallback модель: ${model}`);
    this.switchDelegates(model);
    await new Promise((r) => setTimeout(r, FALLBACK_RETRY_DELAY));
    return true;
  }

  private switchDelegates(model: string): void {
    const client = this.createClient(model);
    this.fastDelegate = client;
    this.strongDelegate = client;
  }

  private restoreMainModels(): void {
    console.log("✅ LLM: баланс восстановлен, возвращаюсь на основные модели");
    this._mode = "normal";
    this.fastDelegate = this.createClient(this.config.fast_model);
    this.strongDelegate = this.createClient(this.config.strong_model);
    this.pendingNotification = "✅ Баланс восстановлен, снова работаю на основной модели.";
    this.stopBalanceCheck();
  }

  private startBalanceCheck(): void {
    if (this.balanceCheckTimer) return;
    this.balanceCheckTimer = setInterval(async () => {
      try {
        const balance = await checkBalance(this.config.api_key);
        if (balance.hasBalance) {
          this.restoreMainModels();
        }
      } catch (err) {
        console.error("LLM: ошибка проверки баланса:", err instanceof Error ? err.message : err);
      }
    }, BALANCE_CHECK_INTERVAL);
    if (this.balanceCheckTimer && typeof this.balanceCheckTimer === "object" && "unref" in this.balanceCheckTimer) {
      (this.balanceCheckTimer as NodeJS.Timeout).unref();
    }
  }

  private stopBalanceCheck(): void {
    if (this.balanceCheckTimer) {
      clearInterval(this.balanceCheckTimer);
      this.balanceCheckTimer = null;
    }
  }

  private attachNotification(response: LLMResponse): LLMResponse {
    if (this.pendingNotification && response.text) {
      const text = this.pendingNotification + "\n\n" + response.text;
      this.pendingNotification = null;
      return { ...response, text };
    }
    return response;
  }
}
