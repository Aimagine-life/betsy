import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "./server.js";
import { isConfigured, loadConfig, saveConfig, getAgentName, getPersonality, getPersonalitySliders, getLLMApiKey } from "./core/config.js";
import { TelegramChannel } from "./channels/telegram/index.js";
import { LLMRouter } from "./core/llm/router.js";
import { Engine } from "./core/engine.js";
import { ToolRegistry } from "./core/tools/registry.js";
import { ShellTool } from "./core/tools/shell.js";
import { FilesTool } from "./core/tools/files.js";
import { HttpTool } from "./core/tools/http.js";
import { BrowserTool } from "./core/tools/browser.js";
import { WebTool } from "./core/tools/web.js";
import { memoryTool } from "./core/tools/memory.js";
import { selfConfigTool } from "./core/tools/self-config.js";
import { SchedulerService } from "./core/tools/scheduler.js";
import { SchedulerStore } from "./core/tools/scheduler-store.js";
import { getDB } from "./core/memory/db.js";
import type { Channel } from "./channels/types.js";
import { sshTool } from "./core/tools/ssh.js";
import { npmInstallTool } from "./core/tools/npm-install.js";
import { SelfieTool } from "./core/tools/selfie.js";
import { ImageGenTool } from "./core/tools/image-gen.js";
import { SkillSearchTool } from "./core/tools/skill-search.js";
import { SkillInstallTool } from "./core/tools/skill-install.js";
import { SendFileTool } from "./core/tools/send-file.js";
import { ConnectServiceTool } from "./core/tools/connect-service.js";

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
        fallback_models: llmConfig.fallback_models,
      });
    } else {
      llm = new LLMRouter({
        provider: llmConfig.provider,
        api_key: llmConfig.api_key,
        fast_model: llmConfig.fast_model,
        strong_model: llmConfig.strong_model,
        fallback_models: llmConfig.fallback_models,
      });
    }
    console.log("✅ LLM подключён");
  }

  // Register tools
  const tools = new ToolRegistry();
  const schedulerDb = getDB();
  const schedulerStore = new SchedulerStore(schedulerDb);
  schedulerStore.init();
  const scheduler = new SchedulerService(schedulerStore);
  tools.register(new ShellTool());
  tools.register(new SendFileTool());
  tools.register(new FilesTool());
  tools.register(new HttpTool({ encryptionKey: config.security?.password_hash }));
  tools.register(new BrowserTool());
  tools.register(memoryTool);
  tools.register(selfConfigTool);
  tools.register(scheduler.tool);
  tools.register(sshTool);
  tools.register(npmInstallTool);
  const passwordHash = config.security?.password_hash ?? "default-key-change-me";
  tools.register(new ConnectServiceTool({ encryptionKey: passwordHash }));
  // Selfie tool — uses fal.ai key from selfies config, falls back to video config
  const selfiesConfig = config.selfies as Record<string, string> | undefined;
  const videoConfig = config.video as Record<string, string> | undefined;
  const selfieTool = new SelfieTool({
    falApiKey: selfiesConfig?.fal_api_key ?? videoConfig?.fal_api_key ?? "",
    referencePhotoUrl: selfiesConfig?.reference_photo_url,
  });
  tools.register(selfieTool);
  // Image generation tool — uses OpenRouter API key
  const llmApiKey = getLLMApiKey(config);
  if (llmApiKey) {
    tools.register(new ImageGenTool({ apiKey: llmApiKey }));
  }
  // SkillsMP tools — search and install agent skills
  const skillsmpKey = (config as any).skillsmp?.api_key as string | undefined;
  if (skillsmpKey) {
    tools.register(new SkillSearchTool({ apiKey: skillsmpKey }));
    tools.register(new SkillInstallTool({ apiKey: llmApiKey ?? undefined }));
  }
  // Web tool — conditional on google config
  const googleConfig = (config as any).google as { api_key: string; cx: string } | undefined;
  if (googleConfig?.api_key && googleConfig?.cx) {
    tools.register(new WebTool({ apiKey: googleConfig.api_key, cx: googleConfig.cx }));
  }
  console.log(`🔧 Зарегистрировано инструментов: ${tools.list().length}`);

  // Setup Engine with personality and tools
  const personality = getPersonality(config);
  const engine = llm ? new Engine({
    llm,
    config: {
      name,
      gender: config.agent?.gender ?? "female",
      personality: {
        tone: personality.tone,
        responseStyle: personality.style,
        customInstructions: personality.customInstructions,
      },
      personalitySliders: getPersonalitySliders(config),
      owner: config.owner,
    },
    tools,
    contextBudget: config.memory?.context_budget ?? 40000,
    encryptionKey: config.security?.password_hash,
  }) : null;

  // Start HTTP server
  const { server, wss } = createServer({ port, engine: engine ?? undefined });

  // Start Telegram channel
  let telegram: TelegramChannel | null = null;
  if (config.telegram?.token) {
    try {
      telegram = new TelegramChannel();
      telegram.onOwnerClaimed = (chatId) => {
        config.telegram!.owner_id = chatId;
        saveConfig(config);
        console.log(`🔒 Owner ID ${chatId} сохранён в конфиг`);
      };
      telegram.onSetReferencePhoto = (photoPath) => {
        selfieTool.setReferencePhoto(photoPath);
        console.log(`📸 Референсное фото обновлено: ${photoPath.slice(0, 60)}`);
      };
      telegram.onMessage(async (msg, onProgress) => {
        if (engine) {
          scheduler.setMessageContext(
            msg.channelName,
            msg.userId,
            engine.getHistory(msg.userId) ?? [],
          );
          return engine.process(msg, onProgress);
        }
        return { text: "LLM не настроен. Открой дашборд для настройки." };
      });
      await telegram.start({
        token: config.telegram.token,
        owner_chat_id: config.telegram.owner_id?.toString() ?? "",
      });
      // Load saved reference photo if exists and no URL in config
      const savedRef = path.join(os.homedir(), ".betsy", "reference.jpg");
      if (!selfieTool.config.referencePhotoUrl && fs.existsSync(savedRef)) {
        selfieTool.setReferencePhoto(savedRef);
        console.log("📸 Референсное фото загружено из ~/.betsy/reference.jpg");
      }
      console.log("✅ Telegram бот запущен");
    } catch (err) {
      console.error("❌ Telegram ошибка:", err instanceof Error ? err.message : err);
    }
  }

  const channels = new Map<string, Channel>();
  if (telegram) {
    channels.set("telegram", telegram);
  }

  if (engine) {
    scheduler.onTaskFire(async (task) => {
      const channel = channels.get(task.channel);
      if (!channel) {
        console.error(`Scheduler: channel "${task.channel}" not available for task "${task.name}"`);
        return;
      }

      const prompt = [
        `Сработало запланированное задание "${task.name}".`,
        `Задача: ${task.command}`,
        task.context ? `\nКонтекст разговора при создании задачи:\n${task.context}` : "",
        `\nНапиши владельцу сообщение в связи с этой задачей.`,
      ].join("\n");

      try {
        const result = await engine.process({
          channelName: task.channel,
          userId: task.chatId,
          text: prompt,
          timestamp: Date.now(),
          metadata: { scheduledTask: true },
        });
        await channel.send(task.chatId, result);
        console.log(`✅ Scheduler: delivered "${task.name}" to ${task.channel}:${task.chatId}`);
      } catch (err) {
        console.error(`❌ Scheduler: failed to deliver "${task.name}":`, err);
      }
    });

    await scheduler.recoverMissed();
    scheduler.start();
    console.log("✅ Планировщик запущен");
  }

  // Auto-open browser on local machine
  if (os.platform() !== "linux") {
    const { execFile: execFileCb } = await import("node:child_process");
    const opener = os.platform() === "darwin" ? "open" : os.platform() === "win32" ? "start" : "xdg-open";
    execFileCb(opener, [`http://localhost:${port}`], () => {});
  }

  setupShutdown(server, wss, scheduler, llm ?? undefined);
}

function setupShutdown(server: any, wss: any, scheduler?: SchedulerService, router?: LLMRouter) {
  const shutdown = () => {
    console.log("\nЗавершение работы...");
    scheduler?.stop();
    router?.destroy();
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
