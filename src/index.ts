import os from "node:os";
import { createServer } from "./server.js";
import { loadConfig, isConfigured } from "./config.js";
import { createLLMProvider } from "./llm/index.js";
import { createHeartbeat } from "./heartbeat.js";

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

  console.log("Betsy starting...");
  console.log(`Open in browser: http://${address}:${port}`);

  // Load config — if none exists, start in setup/wizard mode
  const config = isConfigured() ? loadConfig() : null;

  const { server, wss } = createServer({ port });

  // If already configured, start the engine + heartbeat
  if (config) {
    const llm = createLLMProvider(config.llm);
    const heartbeat = createHeartbeat(config, llm);
    heartbeat.start();
  }

  // Auto-open browser on local machine (skip on typical VPS/Linux servers)
  if (os.platform() !== "linux") {
    const { execFile: execFileCb } = await import("node:child_process");
    const opener =
      os.platform() === "darwin"
        ? "open"
        : os.platform() === "win32"
          ? "start"
          : "xdg-open";
    execFileCb(opener, [`http://localhost:${port}`], () => {});
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
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
