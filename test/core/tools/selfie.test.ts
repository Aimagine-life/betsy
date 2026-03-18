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
    expect(result.output).toContain("фото");
  });

  it("detects mirror mode from keywords", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "https://example.com/photo.jpg" });

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
