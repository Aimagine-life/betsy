import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { loadConfig, saveConfig, isConfigured, type BetsyConfig } from "./core/config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerContext {
  mode: "setup" | "running";
  config: BetsyConfig | null;
  engine?: any;
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
  // Try dist/ui from project root (works both from src/ in dev and dist/ in prod)
  const projectRoot = path.join(baseDir, "..");
  const distUi = path.join(projectRoot, "dist", "ui");
  const srcUi = path.join(projectRoot, "src", "ui");
  const uiDir = fs.existsSync(path.join(distUi, "index.html"))
    ? distUi
    : srcUi;

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
  // Hashed assets are immutable; index.html must always be revalidated
  const cacheControl = filePath.includes("/assets/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] ?? "text/plain",
    "Cache-Control": cacheControl,
  });
  fs.createReadStream(filePath).pipe(res);
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

/** Routes that do NOT require JWT */
const PUBLIC_ROUTES = new Set(["/api/auth", "/api/setup/status", "/api/status"]);

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

  // Chat endpoints
  if (pathname === "/api/chat") {
    if (req.method === "GET") {
      handleChatGet(res, ctx);
    } else if (req.method === "POST") {
      handleChatSend(req, res, ctx);
    } else {
      json(res, { error: "Method not allowed" }, 405);
    }
    return;
  }
  if (pathname === "/api/chat/clear") {
    if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
    handleChatClear(res, ctx);
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
  const channels: string[] = [];
  if (ctx.config?.telegram?.token) channels.push("telegram");
  if (ctx.config?.channels?.browser) channels.push("browser");

  json(res, {
    mode: ctx.mode,
    configured: ctx.config !== null,
    agentName: ctx.config?.agent?.name ?? "Betsy",
    channels,
    tools: ["shell", "files", "http", "browser", "memory", "npm_install", "scheduler", "self_config", "ssh"],
    memory: { entries: 0 },
    uptime: process.uptime() * 1000,
    running: ctx.mode === "running",
  });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function handleConfigGet(res: http.ServerResponse, ctx: ServerContext) {
  if (!ctx.config) {
    json(res, { configured: false }, 404);
    return;
  }

  // Mask sensitive fields
  const safe = JSON.parse(JSON.stringify(ctx.config));
  if (safe.llm) {
    if (safe.llm.api_key) safe.llm.api_key = "***";
    if (safe.llm.fast?.api_key) safe.llm.fast.api_key = "***";
    if (safe.llm.strong?.api_key) safe.llm.strong.api_key = "***";
  }
  if (safe.telegram?.token) safe.telegram.token = "***";
  if (safe.voice?.openai_key) safe.voice.openai_key = "***";
  if (safe.sync_so?.api_key) safe.sync_so.api_key = "***";
  if (safe.selfies?.fal_api_key) safe.selfies.fal_api_key = "***";
  if (safe.skillsmp?.api_key) safe.skillsmp.api_key = "***";

  json(res, { configured: true, ...safe });
}

async function handleConfigPost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
) {
  try {
    const body = parseJsonBody<Record<string, unknown>>(await readBody(req));
    ctx.config = body as BetsyConfig;
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
          configured: ctx.config !== null,
          mode: ctx.mode,
        });
        break;

      case "/api/setup/complete": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        ctx.mode = "running";
        json(res, { ok: true, mode: "running" });
        break;
      }

      case "/api/setup/wizard": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        const wizardBody = parseJsonBody<Record<string, unknown>>(await readBody(req));
        const personalityData = wizardBody.personality as Record<string, unknown> | null;
        const channels = wizardBody.channels as Record<string, unknown> | null;

        const sliderKeys = ["formality","emotionality","humor","confidence","response_length","structure","emoji","examples","friendliness","initiative","curiosity","empathy","criticism"];
        const personalityConfig: Record<string, unknown> = {};
        if (personalityData) {
          for (const k of sliderKeys) {
            if (typeof personalityData[k] === "number") personalityConfig[k] = personalityData[k];
          }
          if (personalityData.customInstructions) personalityConfig.custom_instructions = personalityData.customInstructions;
        }

        const newConfig: Record<string, unknown> = {
          agent: {
            name: (personalityData?.name as string) || "Betsy",
            gender: (personalityData?.gender as string) || "female",
            personality: personalityConfig,
          },
          llm: {
            provider: "openrouter",
            api_key: wizardBody.apiKey as string,
          },
          memory: { max_knowledge: 200, study_interval_min: 30, learning_enabled: true, context_budget: 40000 },
          channels: channels ?? {},
        };

        if (wizardBody.password && typeof wizardBody.password === "string") {
          const { createHash } = await import("node:crypto");
          const hash = createHash("sha256").update(wizardBody.password).digest("hex");
          (newConfig as Record<string, unknown>).security = { password_hash: hash };
        }

        if (wizardBody.falApiKey && typeof wizardBody.falApiKey === "string") {
          (newConfig as Record<string, unknown>).selfies = { fal_api_key: wizardBody.falApiKey };
        }

        const ownerData = wizardBody.owner as Record<string, unknown> | null;
        if (ownerData) {
          (newConfig as Record<string, unknown>).owner = {
            name: ownerData.name as string,
            address_as: ownerData.addressAs as string,
            facts: (ownerData.facts as string[]) ?? [],
          };
        }

        saveConfig(newConfig as BetsyConfig);
        ctx.config = loadConfig();
        ctx.mode = "running";
        json(res, { ok: true, mode: "running" });
        break;
      }

      case "/api/setup/validate-key": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        const keyBody = parseJsonBody<Record<string, unknown>>(await readBody(req));
        const apiKey = keyBody.apiKey as string;
        if (!apiKey || typeof apiKey !== "string") {
          json(res, { error: "API ключ не указан" }, 400);
          return;
        }
        const keyRes = await fetch("https://openrouter.ai/api/v1/auth/key", {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!keyRes.ok) {
          json(res, { valid: false, error: "Неверный API ключ" });
          return;
        }
        const keyData = await keyRes.json() as { data?: { label?: string; limit?: number; usage?: number; limit_remaining?: number } };
        const balance = keyData.data?.limit_remaining ?? keyData.data?.limit ?? null;
        json(res, { valid: true, balance });
        break;
      }

      case "/api/setup/avatar": {
        if (req.method === "GET") {
          const avatarPath = path.join(os.homedir(), ".betsy", "avatar.png");
          if (fs.existsSync(avatarPath)) {
            res.writeHead(200, { "Content-Type": "image/png" });
            fs.createReadStream(avatarPath).pipe(res);
          } else {
            json(res, { error: "No avatar" }, 404);
          }
          return;
        }
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        if (body.length === 0) { json(res, { error: "Пустой файл" }, 400); return; }
        if (body.length > 5 * 1024 * 1024) { json(res, { error: "Файл слишком большой (макс 5 МБ)" }, 400); return; }
        const betsyDir = path.join(os.homedir(), ".betsy");
        if (!fs.existsSync(betsyDir)) fs.mkdirSync(betsyDir, { recursive: true });
        fs.writeFileSync(path.join(betsyDir, "avatar.png"), body);
        json(res, { ok: true });
        break;
      }

      case "/api/setup/analyze-avatar": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        const body = parseJsonBody<{ apiKey?: string; image: string }>(await readBody(req));
        // Use provided apiKey or fall back to config (supports both flat and nested llm formats)
        const llmCfg = ctx.config?.llm as Record<string, unknown> | undefined;
        const analyzeKey = body.apiKey
          || (llmCfg?.api_key as string | undefined)
          || ((llmCfg?.fast as Record<string, unknown> | undefined)?.api_key as string | undefined)
          || ((llmCfg?.strong as Record<string, unknown> | undefined)?.api_key as string | undefined)
          || "";
        if (!analyzeKey || !body.image) {
          json(res, { error: "API ключ и изображение (base64) обязательны" }, 400);
          return;
        }
        const visionModels = [
          "google/gemini-2.5-flash",
          "google/gemini-2.0-flash-exp:free",
          "qwen/qwen-2.5-vl-72b-instruct:free",
          "meta-llama/llama-4-maverick:free",
        ];
        const analyzePrompt = `Analyze this avatar image and suggest personality traits for an AI assistant that would match this character visually.

Return ONLY valid JSON (no markdown, no backticks):
{
  "name": "suggested name in Russian or English",
  "gender": "female" or "male",
  "formality": 0-4 (0=casual, 4=formal),
  "emotionality": 0-4 (0=reserved, 4=expressive),
  "humor": 0-4 (0=serious, 4=comedian),
  "confidence": 0-4 (0=cautious, 4=assertive),
  "response_length": 0-4 (0=telegraphic, 4=verbose),
  "structure": 0-4 (0=plain text, 4=headers+lists),
  "emoji": 0-4 (0=never, 4=maximum),
  "examples": 0-4 (0=never, 4=always),
  "friendliness": 0-4 (0=cold, 4=warm),
  "initiative": 0-4 (0=reactive, 4=proactive),
  "curiosity": 0-4 (0=never asks, 4=always asks),
  "empathy": 0-4 (0=neutral, 4=deeply caring),
  "criticism": 0-4 (0=agreeable, 4=argumentative),
  "description": "brief character description in Russian, 1-2 sentences"
}`;
        const analyzeMessages = [{
          role: "user",
          content: [
            { type: "text", text: analyzePrompt },
            { type: "image_url", image_url: { url: `data:image/png;base64,${body.image}` } },
          ],
        }];

        let content = "";
        for (const model of visionModels) {
          try {
            const analyzeRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${analyzeKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ model, messages: analyzeMessages }),
            });
            if (analyzeRes.ok) {
              const result = await analyzeRes.json() as { choices?: { message?: { content?: string } }[] };
              content = result.choices?.[0]?.message?.content ?? "";
              if (content) {
                console.log(`✅ Avatar analysis: ${model}`);
                break;
              }
            }
            console.log(`⚠️ Avatar analysis: ${model} failed (${analyzeRes.status}), trying next...`);
          } catch (err) {
            console.log(`⚠️ Avatar analysis: ${model} error: ${err instanceof Error ? err.message : err}`);
          }
        }
        if (!content) {
          json(res, { error: "Ошибка анализа аватара — все модели недоступны" }, 500);
          return;
        }
        try {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          const parsed = JSON.parse(jsonMatch?.[0] ?? content);
          json(res, { ok: true, analysis: parsed });
        } catch {
          json(res, { error: "Не удалось разобрать ответ AI", raw: content }, 500);
        }
        break;
      }

      case "/api/setup/reset": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
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
// Chat API — browser chat via engine (with LLM fallback)
// ---------------------------------------------------------------------------

