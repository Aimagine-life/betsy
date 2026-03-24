import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolResult } from "./types.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB (Telegram bot limit)

export class SendFileTool implements Tool {
  name = "send_file";
  description =
    "Send a file from the server to the user in chat. Use after downloading or creating a file. Supports video, audio, images, and documents.";
  parameters = [
    { name: "path", type: "string", description: "Absolute path to the file on server", required: true },
    { name: "caption", type: "string", description: "Optional caption/message to send with the file", required: false },
  ];

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const filePath = String(params.path ?? "").trim();
    if (!filePath) {
      return { success: false, output: "Missing required parameter: path" };
    }

    if (!path.isAbsolute(filePath)) {
      return { success: false, output: "Path must be absolute" };
    }

    if (!fs.existsSync(filePath)) {
      return { success: false, output: `File not found: ${filePath}` };
    }

    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return { success: false, output: "Path is not a file" };
    }

    if (stats.size > MAX_FILE_SIZE) {
      const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
      return { success: false, output: `File too large: ${sizeMB} MB (max 50 MB for Telegram)` };
    }

    const caption = typeof params.caption === "string" ? params.caption.trim() : undefined;
    const sizeMB = (stats.size / 1024 / 1024).toFixed(1);

    return {
      success: true,
      output: caption || `File sent: ${path.basename(filePath)} (${sizeMB} MB)`,
      mediaPath: filePath,
    };
  }
}
