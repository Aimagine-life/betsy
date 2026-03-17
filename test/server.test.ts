import { describe, it, expect, afterEach } from "vitest";
import { createServer, type ServerHandle } from "../src/server.js";

let handle: ServerHandle | null = null;

afterEach(() => {
  if (handle) {
    handle.close();
    handle = null;
  }
});

describe("Server", () => {
  it("creates server on specified port", async () => {
    handle = createServer({ port: 0 }); // port 0 = OS picks a free port
    const addr = handle.server.address();
    expect(addr).not.toBeNull();
    expect(typeof addr === "object" && addr !== null ? addr.port : -1).toBeGreaterThan(0);
  });

  it("returns status from GET /api/status", async () => {
    handle = createServer({ port: 0 });
    const addr = handle.server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/api/status`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { mode: string; configured: boolean };
    expect(body.mode).toBe("setup");
    expect(body.configured).toBe(false);
  });

  it("returns 404 for unknown API routes", async () => {
    handle = createServer({ port: 0 });
    const addr = handle.server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/api/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("issues JWT from POST /api/auth without password", async () => {
    handle = createServer({ port: 0 });
    const addr = handle.server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; token: string };
    expect(body.ok).toBe(true);
    expect(body.token).toBeTruthy();
    expect(body.token.split(".")).toHaveLength(3);
  });

  it("rejects wrong password when passwordHash is set", async () => {
    const crypto = await import("node:crypto");
    const passwordHash = crypto.createHash("sha256").update("correct").digest("hex");
    handle = createServer({ port: 0, passwordHash });
    const addr = handle.server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(res.status).toBe(403);
  });

  it("grants JWT with correct password", async () => {
    const crypto = await import("node:crypto");
    const passwordHash = crypto.createHash("sha256").update("secret123").digest("hex");
    handle = createServer({ port: 0, passwordHash });
    const addr = handle.server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "secret123" }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; token: string };
    expect(body.ok).toBe(true);
    expect(body.token).toBeTruthy();
  });

  it("protects routes when passwordHash is set", async () => {
    const crypto = await import("node:crypto");
    const passwordHash = crypto.createHash("sha256").update("pass").digest("hex");
    handle = createServer({ port: 0, passwordHash });
    const addr = handle.server.address() as { port: number };

    // /api/status should require auth when password is configured
    const res = await fetch(`http://localhost:${addr.port}/api/status`);
    expect(res.status).toBe(401);

    // Get a valid token
    const authRes = await fetch(`http://localhost:${addr.port}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "pass" }),
    });
    const { token } = (await authRes.json()) as { token: string };

    // Now /api/status should work with the token
    const authedRes = await fetch(`http://localhost:${addr.port}/api/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(authedRes.status).toBe(200);
  });

  it("allows public routes without auth even with passwordHash", async () => {
    const crypto = await import("node:crypto");
    const passwordHash = crypto.createHash("sha256").update("pass").digest("hex");
    handle = createServer({ port: 0, passwordHash });
    const addr = handle.server.address() as { port: number };

    // /api/auth should always be accessible
    const res = await fetch(`http://localhost:${addr.port}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "pass" }),
    });
    expect(res.status).toBe(200);
  });

  it("has WebSocket server on /chat path", () => {
    handle = createServer({ port: 0 });
    expect(handle.wss).toBeDefined();
    expect(handle.wss.options.path).toBe("/chat");
  });

  it("returns skills list", async () => {
    handle = createServer({ port: 0 });
    const addr = handle.server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/api/skills`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { skills: string[] };
    expect(Array.isArray(body.skills)).toBe(true);
  });
});
