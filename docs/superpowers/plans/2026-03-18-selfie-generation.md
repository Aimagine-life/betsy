# Selfie Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add selfie generation as an agentic tool using fal.ai Grok Imagine Edit API, replacing the old KIE.ai implementation.

**Architecture:** SelfieTool is a standard Tool registered in the agentic loop. It calls fal.ai to edit a reference photo based on user context, returns a `mediaUrl` in an extended `ToolResult`. The engine propagates `mediaUrl` to `OutgoingMessage`, and each channel (Telegram, browser) delivers the photo natively.

**Tech Stack:** TypeScript, fal.ai REST API (Grok Imagine Edit), vitest

**Spec:** `docs/superpowers/specs/2026-03-18-selfie-generation-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/core/tools/types.ts` | Modify | Add `mediaUrl` to `ToolResult` |
| `src/core/types.ts` | Modify | Add `mediaUrl` to `OutgoingMessage` |
| `src/core/tools/selfie.ts` | Create | SelfieTool: fal.ai API call, mode detection, prompt templates |
| `src/core/engine.ts` | Modify | Change `executeTool` to return `ToolResult`, propagate `mediaUrl` |
| `src/index.ts` | Modify | Register SelfieTool |
| `src/core/config.ts` | Modify | Normalize `fal_api_key` instead of `kie_api_key` |
| `src/core/prompt.ts` | Modify | Add selfie tool hint to system prompt |
| `src/channels/telegram/handlers.ts` | Modify | Remove old selfie branch, add `mediaUrl` photo delivery |
| `src/channels/telegram/selfies.ts` | Delete | Remove old KIE.ai implementation |
| `src/server.ts` | Modify | Update API key masking |
| `betsy.config.yaml.example` | Modify | Update selfies config example |
| `test/core/tools/selfie.test.ts` | Create | SelfieTool unit tests |
| `test/core/engine-media.test.ts` | Create | Engine mediaUrl propagation test |
| `src/ui/pages/BrowserChat.tsx` | Modify | Render mediaUrl as image in chat |
| `src/ui/lib/api.ts` | Modify | Add mediaUrl to ChatMessage type |

---

### Task 1: Extend ToolResult with mediaUrl

**Files:**
- Modify: `src/core/tools/types.ts:8-12`

- [ ] **Step 1: Add `mediaUrl` to `ToolResult`**

In `src/core/tools/types.ts`, add the optional field:

```typescript
export interface ToolResult {
  success: boolean
  output: string
  error?: string
  mediaUrl?: string
}
```

- [ ] **Step 2: Add `mediaUrl` to `OutgoingMessage`**

In `src/core/types.ts`, add the optional field:

```typescript
export interface OutgoingMessage {
  text: string
  mode?: 'text' | 'voice' | 'video' | 'selfie'
  mediaUrl?: string
}
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (new optional fields don't break anything)

- [ ] **Step 4: Commit**

```bash
git add src/core/tools/types.ts src/core/types.ts
git commit -m "feat: add mediaUrl to ToolResult and OutgoingMessage"
```

---

### Task 2: Create SelfieTool

**Files:**
- Create: `src/core/tools/selfie.ts`
- Create: `test/core/tools/selfie.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/core/tools/selfie.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { SelfieTool } from "../../../src/core/tools/selfie.js";