const BROWSER_USER_ID = "browser-owner";

function handleChatGet(res: http.ServerResponse, ctx: ServerContext) {
  if (!ctx.engine) {
    json(res, { messages: [] });
    return;
  }
  const history = ctx.engine.getHistory(BROWSER_USER_ID) as Array<{ role: string; content: string }>;
  const messages = history.map((m: { role: string; content: string }) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
    timestamp: Date.now(),
  }));
  json(res, { messages });
}

async function handleChatSend(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
) {
  if (!ctx.engine) {
    json(res, { error: "Движок не запущен. Настрой LLM в конфиге." }, 503);
    return;
  }

  try {
    const body = parseJsonBody<{ message: string }>(await readBody(req));
    if (!body.message?.trim()) {
      json(res, { error: "Empty message" }, 400);
      return;
    }

    const result = await ctx.engine.process({
      channelName: "browser",
      userId: BROWSER_USER_ID,
      text: body.message.trim(),
      timestamp: Date.now(),
    });

    json(res, { reply: result.text, mediaUrl: result.mediaUrl });
  } catch (err) {
    console.error("Chat error:", err);
    json(res, { reply: "Произошла ошибка при обработке сообщения." });
  }
}

function handleChatClear(res: http.ServerResponse, ctx: ServerContext) {
  if (ctx.engine) {
    ctx.engine.clearHistory(BROWSER_USER_ID);
  }
  json(res, { ok: true });
}

// ---------------------------------------------------------------------------
// Legacy API routes — placeholder for endpoints migrated from agent.ts
// ---------------------------------------------------------------------------

function handleLegacyApi(
  pathname: string,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _ctx: ServerContext,
) {
  json(res, { error: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer(options: ServerOptions = {}): ServerHandle {
  const port = options.port ?? 3777;

  const config = loadConfig();
  const ctx: ServerContext = {
    mode: config ? "running" : "setup",
    config,
    engine: options.engine ?? null,
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
