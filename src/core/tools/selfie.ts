import type { Tool, ToolResult } from "./types.js";

const FAL_ENDPOINT = "https://fal.run/xai/grok-imagine-image/edit";

const MIRROR_KEYWORDS =
  /одежд|плать|костюм|наряд|юбк|куртк|пальто|шуб|худи|футболк|джинс|туфл|кроссовк|шапк|очк|аксессуар|образ|стиль|лук|мод[аы]|примерк|надел|ношу|переодел|outfit|wearing|clothes|dress|suit|fashion|full.body|mirror|hoodie|jacket/i;

const DIRECT_KEYWORDS =
  /кафе|ресторан|пляж|парк|город|улиц|дом[аеу]?\b|кроват|работ[аеу]|офис|магазин|метро|машин|поезд|самолёт|гор[аыу]|мор[еяю]|озер|лес[аеу]?\b|снег|дожд|утр[оа]|вечер|ноч[ьи]|закат|рассвет|улыбк|грустн|весел|устал|сонн|счастлив|селфи|фото|лиц[оа]|портрет|cafe|restaurant|beach|park|city|portrait|smile|morning|sunset/i;

function detectMode(context: string): "mirror" | "direct" {
  if (MIRROR_KEYWORDS.test(context)) return "mirror";
  if (DIRECT_KEYWORDS.test(context)) return "direct";
  return "direct";
}

function buildPrompt(context: string, mode: "mirror" | "direct"): string {
  if (mode === "mirror") {
    return `make a pic of this person, but ${context}. the person is taking a mirror selfie, full body visible in the mirror`;
  }
  return `a close-up selfie taken by herself, ${context}, direct eye contact with the camera, looking straight into the lens, phone held at arm's length, face fully visible, natural and casual`;
}

export interface SelfieToolConfig {
  falApiKey: string;
  referencePhotoUrl?: string;
}

export class SelfieTool implements Tool {
  name = "selfie";
  description =
    "Сгенерировать и отправить селфи. Используй когда просят фото/селфи, или когда уместно показать как выглядишь.";
  parameters = [
    { name: "context", type: "string", description: "Описание ситуации (в кафе, в новом платье, на пляже)", required: true },
    { name: "mode", type: "string", description: "Режим: mirror (зеркальное, full-body) или direct (close-up). Если не указан — определяется автоматически.", required: false },
  ];

  readonly config: SelfieToolConfig;

  constructor(config: SelfieToolConfig) {
    this.config = config;
  }

  /** Set reference photo URL (e.g. from bot avatar at startup). */
  setReferencePhoto(url: string): void {
    this.config.referencePhotoUrl = url;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const context = String(params.context ?? "");
    if (!context) {
      return { success: false, output: "Не указан контекст для селфи", error: "Missing context" };
    }

    if (!this.config.falApiKey) {
      return {
        success: false,
        output: "Для генерации селфи нужен API-ключ fal.ai. Попроси пользователя получить ключ на https://fal.ai/dashboard/keys и прислать его тебе. Сохрани через self_config с ключом fal_api_key.",
      };
    }

    if (!this.config.referencePhotoUrl) {
      return {
        success: false,
        output: "Не задано референсное фото (reference_photo_url). Попроси пользователя задать URL аватара через self_config.",
      };
    }

    const mode = (params.mode === "mirror" || params.mode === "direct")
      ? params.mode
      : detectMode(context);

    const prompt = buildPrompt(context, mode);
    console.log(`📸 Selfie: mode=${mode}, ref=${this.config.referencePhotoUrl?.slice(0, 80)}, prompt=${prompt.slice(0, 80)}`);

    try {
      const response = await fetch(FAL_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Key ${this.config.falApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image_url: this.config.referencePhotoUrl,
          prompt,
          num_images: 1,
          output_format: "jpeg",
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        return {
          success: false,
          output: `Ошибка fal.ai: ${response.status}`,
          error: errText.slice(0, 300),
        };
      }

      const data = (await response.json()) as {
        images?: Array<{ url: string }>;
      };

      const imageUrl = data.images?.[0]?.url;
      if (!imageUrl) {
        return { success: false, output: "fal.ai не вернул изображение", error: "No image in response" };
      }

      return {
        success: true,
        output: "Селфи сгенерировано",
        mediaUrl: imageUrl,
      };
    } catch (err) {
      return {
        success: false,
        output: "Ошибка при генерации селфи",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
