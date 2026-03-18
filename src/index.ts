import os from "node:os";
import { createServer } from "./server.js";
import { isConfigured, loadConfig, getAgentName, getPersonality, getLLMApiKey } from "./core/config.js";
import { TelegramChannel } from "./channels/telegram/index.js";
import { LLMRouter } from "./core/llm/router.js";
import { Engine } from "./core/engine.js";
import { ToolRegistry } from "./core/tools/registry.js";
import { ShellTool } from "./core/tools/shell.js";
import { FilesTool } from "./core/tools/files.js";
import { HttpTool } from "./core/tools/http.js";
import { memoryTool } from "./core/tools/memory.js";
import { selfConfigTool } from "./core/tools/self-config.js";
import { schedulerTool } from "./core/tools/scheduler.js";
import { sshTool } from "./core/tools/ssh.js";
import { npmInstallTool } from "./core/tools/npm-install.js";

function getAddress(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

async function main() {
  const port = 3777;
  const address = getAddress();

  const config = isConfigured() ? loadConfig() : null;
  const name = config ? getAgentName(config) : "Betsy";

  console.log(`🦀 ${name} запускается...`);
  console.log(`🌐 Открой в браузере: http://${address}:${port}`);

  if (!config) {
    console.log("📋 Конфиг не найден — открой визард в браузере");
    const { server, wss } = createServer({ port });
    setupShutdown(server, wss);
    return;
  }

  console.log(`✅ Конфиг загружен: ${name}`);

  // Setup LLM
  const apiKey = getLLMApiKey(config);
  let llm: LLMRouter | null = null;

  if (apiKey) {
    const llmConfig = config.llm as any;
    if (llmConfig.fast) {
      llm = new LLMRouter({
        provider: llmConfig.fast.provider,
        api_key: llmConfig.fast.api_key,
        fast_model: llmConfig.fast.model,
        strong_model: llmConfig.strong?.model ?? llmConfig.fast.model,
      });
    } else {
      llm = new LLMRouter({
        provider: llmConfig.provider,
        api_key: llmConfig.api_key,
        fast_model: llmConfig.fast_model,
        strong_model: llmConfig.strong_model,
      });
    }
    console.log("✅ LLM подключён");
  }

  // Register tools
  const tools = new ToolRegistry();
  tools.register(new ShellTool());
  tools.register(new FilesTool());
  tools.register(new HttpTool());
  tools.register(memoryTool);
  tools.register(selfConfigTool);
  tools.register(schedulerTool);
  tools.register(sshTool);
  tools.register(npmInstallTool);
  console.log(`🔧 Зарегистрировано инструментов: ${tools.list().length}`);

  // Setup Engine with personality and tools
  const personality = getPersonality(config);
  const engine = llm ? new Engine({
    llm,
    config: {
      name,
      personality: {
        tone: personality.tone,
        responseStyle: personality.style,
        customInstructions: personality.customInstructions,
      },
    },
    tools,
  }) : null;

  // Start HTTP server
  const { server, wss } = createServer({ port });

  // Start Telegram channel
  if (config.telegram?.token) {
    try {
      const telegram = new TelegramChannel();
      telegram.onMessage(async (msg) => {
        if (engine) {
          return engine.process(msg);
        }
        return { text: "LLM не настроен. Открой дашборд для настройки." };
      });
      await telegram.start({
        token: config.telegram.token,
        owner_chat_id: config.telegram.owner_id?.toString() ?? "",
      });
      console.log("✅ Telegram бот запущен");
    } catch (err) {
      console.error("❌ Telegram ошибка:", err instanceof Error ? err.message : err);
    }
  }

  // Auto-open browser on local machine
  if (os.platform() !== "linux") {
    const { execFile: execFileCb } = await import("node:child_process");
    const opener = os.platform() === "darwin" ? "open" : os.platform() === "win32" ? "start" : "xdg-open";
    execFileCb(opener, [`http://localhost:${port}`], () => {});
  }

  setupShutdown(server, wss);
}

function setupShutdown(server: any, wss: any) {
  const shutdown = () => {
    console.log("\nЗавершение работы...");
    wss.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
