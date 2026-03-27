import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { HttpTool } from "../../src/core/tools/http.js"
import { TokenStore } from "../../src/services/tokens.js"
import { getDB, closeDB } from "../../src/core/memory/db.js"
import path from "node:path"
import os from "node:os"
import fs from "node:fs"

describe("HttpTool", () => {
  it("has updated description mentioning API calls", () => {
    const tool = new HttpTool()
    expect(tool.description).toContain("API")
  })

  it("has MAX_OUTPUT_CHARS constant", () => {
    expect(HttpTool.MAX_OUTPUT_CHARS).toBe(8000)
  })
})

describe("HttpTool auth injection", () => {
  const testDbPath = path.join(os.tmpdir(), `betsy-test-http-${Date.now()}.db`);
  const encKey = "b55c8792d1ce458e279308835f8a97b580263503e76e1998e279703e35ad0c2e";

  beforeEach(() => { closeDB(); getDB(testDbPath); });
  afterEach(() => { closeDB(); try { fs.unlinkSync(testDbPath); } catch {} try { fs.unlinkSync(testDbPath + "-wal"); } catch {} try { fs.unlinkSync(testDbPath + "-shm"); } catch {} });

  it("resolveAuthHeader returns token for matching service URL", () => {
    const store = new TokenStore(encKey);
    store.save({ serviceId: "github", userId: "user1", accessToken: "gh-token-123", scopes: "default", expiresAt: 9999999999 });
    const tool = new HttpTool({ encryptionKey: encKey });
    const header = tool.resolveAuthHeader("https://api.github.com/user/repos", "user1");
    expect(header).toBe("Bearer gh-token-123");
  });

  it("resolveAuthHeader returns null for unknown URL", () => {
    const tool = new HttpTool({ encryptionKey: encKey });
    const header = tool.resolveAuthHeader("https://random-api.com/data", "user1");
    expect(header).toBeNull();
  });
});
