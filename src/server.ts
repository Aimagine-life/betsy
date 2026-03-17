import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Heartbeat } from "./heartbeat.js";
import {
  type CashClawConfig,
  isConfigured,
  loadConfig,
  savePartialConfig,
} from "./config.js";
import { readTodayLog } from "./memory/log.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerContext {
  mode: "setup" | "running";
  config: CashClawConfig | null;
  heartbeat: Heartbeat | null;
}

export interface ServerOptions {
  port?: number;
  engine?: any;
  channels?: any[];
  passwordHash?: string;
}

export interface ServerHandle {
  server: http.Server;
  wss: WebSocketServer;
  port: number;
  close: () => void;
}

// ---------------------------------------------------------------------------
// JWT helpers — HS256 using node:crypto, no external library
// ---------------------------------------------------------------------------

const JWT_SECRET = crypto.randomBytes(32).toString("hex");
const JWT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function base64urlEncode(str: string): string {
  return base64url(Buffer.from(str, "utf-8"));
}

function signJwt(payload: Record<string, unknown>): string {
  const header = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64urlEncode(JSON.stringify({ ...payload, exp: Date.now() + JWT_EXPIRY_MS }));
  const signature = base64url(
    crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest(),
  );
  return `${header}.${body}.${signature}`;
}

