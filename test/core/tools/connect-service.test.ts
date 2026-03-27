import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDB, closeDB } from "../../../src/core/memory/db.js";
import { ConnectServiceTool } from "../../../src/core/tools/connect-service.js";
import { TokenStore } from "../../../src/services/tokens.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

describe("ConnectServiceTool", () => {
  const testDbPath = path.join(os.tmpdir(), `betsy-test-connect-${Date.now()}.db`);
  const encKey = "b55c8792d1ce458e279308835f8a97b580263503e76e1998e279703e35ad0c2e";
  let tool: ConnectServiceTool;

  beforeEach(() => {
    closeDB();
    getDB(testDbPath);
    tool = new ConnectServiceTool({ encryptionKey: encKey });
  });

  afterEach(() => {
    closeDB();
    try { fs.unlinkSync(testDbPath); } catch {}
    try { fs.unlinkSync(testDbPath + "-wal"); } catch {}
    try { fs.unlinkSync(testDbPath + "-shm"); } catch {}
  });

  it("has correct tool interface", () => {
    expect(tool.name).toBe("connect_service");
    expect(tool.parameters.length).toBeGreaterThan(0);
  });

  it("action=list returns available services", async () => {
    const result = await tool.execute({ action: "list", _userId: "test" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Google");
    expect(result.output).toContain("GitHub");
    expect(result.output).toContain("ВКонтакте");
  });

  it("action=status shows no connections initially", async () => {
    const result = await tool.execute({ action: "status", _userId: "test" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Нет подключённых сервисов");
  });

  it("action=disconnect removes token", async () => {
    const store = new TokenStore(encKey);
    store.save({ serviceId: "google", userId: "test", accessToken: "t", scopes: "gmail", expiresAt: 9999999999 });
    const result = await tool.execute({ action: "disconnect", service: "google", _userId: "test" });
    expect(result.success).toBe(true);
    expect(store.get("google", "test")).toBeNull();
  });

  it("action=connect fails for unknown service", async () => {
    const result = await tool.execute({ action: "connect", service: "unknown", _userId: "test" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Неизвестный сервис");
  });

  it("action=connect without service returns error", async () => {
    const result = await tool.execute({ action: "connect", _userId: "test" });
    expect(result.success).toBe(false);
  });
});
