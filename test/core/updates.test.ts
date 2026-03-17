import { describe, it, expect, vi, afterEach } from "vitest";
import { checkForUpdates } from "../../src/core/updates.js";

describe("checkForUpdates", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns new version when remote is newer", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: "v2.0.0", body: "New stuff" }),
    }) as unknown as typeof fetch;

    const result = await checkForUpdates("1.0.0");

    expect(result).not.toBeNull();
    expect(result!.version).toBe("2.0.0");
    expect(result!.changelog).toBe("New stuff");
  });

  it("returns null when already up to date", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: "v1.0.0", body: "" }),
    }) as unknown as typeof fetch;

    const result = await checkForUpdates("1.0.0");
    expect(result).toBeNull();
  });

  it("returns null when current is newer than remote", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: "v0.9.0", body: "" }),
    }) as unknown as typeof fetch;

    const result = await checkForUpdates("1.0.0");
    expect(result).toBeNull();
  });

  it("returns null on fetch error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new Error("Network error"),
    ) as unknown as typeof fetch;

    const result = await checkForUpdates("1.0.0");
    expect(result).toBeNull();
  });

  it("returns null on non-OK response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }) as unknown as typeof fetch;

    const result = await checkForUpdates("1.0.0");
    expect(result).toBeNull();
  });

  it("handles v-prefixed current version", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: "v2.0.0", body: "Changelog" }),
    }) as unknown as typeof fetch;

    const result = await checkForUpdates("v1.5.0");

    expect(result).not.toBeNull();
    expect(result!.version).toBe("2.0.0");
  });

  it("compares minor and patch versions correctly", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: "v1.2.3", body: "Patch" }),
    }) as unknown as typeof fetch;

    const result = await checkForUpdates("1.2.2");

    expect(result).not.toBeNull();
    expect(result!.version).toBe("1.2.3");
  });
});