function verifyJwt(token: string): Record<string, unknown> | null {
  try {
    const [header, body, signature] = token.split(".");
    if (!header || !body || !signature) return null;

    const expected = base64url(
      crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest(),
    );
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as Record<string, unknown>;
    if (typeof payload.exp === "number" && payload.exp < Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1_048_576; // 1 MB

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseJsonBody<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("Invalid JSON");
  }
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serveStatic(pathname: string, res: http.ServerResponse) {
  const baseDir = import.meta.dirname ?? __dirname;
  const distUi = path.join(baseDir, "..", "dist", "ui");
  const uiDir = fs.existsSync(path.join(distUi, "index.html"))
    ? distUi
    : path.join(baseDir, "ui");

  const resolvedUiDir = path.resolve(uiDir);
  let filePath = path.resolve(uiDir, pathname === "/" ? "index.html" : pathname.slice(1));

  // Path traversal guard
  if (!filePath.startsWith(resolvedUiDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!path.extname(filePath)) {
    filePath = path.join(resolvedUiDir, "index.html");
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "text/plain" });
  fs.createReadStream(filePath).pipe(res);
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

/** Routes that do NOT require JWT */
const PUBLIC_ROUTES = new Set(["/api/auth", "/api/setup/status"]);

/** POST /api/config is public during wizard (setup mode) */
function isPublicRoute(pathname: string, method: string, ctx: ServerContext): boolean {
  if (PUBLIC_ROUTES.has(pathname)) return true;
  // All setup routes are public (wizard flow)
  if (pathname.startsWith("/api/setup/")) return true;
  // POST /api/config is public during setup for the wizard
  if (pathname === "/api/config" && method === "POST" && ctx.mode === "setup") return true;
  return false;
}

function extractToken(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

function createRequestHandler(ctx: ServerContext, options: ServerOptions) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const port = options.port || 3777;
    const allowedOrigin = `http://localhost:${port}`;
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname.startsWith("/api/")) {
      // Auth check — if a password is configured, enforce JWT on protected routes
      if (options.passwordHash && !isPublicRoute(url.pathname, req.method ?? "GET", ctx)) {
        const token = extractToken(req);
        if (!token || !verifyJwt(token)) {
          json(res, { error: "Unauthorized" }, 401);
          return;
        }
      }

      handleApi(url.pathname, req, res, ctx, options);
      return;
    }

    serveStatic(url.pathname, res);
  };
}

// ---------------------------------------------------------------------------
// API router
// ---------------------------------------------------------------------------

function handleApi(
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
  options: ServerOptions,
) {
  // Auth endpoint
  if (pathname === "/api/auth") {
    handleAuth(req, res, options);
    return;
  }

  // Status endpoint — always available
  if (pathname === "/api/status") {
    handleStatus(res, ctx);
    return;
  }

  // Config endpoints
  if (pathname === "/api/config") {
    if (req.method === "GET") {
      handleConfigGet(res, ctx);
    } else if (req.method === "POST") {
      handleConfigPost(req, res, ctx);
    } else {
      json(res, { error: "Method not allowed" }, 405);
    }
    return;
  }

  // Costs endpoint
  if (pathname === "/api/costs") {
    json(res, { costs: [] }); // Placeholder — will be populated by engine
    return;
  }

  // Skills endpoint
  if (pathname === "/api/skills") {
    json(res, { skills: ctx.config?.specialties ?? [] });
    return;
  }

  // Backup endpoints
  if (pathname === "/api/backup/export") {
    if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
    json(res, { error: "Not implemented" }, 501);
    return;
  }
  if (pathname === "/api/backup/import") {
    if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
    json(res, { error: "Not implemented" }, 501);
    return;
  }

  // Setup endpoints
  if (pathname.startsWith("/api/setup/")) {
    handleSetupApi(pathname, req, res, ctx);
    return;
  }

  // Delegate remaining routes to the legacy agent routes
  handleLegacyApi(pathname, req, res, ctx);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function handleAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ServerOptions,
) {
  if (req.method !== "POST") {
    json(res, { error: "POST only" }, 405);
    return;
  }

  // If no password configured, grant access freely
  if (!options.passwordHash) {
    const token = signJwt({ role: "admin" });
    json(res, { ok: true, token });
    return;
  }

  try {
    const body = parseJsonBody<{ password: string }>(await readBody(req));
    const hash = crypto.createHash("sha256").update(body.password).digest("hex");

    if (hash !== options.passwordHash) {
      json(res, { error: "Invalid password" }, 403);
      return;
    }

    const token = signJwt({ role: "admin" });
    json(res, { ok: true, token });
  } catch {
    json(res, { error: "Invalid request" }, 400);
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function handleStatus(res: http.ServerResponse, ctx: ServerContext) {
  const hb = ctx.heartbeat;
  json(res, {
    mode: ctx.mode,
    running: hb?.state.running ?? false,
    activeTasks: hb?.state.activeTasks.size ?? 0,
    totalPolls: hb?.state.totalPolls ?? 0,
    lastPoll: hb?.state.lastPoll ?? 0,
    startedAt: hb?.state.startedAt ?? 0,
    uptime: hb?.state.running ? Date.now() - hb.state.startedAt : 0,
    agentId: ctx.config?.agentId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function handleConfigGet(res: http.ServerResponse, ctx: ServerContext) {
  if (!ctx.config) {
    json(res, { configured: false });
    return;
  }

  json(res, {
    ...ctx.config,
    llm: { ...ctx.config.llm, apiKey: "***" },
  });
}

async function handleConfigPost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
) {
  try {
    const body = parseJsonBody<Partial<CashClawConfig>>(await readBody(req));
    savePartialConfig(body);
    ctx.config = loadConfig();
    json(res, { ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid request";
    json(res, { error: msg }, 400);
  }
}

// ---------------------------------------------------------------------------
// Setup API — mirrors the existing setup routes from agent.ts
// ---------------------------------------------------------------------------

async function handleSetupApi(
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
) {
  try {
    switch (pathname) {
      case "/api/setup/status":
        json(res, {
          configured: isConfigured(),
          mode: ctx.mode,
        });
        break;

      case "/api/setup/llm": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        const body = parseJsonBody(await readBody(req)) as { provider: string; model: string; apiKey: string };
        savePartialConfig({ llm: body as CashClawConfig["llm"] });
        ctx.config = loadConfig();
        json(res, { ok: true });
        break;
      }

      case "/api/setup/complete": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        if (!isConfigured()) {
          json(res, { error: "Configuration incomplete" }, 400);
          return;
        }
        ctx.config = loadConfig()!;
        ctx.mode = "running";
        json(res, { ok: true, mode: "running" });
        break;
      }

      case "/api/setup/reset": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        if (ctx.heartbeat) {
          ctx.heartbeat.stop();
          ctx.heartbeat = null;
        }
        ctx.config = null;
        ctx.mode = "setup";
        json(res, { ok: true, mode: "setup" });
        break;
      }

      default:
        json(res, { error: "Not found" }, 404);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, { error: msg }, 500);
  }
}

// ---------------------------------------------------------------------------
// Legacy API routes — placeholder for endpoints migrated from agent.ts
// ---------------------------------------------------------------------------

/** Routes that require a running agent (config + heartbeat) */
const LEGACY_ROUTES = new Set(["/api/tasks", "/api/logs", "/api/start", "/api/stop"]);

function handleLegacyApi(
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
) {
  // Unknown routes → 404 regardless of agent state
  if (!LEGACY_ROUTES.has(pathname)) {
    json(res, { error: "Not found" }, 404);
    return;
  }

  if (!ctx.config || !ctx.heartbeat) {
    json(res, { error: "Agent not configured", mode: "setup" }, 503);
    return;
  }

  switch (pathname) {
    case "/api/tasks":
      json(res, {
        tasks: [...ctx.heartbeat.state.activeTasks.values()],
        events: ctx.heartbeat.state.events.slice(-50),
      });
      break;

    case "/api/logs":
      json(res, { log: readTodayLog() });
      break;

    case "/api/start":
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
      ctx.heartbeat.start();
      json(res, { ok: true, running: true });
      break;

    case "/api/stop":
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
      ctx.heartbeat.stop();
      json(res, { ok: true, running: false });
      break;
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer(options: ServerOptions = {}): ServerHandle {
  const port = options.port ?? 3777;

  const ctx: ServerContext = {
    mode: "setup",
    config: null,
    heartbeat: null,
  };

  const handler = createRequestHandler(ctx, { ...options, port });
  const server = http.createServer(handler);
  const wss = new WebSocketServer({ server, path: "/chat" });

  // Basic WebSocket connection handling
  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (data) => {
      // Echo back as acknowledgement — channels will extend this
      try {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({ type: "ack", id: msg.id }));
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid message" }));
      }
    });
  });

  server.listen(port);

  return {
    server,
    wss,
    port,
    close: () => {
      wss.close();
      server.close();
    },
  };
}

export { json, readBody, parseJsonBody, signJwt, verifyJwt };
