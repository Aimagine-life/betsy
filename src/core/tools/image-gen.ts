import type { Tool, ToolResult } from "./types.js";

const MODEL = "google/gemini-2.0-flash-exp:free";

export interface ImageGenToolConfig {
  apiKey: string;
}

export class ImageGenTool implements Tool {
  name = "image_gen";
  description =
    "Generate an image from a text prompt using AI. Returns the generated image. Use for any image generation requests.";
  parameters = [
    { name: "prompt", type: "string", description: "Detailed description of the image to generate (in English)", required: true },
  ];

  private apiKey: string;

  constructor(config: ImageGenToolConfig) {
    this.apiKey = config.apiKey;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const prompt = String(params.prompt ?? "").trim();
    if (!prompt) {
      return { success: false, output: "Missing required parameter: prompt" };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: prompt }],
          modalities: ["image", "text"],
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errText = await response.text();
        console.error(`image_gen error ${response.status}: ${errText.slice(0, 300)}`);
        return { success: false, output: `OpenRouter error: ${response.status}`, error: errText.slice(0, 300) };
      }

      const data = await response.json() as {
        choices?: Array<{
          message?: {
            content?: string | null;
            images?: Array<{ image_url?: { url?: string } }>;
          };
        }>;
      };

      const message = data.choices?.[0]?.message;

      // Try images array first (OpenRouter native format)
      const imageUrl = message?.images?.[0]?.image_url?.url;
      if (imageUrl) {
        console.log(`image_gen OK: data URL ${imageUrl.slice(0, 50)}...`);
        return {
          success: true,
          output: "Image generated successfully",
          mediaUrl: imageUrl,
        };
      }

      // Try extracting base64 from content (inline format)
      const content = message?.content ?? "";
      const b64Match = content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
      if (b64Match) {
        console.log(`image_gen OK: extracted from content`);
        return {
          success: true,
          output: "Image generated successfully",
          mediaUrl: b64Match[0],
        };
      }

      // Try extracting from multipart content
      const jsonStr = JSON.stringify(data);
      const b64MatchJson = jsonStr.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
      if (b64MatchJson) {
        console.log(`image_gen OK: extracted from response JSON`);
        return {
          success: true,
          output: "Image generated successfully",
          mediaUrl: b64MatchJson[0],
        };
      }

      console.error("image_gen: no image in response", JSON.stringify(data).slice(0, 500));
      return { success: false, output: "Model did not return an image. Try a different prompt." };
    } catch (err) {
      console.error(`image_gen exception: ${err instanceof Error ? err.message : err}`);
      return {
        success: false,
        output: "Error generating image",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