describe("SelfieTool", () => {
  it("has correct name and parameters", () => {
    const tool = new SelfieTool({ falApiKey: "test", referencePhotoUrl: "https://example.com/photo.jpg" });
    expect(tool.name).toBe("selfie");
    expect(tool.parameters).toHaveLength(2);
    expect(tool.parameters[0].name).toBe("context");
    expect(tool.parameters[0].required).toBe(true);
    expect(tool.parameters[1].name).toBe("mode");
    expect(tool.parameters[1].required).toBe(false);
  });

  it("returns error when fal_api_key is missing", async () => {
    const tool = new SelfieTool({ falApiKey: "", referencePhotoUrl: "https://example.com/photo.jpg" });
    const result = await tool.execute({ context: "в кафе" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("fal.ai");
  });

  it("returns error when reference photo is missing", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "" });
    const result = await tool.execute({ context: "в кафе" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("reference");
  });

  it("detects mirror mode from keywords", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "https://example.com/photo.jpg" });

    // Mock global fetch
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        images: [{ url: "https://fal.media/result.jpg" }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await tool.execute({ context: "в новом платье" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.prompt).toContain("mirror selfie");

    vi.unstubAllGlobals();
  });

  it("detects direct mode from keywords", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "https://example.com/photo.jpg" });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        images: [{ url: "https://fal.media/result.jpg" }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await tool.execute({ context: "в кафе с кофе" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.prompt).toContain("close-up selfie");

    vi.unstubAllGlobals();
  });

  it("returns mediaUrl on success", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "https://example.com/photo.jpg" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        images: [{ url: "https://fal.media/result.jpg" }],
      }),
    }));

    const result = await tool.execute({ context: "на пляже" });
    expect(result.success).toBe(true);
    expect(result.mediaUrl).toBe("https://fal.media/result.jpg");

    vi.unstubAllGlobals();
  });

  it("respects explicit mode parameter", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "https://example.com/photo.jpg" });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        images: [{ url: "https://fal.media/result.jpg" }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await tool.execute({ context: "просто так", mode: "mirror" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.prompt).toContain("mirror selfie");

    vi.unstubAllGlobals();
  });

  it("handles API errors gracefully", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "https://example.com/photo.jpg" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    }));

    const result = await tool.execute({ context: "тест" });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/tools/selfie.test.ts`
Expected: FAIL — `SelfieTool` not found

- [ ] **Step 3: Write SelfieTool implementation**

Create `src/core/tools/selfie.ts`:

```typescript
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
  referencePhotoUrl: string;
}

export class SelfieTool implements Tool {
  name = "selfie";
  description =
    "Сгенерировать и отправить селфи. Используй когда просят фото/селфи, или когда уместно показать как выглядишь.";
  parameters = [
    { name: "context", type: "string", description: "Описание ситуации (в кафе, в новом платье, на пляже)", required: true },
    { name: "mode", type: "string", description: "Режим: mirror (зеркальное, full-body) или direct (close-up). Если не указан — определяется автоматически.", required: false },
  ];

  private config: SelfieToolConfig;

  constructor(config: SelfieToolConfig) {
    this.config = config;
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
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/core/tools/selfie.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/selfie.ts test/core/tools/selfie.test.ts
git commit -m "feat: add SelfieTool with fal.ai Grok Imagine Edit"
```

---

### Task 3: Engine — propagate mediaUrl

**Files:**
- Modify: `src/core/engine.ts:82-98` (tool execution loop), `src/core/engine.ts:133-147` (executeTool)
- Create: `test/core/engine-media.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/core/engine-media.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { Engine } from "../../src/core/engine.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";

const testConfig = {
  name: "Бетси",
  personality: { tone: "friendly", responseStyle: "concise" },
};

describe("Engine mediaUrl propagation", () => {
  it("propagates mediaUrl from tool result to OutgoingMessage", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "selfie",
      description: "Generate selfie",
      parameters: [{ name: "context", type: "string", description: "Context", required: true }],
      async execute() {
        return { success: true, output: "Селфи сгенерировано", mediaUrl: "https://fal.media/test.jpg" };
      },
    });

    const chatMock = vi.fn()
      .mockResolvedValueOnce({
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "call_1", name: "selfie", arguments: { context: "на пляже" } }],
      })
      .mockResolvedValueOnce({
        text: "Вот моё селфи с пляжа!",
        stopReason: "end_turn",
      });

    const llm = {
      fast: () => ({ chat: chatMock }),
      strong: () => ({ chat: chatMock }),
    };

    const engine = new Engine({ llm, config: testConfig, tools });
    const res = await engine.process({
      channelName: "test",
      userId: "1",
      text: "Скинь селфи с пляжа",
      timestamp: Date.now(),
    });

