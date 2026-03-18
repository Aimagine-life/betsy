# Selfie Generation — Design Spec

## Summary

Add selfie generation as an agentic tool. Betsy generates selfies via fal.ai Grok Imagine Edit API, using a reference photo (avatar) from config. The LLM decides when to send a selfie — either by user request or on its own initiative. Two modes: mirror (full-body, outfit) and direct (close-up, location/emotion).

## Motivation

Selfies make Betsy feel like a real friend — "скинь селфи" is a natural request between friends. Currently selfies use KIE.ai (nano-banana-2) and are tightly coupled to the Telegram channel. The new approach makes selfies a first-class tool in the agentic loop, working across all channels.

## Architecture

### New: SelfieTool (`src/core/tools/selfie.ts`)

Implements the `Tool` interface. Registered in the agentic loop alongside other tools.

```typescript
name: "selfie"
description: "Сгенерировать и отправить селфи. Используй когда просят фото/селфи, или когда уместно показать как выглядишь."
parameters:
  - context (string, required): описание ситуации ("в кафе", "в новом платье")
  - mode (string, optional): "mirror" | "direct", auto-detected if omitted
```

### Mode Auto-Detection

Keyword-based detection from user context. Default: `direct`.

**Mirror** (зеркальное селфи, full-body — одежда, образ, стиль):
```
одежда|платье|костюм|наряд|юбка|куртка|пальто|шуба|худи|футболка|
джинсы|туфли|кроссовки|шапка|очки|аксессуар|образ|стиль|лук|мода|
примерк|надела|ношу|переодел|outfit|wearing|clothes|dress|suit|
fashion|full-body|mirror|hoodie|jacket
```

**Direct** (close-up, прямой взгляд — места, эмоции, ситуации):
```
кафе|ресторан|пляж|парк|город|улица|дом|кровать|работа|офис|
магазин|метро|машина|поезд|самолёт|гор|мор|озер|лес|снег|дождь|
утро|вечер|ночь|закат|рассвет|улыбк|грустн|весел|устал|сонн|
счастлив|селфи|фото|лицо|портрет|
cafe|restaurant|beach|park|city|portrait|smile|morning|sunset
```

### Prompt Templates (English — better for image generation models)

- **mirror:** `"make a pic of this person, but {context}. the person is taking a mirror selfie, full body visible in the mirror"`
- **direct:** `"a close-up selfie taken by herself, {context}, direct eye contact with the camera, looking straight into the lens, phone held at arm's length, face fully visible, natural and casual"`

User context is inserted as-is (Russian or English — Grok handles both).

### API: fal.ai Grok Imagine Edit

Direct `fetch` to `https://fal.run/xai/grok-imagine-image/edit` (same pattern as video.ts):

```typescript
const response = await fetch("https://fal.run/xai/grok-imagine-image/edit", {
  method: "POST",
  headers: {
    Authorization: `Key ${falApiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    image_url: referencePhotoUrl,
    prompt: editPrompt,
    num_images: 1,
    output_format: "jpeg",
  }),
});

// Response: { images: [{ url, content_type, width, height }] }
```

### ToolResult Extension

Add `mediaUrl` to `ToolResult`:

```typescript
export interface ToolResult {
  success: boolean
  output: string
  error?: string
  mediaUrl?: string  // URL of generated image/media
}
```

SelfieTool returns:
```typescript
{
  success: true,
  output: "Селфи сгенерировано",
  mediaUrl: "https://v3b.fal.media/files/..."
}
```

### OutgoingMessage Extension

Add `mediaUrl` to the existing `OutgoingMessage` (only `mediaUrl` is new — the `mode` union already includes `'selfie'`):

```typescript
export interface OutgoingMessage {
  text: string
  mode?: 'text' | 'voice' | 'video' | 'selfie'
  mediaUrl?: string  // ← new
}
```

### Engine Changes (`src/core/engine.ts`)

The private `executeTool` method currently returns `string`. Change it to return `ToolResult` (or a new type `{ text: string; mediaUrl?: string }`), so the agentic loop can access `mediaUrl`.

In the agentic loop, after each `executeTool` call:
- Store `result.text` in history as before (for the LLM)
- If `result.mediaUrl` is present, save it to a `lastMediaUrl` variable

When building the final `OutgoingMessage`, attach `lastMediaUrl` as `mediaUrl`.

### Telegram Delivery (`src/channels/telegram/handlers.ts`)

Remove the existing `mode === "selfie"` branch in `deliver()` and the `import { sendSelfie }` at the top. The `/selfie` command no longer sets `modeOverride: "selfie"` — it just passes the text through the agentic loop like any other message (the LLM will call the selfie tool).

Replace with `mediaUrl`-based delivery in `deliver()`:
- If `response.mediaUrl` is present: download image, send via `ctx.replyWithPhoto(new InputFile(buffer))` with `response.text` as caption
- If absent: existing behavior (text/HTML)

### Browser Delivery

Include `mediaUrl` in the WebSocket message. Frontend renders `<img src={mediaUrl}>` in the chat bubble.

### Config

Config uses flat key-value format (same as existing config). `self_config` tool writes flat keys.

In `config.ts` `normalizeConfig()`, replace the existing `kie_api_key` block with:

```typescript
// selfies (fal.ai)
if (raw.fal_api_key || raw.reference_photo_url) {
  out.selfies = {
    fal_api_key: raw.fal_api_key,
    reference_photo_url: raw.reference_photo_url,
  };
}
```

In `server.ts`, update the API key masking from `safe.selfies?.kie_api_key` to `safe.selfies?.fal_api_key`.

The `fal_api_key` may already be present in config for video/voice — SelfieTool should check `config.selfies?.fal_api_key` first, then fall back to the fal key used by video if available.

If `fal_api_key` is missing, SelfieTool returns:
```typescript
{
  success: false,
  output: "Для генерации селфи нужен API-ключ fal.ai. Попроси пользователя получить ключ на https://fal.ai/dashboard/keys и прислать его тебе. Сохрани через self_config."
}
```

The LLM then asks the user for the key in natural language and saves it via the existing `self_config` tool (writes `fal_api_key: <value>` as a flat key).

### System Prompt Addition

Add to personality instructions so the LLM knows when to use selfies proactively:

> У тебя есть инструмент selfie — используй его когда просят фото или селфи, или когда хочешь показать что ты делаешь. Это как друг отправляет фотку в чат.

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `src/core/tools/selfie.ts` | Create | SelfieTool implementation |
| `src/core/tools/types.ts` | Modify | Add `mediaUrl` to ToolResult |
| `src/core/types.ts` | Modify | Add `mediaUrl` to OutgoingMessage |
| `src/core/engine.ts` | Modify | Track and propagate mediaUrl |
| `src/index.ts` | Modify | Register SelfieTool (tool registration lives here) |
| `src/core/config.ts` | Modify | Normalize selfies config for fal.ai (replace kie_api_key block) |
| `src/core/prompt.ts` | Modify | Add selfie hint to system prompt |
| `src/channels/telegram/handlers.ts` | Modify | Remove old selfie branch + import, add mediaUrl delivery |
| `src/channels/telegram/selfies.ts` | Delete | Remove old KIE.ai implementation |
| `src/server.ts` | Modify | Update API key masking (kie_api_key → fal_api_key) |
| `betsy.config.yaml.example` | Modify | Update selfies config example |

## What We Don't Do

- No `@fal-ai/client` dependency — direct `fetch`
- No image storage or gallery — URL passed through and sent
- No KIE.ai fallback — full replacement
- No changes to voice/video
- No selfie history or caching
