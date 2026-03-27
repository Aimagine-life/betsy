import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

interface ServiceConfig {
  client_id: string;
  client_secret: string;
  auth_url: string;
  token_url: string;
  scopes: Record<string, string[]>;
}

interface Config {
  port: number;
  services: Record<string, ServiceConfig>;
}

const configRaw = readFileSync(new URL("./config.yaml", import.meta.url), "utf-8");
const config = parseYaml(configRaw) as Config;
const PORT = config.port || 3780;
const CALLBACK_BASE = process.env.CALLBACK_BASE || "https://auth.betsyai.io";
const TTL_MS = 5 * 60 * 1000;

interface PendingEntry {
  service: string;
  scopes: string[];
  createdAt: number;
  token?: { access_token: string; refresh_token?: string; expires_in?: number };
}

const pending = new Map<string, PendingEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (now - entry.createdAt > TTL_MS) pending.delete(id);
  }
}, 60_000);

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Betsy</title></head><body style="font-family:sans-serif;text-align:center;padding-top:80px;"><h1>${body}</h1></body></html>`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function parseRoute(url: string): { path: string; params: URLSearchParams } {
  const u = new URL(url, "http://localhost");
  return { path: u.pathname, params: u.searchParams };
}

async function handleStart(serviceName: string, body: string, res: ServerResponse): Promise<void> {
  const svc = config.services[serviceName];
  if (!svc) return json(res, 404, { error: `Unknown service: ${serviceName}` });

  let requestedScopes: string[];
  try {
    const parsed = JSON.parse(body);
    requestedScopes = parsed.scopes ?? Object.keys(svc.scopes);
  } catch {
    requestedScopes = Object.keys(svc.scopes);
  }

  const flatScopes: string[] = [];
  for (const scopeKey of requestedScopes) {
    const scopeValues = svc.scopes[scopeKey];
    if (scopeValues) flatScopes.push(...scopeValues);
  }

  const instanceId = randomUUID();
  pending.set(instanceId, { service: serviceName, scopes: requestedScopes, createdAt: Date.now() });

  const callbackUrl = `${CALLBACK_BASE}/callback/${serviceName}`;
  const authParams = new URLSearchParams({
    client_id: svc.client_id,
    redirect_uri: callbackUrl,
    response_type: "code",
    scope: flatScopes.join(" "),
    state: instanceId,
    access_type: "offline",
    prompt: "consent",
  });

  json(res, 200, { instance_id: instanceId, auth_url: `${svc.auth_url}?${authParams.toString()}` });
}

async function handleCallback(serviceName: string, params: URLSearchParams, res: ServerResponse): Promise<void> {
  const svc = config.services[serviceName];
  if (!svc) return html(res, "Неизвестный сервис");

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return html(res, "Ошибка авторизации — не получен код");

  const entry = pending.get(state);
  if (!entry) return html(res, "Ссылка истекла. Попроси Betsy отправить новую.");

  const callbackUrl = `${CALLBACK_BASE}/callback/${serviceName}`;
  const tokenParams = new URLSearchParams({
    client_id: svc.client_id,
    client_secret: svc.client_secret,
    code,
    grant_type: "authorization_code",
    redirect_uri: callbackUrl,
  });

  try {
    const tokenRes = await fetch(svc.token_url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: tokenParams.toString(),
    });

    const tokenData = await tokenRes.json() as Record<string, unknown>;
    if (!tokenRes.ok || tokenData.error) {
      console.error(`Token exchange failed for ${serviceName}:`, tokenData);
      return html(res, "Ошибка получения токена. Попробуй ещё раз.");
    }

    entry.token = {
      access_token: tokenData.access_token as string,
      refresh_token: tokenData.refresh_token as string | undefined,
      expires_in: tokenData.expires_in as number | undefined,
    };

    html(res, "✅ Готово! Можешь закрыть это окно и вернуться к Betsy.");
  } catch (err) {
    console.error(`Token exchange error for ${serviceName}:`, err);
    html(res, "Ошибка. Попробуй ещё раз.");
  }
}

function handlePoll(instanceId: string, res: ServerResponse): void {
  const entry = pending.get(instanceId);
  if (!entry) return json(res, 200, { status: "expired" });
  if (Date.now() - entry.createdAt > TTL_MS) {
    pending.delete(instanceId);
    return json(res, 200, { status: "expired" });
  }
  if (!entry.token) return json(res, 200, { status: "pending" });

  const token = entry.token;
  pending.delete(instanceId);
  json(res, 200, { status: "complete", access_token: token.access_token, refresh_token: token.refresh_token, expires_in: token.expires_in });
}

async function handleRefresh(serviceName: string, body: string, res: ServerResponse): Promise<void> {
  const svc = config.services[serviceName];
  if (!svc) return json(res, 404, { error: `Unknown service: ${serviceName}` });

  let refreshToken: string;
  try {
    const parsed = JSON.parse(body);
    refreshToken = parsed.refresh_token;
  } catch {
    return json(res, 400, { error: "Invalid body" });
  }
  if (!refreshToken) return json(res, 400, { error: "Missing refresh_token" });

  const tokenParams = new URLSearchParams({
    client_id: svc.client_id,
    client_secret: svc.client_secret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  try {
    const tokenRes = await fetch(svc.token_url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: tokenParams.toString(),
    });
    const tokenData = await tokenRes.json() as Record<string, unknown>;
    if (!tokenRes.ok || tokenData.error) return json(res, 401, { error: "Refresh failed", details: tokenData });
    json(res, 200, { access_token: tokenData.access_token, expires_in: tokenData.expires_in });
  } catch {
    json(res, 500, { error: "Internal error" });
  }
}

const server = createServer(async (req, res) => {
  const { path: routePath, params } = parseRoute(req.url ?? "/");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  const startMatch = routePath.match(/^\/start\/(\w+)$/);
  if (startMatch && req.method === "POST") return handleStart(startMatch[1], await readBody(req), res);

  const callbackMatch = routePath.match(/^\/callback\/(\w+)$/);
  if (callbackMatch && req.method === "GET") return handleCallback(callbackMatch[1], params, res);

  const pollMatch = routePath.match(/^\/poll\/([\w-]+)$/);
  if (pollMatch && req.method === "GET") return handlePoll(pollMatch[1], res);

  const refreshMatch = routePath.match(/^\/refresh\/(\w+)$/);
  if (refreshMatch && req.method === "POST") return handleRefresh(refreshMatch[1], await readBody(req), res);

  if (routePath === "/health") return json(res, 200, { status: "ok", services: Object.keys(config.services) });

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`🔑 Betsy Auth Relay running on port ${PORT}`);
  console.log(`   Services: ${Object.keys(config.services).join(", ")}`);
  console.log(`   Callback base: ${CALLBACK_BASE}`);
});
