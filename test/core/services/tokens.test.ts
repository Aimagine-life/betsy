import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDB, closeDB } from "../../../src/core/memory/db.js";
import { TokenStore } from "../../../src/services/tokens.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

describe("TokenStore", () => {
  const testDbPath = path.join(os.tmpdir(), `betsy-test-tokens-${Date.now()}.db`);
  const encryptionKey = "b55c8792d1ce458e279308835f8a97b580263503e76e1998e279703e35ad0c2e";
  let store: TokenStore;

  beforeEach(() => {
    closeDB();
    getDB(testDbPath);
    store = new TokenStore(encryptionKey);
  });

  afterEach(() => {
    closeDB();
    try { fs.unlinkSync(testDbPath); } catch {}
    try { fs.unlinkSync(testDbPath + "-wal"); } catch {}
    try { fs.unlinkSync(testDbPath + "-shm"); } catch {}
  });

  it("saves and retrieves a token", () => {
    store.save({
      serviceId: "google",
      userId: "user1",
      accessToken: "access-123",
      refreshToken: "refresh-456",
      scopes: "gmail,youtube",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const token = store.get("google", "user1");
    expect(token).not.toBeNull();
    expect(token!.accessToken).toBe("access-123");
    expect(token!.refreshToken).toBe("refresh-456");
    expect(token!.scopes).toBe("gmail,youtube");
  });

  it("tokens are encrypted in the database", () => {
    store.save({
      serviceId: "google",
      userId: "user1",
      accessToken: "plaintext-token",
      refreshToken: "plaintext-refresh",
      scopes: "gmail",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const db = getDB();
    const row = db.prepare("SELECT access_token, refresh_token FROM service_tokens WHERE service_id = ?").get("google") as any;
    expect(row.access_token).not.toBe("plaintext-token");
    expect(row.refresh_token).not.toBe("plaintext-refresh");
  });

  it("deletes a token", () => {
    store.save({ serviceId: "google", userId: "user1", accessToken: "tok", scopes: "gmail", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    store.delete("google", "user1");
    expect(store.get("google", "user1")).toBeNull();
  });

  it("lists connected services for a user", () => {
    store.save({ serviceId: "google", userId: "user1", accessToken: "t1", scopes: "gmail", expiresAt: 9999999999 });
    store.save({ serviceId: "github", userId: "user1", accessToken: "t2", scopes: "repo", expiresAt: 9999999999 });
    const services = store.listConnected("user1");
    expect(services).toHaveLength(2);
    expect(services.map(s => s.serviceId).sort()).toEqual(["github", "google"]);
  });

  it("isExpired returns true for expired tokens", () => {
    store.save({ serviceId: "google", userId: "user1", accessToken: "t", scopes: "gmail", expiresAt: 1000 });
    const token = store.get("google", "user1");
    expect(token!.isExpired()).toBe(true);
  });

  it("isExpired returns false for valid tokens", () => {
    store.save({ serviceId: "google", userId: "user1", accessToken: "t", scopes: "gmail", expiresAt: Math.floor(Date.now() / 1000) + 7200 });
    const token = store.get("google", "user1");
    expect(token!.isExpired()).toBe(false);
  });

  it("upserts on duplicate service+user", () => {
    store.save({ serviceId: "google", userId: "user1", accessToken: "old", scopes: "gmail", expiresAt: 9999999999 });
    store.save({ serviceId: "google", userId: "user1", accessToken: "new", scopes: "gmail,youtube", expiresAt: 9999999999 });
    const token = store.get("google", "user1");
    expect(token!.accessToken).toBe("new");
    expect(token!.scopes).toBe("gmail,youtube");
  });
});