    expect(res.text).toContain("селфи");
    expect(res.mediaUrl).toBe("https://fal.media/test.jpg");
  });

  it("returns no mediaUrl when tools don't produce one", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "shell",
      description: "Run shell",
      parameters: [{ name: "command", type: "string", description: "Command", required: true }],
      async execute() {
        return { success: true, output: "done" };
      },
    });

    const chatMock = vi.fn()
      .mockResolvedValueOnce({
        text: "",
        stopReason: "tool_use",
        toolCalls: [{ id: "call_1", name: "shell", arguments: { command: "echo hi" } }],
      })
      .mockResolvedValueOnce({
        text: "Готово",
        stopReason: "end_turn",
      });

    const llm = {
      fast: () => ({ chat: chatMock }),
      strong: () => ({ chat: chatMock }),
    };

    const engine = new Engine({ llm, config: testConfig, tools });
    const res = await engine.process({
      channelName: "test",
      userId: "1",
      text: "echo hi",
      timestamp: Date.now(),
    });

    expect(res.mediaUrl).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/engine-media.test.ts`
Expected: FAIL — `res.mediaUrl` is undefined (engine doesn't propagate it yet)

- [ ] **Step 3: Modify engine to propagate mediaUrl**

In `src/core/engine.ts`, make two changes:

**Change 1:** Modify `executeTool` to return the full `ToolResult` instead of a string.

Replace the `executeTool` method (lines 133-147):

```typescript
  /** Execute a single tool by name. Returns ToolResult. */
  private async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.deps.tools.get(name);
    if (!tool) {
      return { success: false, output: "", error: `unknown tool "${name}"` };
    }

    try {
      return await tool.execute(args);
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  }
```

Add the import at the top of the file:

```typescript
import type { ToolResult } from "./tools/types.js";
```

**Change 2:** In the `process` method, track `lastMediaUrl` and update the tool execution loop.

Add `let lastMediaUrl: string | undefined;` before the for-loop (around line 50).

In the tool execution loop (lines 82-95), change:

```typescript
        for (const tc of response.toolCalls) {
          onProgress?.({ type: "tool_start", tool: tc.name, turn: turn + 1 });

          const result = await this.executeTool(tc.name, tc.arguments);
          const resultText = result.success
            ? result.output
            : `Error: ${result.error || result.output}`;

          if (result.mediaUrl) {
            lastMediaUrl = result.mediaUrl;
          }

          history.push({
            role: "tool",
            content: resultText,
            toolCallId: tc.id,
          });

          onProgress?.({ type: "tool_end", tool: tc.name, turn: turn + 1, success: result.success });
        }
```

In the final return (line 71), change:

```typescript
          return { text, mediaUrl: lastMediaUrl };
