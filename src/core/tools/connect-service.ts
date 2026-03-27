import type { Tool, ToolResult } from "./types.js";
import { listServices, getService, type ServiceDefinition } from "../../services/catalog.js";
import { TokenStore } from "../../services/tokens.js";

export type OnConnectedCallback = (userId: string, service: ServiceDefinition, scopes: string[]) => void;

export interface ConnectServiceConfig {
  encryptionKey: string;
  onConnected?: OnConnectedCallback;
}

export class ConnectServiceTool implements Tool {
  name = "connect_service";
  description =
    "Подключение и управление внешними сервисами (Google, GitHub, VK и др.). " +
    "Используй action=list чтобы показать доступные сервисы, action=connect для подключения, " +
    "action=disconnect для отключения, action=status для просмотра статуса.";
  parameters = [
    { name: "action", type: "string", description: "list | connect | disconnect | status", required: true },
    { name: "service", type: "string", description: "ID сервиса: google, github, vk, yandex, reddit, mailru" },
    { name: "scopes", type: "string", description: "Части сервиса через запятую: gmail,youtube,calendar" },
  ];

  private tokenStore: TokenStore;
  private encryptionKey: string;
  private onConnected?: OnConnectedCallback;

  constructor(config: ConnectServiceConfig) {
    this.tokenStore = new TokenStore(config.encryptionKey);
    this.encryptionKey = config.encryptionKey;
    this.onConnected = config.onConnected;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action ?? "").trim();
    const userId = String(params._userId ?? "unknown");

    switch (action) {
      case "list": return this.handleList(userId);
      case "connect": return this.handleConnect(params, userId);
      case "disconnect": return this.handleDisconnect(params, userId);
      case "status": return this.handleStatus(userId);
      default: return { success: false, output: `Неизвестное действие: "${action}". Используй: list, connect, disconnect, status` };
    }
  }

  private handleList(userId: string): ToolResult {
    const services = listServices();
    const connected = this.tokenStore.listConnected(userId);
    const connectedIds = new Set(connected.map(t => t.serviceId));
    const lines = services.map(s => {
      const status = connectedIds.has(s.id) ? "✅" : "⬜";
      return `${status} **${s.name}** — ${s.description}`;
    });
    return { success: true, output: `Доступные сервисы:\n\n${lines.join("\n")}` };
  }

  private async handleConnect(params: Record<string, unknown>, userId: string): Promise<ToolResult> {
    const serviceId = String(params.service ?? "").trim();
    if (!serviceId) return { success: false, output: "Укажи какой сервис подключить (параметр service)" };

    const service = getService(serviceId);
    if (!service) return { success: false, output: `Неизвестный сервис: "${serviceId}". Используй action=list чтобы посмотреть доступные.` };

    const requestedScopes = params.scopes
      ? String(params.scopes).split(",").map(s => s.trim())
      : Object.keys(service.scopes);

    const scopeLabels = requestedScopes.map(s => service.scopes[s] ?? s).join(", ");

    try {
      const response = await fetch(`${service.relayUrl}/start/${serviceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopes: requestedScopes }),
      });

      if (!response.ok) {
        const errText = await response.text();
        return { success: false, output: `Ошибка запуска OAuth: ${response.status}`, error: errText.slice(0, 300) };
      }

      const data = await response.json() as { instance_id: string; auth_url: string };

      // Start polling in background — don't block the response
      this.pollForToken(service.relayUrl, data.instance_id).then(async token => {
        if (token) {
          this.tokenStore.save({
            serviceId,
            userId,
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            scopes: requestedScopes.join(","),
            expiresAt: Math.floor(Date.now() / 1000) + (token.expires_in ?? 3600),
          });
          console.log(`✅ OAuth: ${service.name} подключён для ${userId}`);

          // Verify token works with a test request
          const verification = await this.verifyConnection(serviceId, token.access_token);
          console.log(`🔍 OAuth verify ${service.name}: ${verification}`);

          // Notify via callback (sends message to user's chat)
          if (this.onConnected) {
            this.onConnected(userId, service, requestedScopes);
          }
        } else {
          console.log(`⚠️ OAuth: ${service.name} — авторизация не завершена для ${userId}`);
        }
      }).catch(err => {
        console.error(`❌ OAuth polling error for ${service.name}:`, err);
      });

      // Return immediately with the auth URL
      return {
        success: true,
        output: `Отправь пользователю эту ссылку для авторизации: ${data.auth_url}\n\nПосле авторизации ${service.name} подключится автоматически (${scopeLabels}).`,
      };
    } catch (err) {
      return {
        success: false,
        output: `Ошибка подключения к ${service.name}`,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private handleDisconnect(params: Record<string, unknown>, userId: string): ToolResult {
    const serviceId = String(params.service ?? "").trim();
    if (!serviceId) return { success: false, output: "Укажи какой сервис отключить (параметр service)" };

    const service = getService(serviceId);
    if (!service) return { success: false, output: `Неизвестный сервис: "${serviceId}"` };

    this.tokenStore.delete(serviceId, userId);
    return { success: true, output: `${service.name} отключён.` };
  }

  private handleStatus(userId: string): ToolResult {
    const connected = this.tokenStore.listConnected(userId);
    const allServices = listServices();

    if (connected.length === 0) {
      return { success: true, output: "Нет подключённых сервисов. Используй action=list чтобы посмотреть доступные." };
    }

    const connectedIds = new Set(connected.map(t => t.serviceId));
    const lines: string[] = ["Подключено:"];

    for (const token of connected) {
      const svc = getService(token.serviceId);
      const name = svc?.name ?? token.serviceId;
      const scopeLabels = token.scopes.split(",").map(s => svc?.scopes[s] ?? s).join(", ");
      const expired = token.isExpired() ? " ⚠️ (токен истёк)" : "";
      lines.push(`  ✅ ${name} (${scopeLabels})${expired}`);
    }

    const notConnected = allServices.filter(s => !connectedIds.has(s.id));
    if (notConnected.length > 0) {
      lines.push("\nНе подключено:");
      for (const svc of notConnected) {
        lines.push(`  ⬜ ${svc.name}`);
      }
    }

    return { success: true, output: lines.join("\n") };
  }

  /** Make a lightweight test request to verify the token actually works. */
  private async verifyConnection(serviceId: string, accessToken: string): Promise<string> {
    const testUrls: Record<string, string> = {
      google: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      github: "https://api.github.com/user",
      vk: "https://api.vk.com/method/users.get?v=5.199",
      yandex: "https://cloud-api.yandex.net/v1/disk/",
      reddit: "https://oauth.reddit.com/api/v1/me",
      mailru: "https://oauth.mail.ru/userinfo",
    };
    const url = testUrls[serviceId];
    if (!url) return "no test URL";

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return "OK";
      return `HTTP ${res.status}`;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private async pollForToken(
    relayUrl: string,
    instanceId: string,
  ): Promise<{ access_token: string; refresh_token?: string; expires_in?: number } | null> {
    const POLL_INTERVAL = 3000;
    const MAX_POLLS = 100;

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      try {
        const response = await fetch(`${relayUrl}/poll/${instanceId}`);
        if (!response.ok) continue;
        const data = await response.json() as {
          status: string;
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
        };
        if (data.status === "complete" && data.access_token) {
          return { access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in };
        }
        if (data.status === "expired") return null;
      } catch { /* network error, keep trying */ }
    }
    return null;
  }
}