```

Also update the max-turns return (line 103) and error return (line 108) — these don't need `mediaUrl`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/core/engine-media.test.ts test/core/engine.test.ts`
Expected: ALL PASS (both new and existing tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/engine.ts test/core/engine-media.test.ts
git commit -m "feat: propagate mediaUrl from tool results through engine"
```

---

### Task 4: Config normalization for fal.ai

**Files:**
- Modify: `src/core/config.ts:154-161`
- Modify: `src/server.ts:364`

- [ ] **Step 1: Update normalizeConfig in config.ts**

Replace the selfies normalization block (lines 154-161):

```typescript
  // selfies (fal.ai)
  if (raw.fal_api_key || raw.reference_photo_url) {
    out.selfies = {
      fal_api_key: raw.fal_api_key,
      reference_photo_url: raw.reference_photo_url,
    };
  }
```

- [ ] **Step 2: Update API key masking in server.ts**

Replace line 364:

```typescript
  if (safe.selfies?.fal_api_key) safe.selfies.fal_api_key = "***";
```

- [ ] **Step 3: Run existing config tests**

Run: `npx vitest run test/core/config.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/config.ts src/server.ts
git commit -m "feat: update selfies config normalization from KIE.ai to fal.ai"
```

---

### Task 5: Register SelfieTool and update system prompt

**Files:**
- Modify: `src/index.ts:1-15` (imports), `src/index.ts:71-79` (registration)
- Modify: `src/core/prompt.ts:99-109`

- [ ] **Step 1: Add SelfieTool import and registration in src/index.ts**

Add import after line 15:

```typescript
import { SelfieTool } from "./core/tools/selfie.js";
```

After line 79 (after `tools.register(npmInstallTool);`), add:

```typescript
  // Selfie tool — uses fal.ai key from selfies config, falls back to video config
  const selfiesConfig = config.selfies as Record<string, string> | undefined;
  const videoConfig = config.video as Record<string, string> | undefined;
  tools.register(new SelfieTool({
    falApiKey: selfiesConfig?.fal_api_key ?? videoConfig?.fal_api_key ?? "",
    referencePhotoUrl: selfiesConfig?.reference_photo_url ?? "",
  }));
```

- [ ] **Step 2: Add selfie hint to system prompt**

In `src/core/prompt.ts`, in the tools list section (around line 108, after the `ssh` line), add:

```typescript
- selfie — генерация и отправка селфи (используй когда просят фото или когда хочешь показать что делаешь — как друг отправляет фотку в чат)
```

- [ ] **Step 3: Run typecheck and tests**

Run: `npx tsc --noEmit && npx vitest run test/core/prompt.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/core/prompt.ts
git commit -m "feat: register SelfieTool and add selfie hint to system prompt"
```

---

### Task 6: Telegram delivery — remove old selfie, add mediaUrl

**Files:**
- Modify: `src/channels/telegram/handlers.ts:1-6` (imports), `src/channels/telegram/handlers.ts:174-197` (deliver), `src/channels/telegram/handlers.ts:406-410` (/selfie command)
- Delete: `src/channels/telegram/selfies.ts`

- [ ] **Step 1: Remove old selfie import**

In `src/channels/telegram/handlers.ts`, delete line 6:

```typescript
import { sendSelfie } from "./selfies.js";
```

- [ ] **Step 2: Remove old selfie branch from deliver()**

Remove the `mode === "selfie"` block (lines 190-194):

```typescript
  if (mode === "selfie") {
    const sent = await sendSelfie(ctx as never, response.text, "", "");
    if (!sent) await replyHtml(ctx, response.text);
    return;
  }
```

- [ ] **Step 3: Add mediaUrl photo delivery to deliver()**

At the beginning of the `deliver` function (after `const mode = ...`), add:

```typescript
  // If response has a media URL (e.g. from selfie tool), send as photo
  if (response.mediaUrl) {
    try {
      const imgRes = await fetch(response.mediaUrl);
      const buffer = Buffer.from(await imgRes.arrayBuffer());
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
```

- [ ] **Step 4: Update /selfie command**

Change the `/selfie` command handler to not use mode override — let the agentic loop handle it:

```typescript
  // /selfie <prompt>
  bot.command("selfie", async (ctx) => {
    const body = commandBody(ctx, "selfie");
    if (!body) { await ctx.reply("Usage: /selfie <description>"); return; }
    await handleWithTyping(ctx, `Сделай селфи: ${body}`);
  });
```

- [ ] **Step 5: Add TOOL_LABELS entry for selfie**

In the `TOOL_LABELS` object (around line 225), add:

```typescript
  selfie: "генерирую селфи",
```

- [ ] **Step 6: Delete old selfies.ts**

Delete `src/channels/telegram/selfies.ts`.

- [ ] **Step 7: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no references to deleted file remain)

- [ ] **Step 8: Commit**

```bash
git add src/channels/telegram/handlers.ts
git rm src/channels/telegram/selfies.ts
git commit -m "feat: replace old selfie delivery with mediaUrl-based photo sending"
```

---

### Task 7: Browser channel — render mediaUrl

**Files:**
- Modify: `src/ui/pages/BrowserChat.tsx:36-42` (WS message handler), `src/ui/pages/BrowserChat.tsx:156-170` (message rendering)
- Modify: `src/ui/lib/api.ts` (ChatMessage type)

- [ ] **Step 1: Add mediaUrl to ChatMessage type**

In `src/ui/lib/api.ts`, find the `ChatMessage` interface and add:

```typescript
mediaUrl?: string;
```

- [ ] **Step 2: Update WS message handler to capture mediaUrl**

In `BrowserChat.tsx`, in the `ws.onmessage` handler (around line 38), update to also capture `mediaUrl`:

```typescript
          if (data.type === "message") {
            setMessages((prev) => [...prev, {
              role: "assistant",
              content: data.content,
              mediaUrl: data.mediaUrl,
              timestamp: Date.now(),
            }]);
          }
```

Also update the HTTP fallback response parsing (around line 92) to capture `mediaUrl` from the API response if present.

- [ ] **Step 3: Render image in message bubble**

In the message rendering section (around line 166), before the `<MarkdownContent>`, add image rendering:

```tsx
{msg.mediaUrl && (
  <img
    src={msg.mediaUrl}
    alt="selfie"
    className="rounded-md max-w-full mb-2"
    loading="lazy"
  />
)}
<div><MarkdownContent text={msg.content} /></div>
```

- [ ] **Step 4: Run build:ui**

Run: `npm run build:ui`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/pages/BrowserChat.tsx src/ui/lib/api.ts
git commit -m "feat: render selfie images in browser chat"
```

---

### Task 8: Update config example

**Files:**
- Modify: `betsy.config.yaml.example`

- [ ] **Step 1: Update selfies section in example config**

Replace the `selfies:` section:

```yaml
  selfies:
    enabled: false
    # fal_api_key: "key-..."
    # reference_photo_url: "https://..."
```

- [ ] **Step 2: Commit**

```bash
git add betsy.config.yaml.example
git commit -m "docs: update selfies config example for fal.ai"
```

---

### Task 9: Final verification

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS
