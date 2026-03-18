import type { Tool, ToolResult } from "./types.js";
import { loadConfig, saveConfig, type BetsyConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Helpers for nested key access (e.g. "agent.gender", "memory.max_knowledge")
// ---------------------------------------------------------------------------

function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = keyPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
  const parts = keyPath.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === undefined || current[part] === null || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/** Try to parse value as number or boolean, otherwise keep as string */
function coerceValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  const num = Number(raw);
  if (!isNaN(num) && raw.trim() !== "") return num;
  return raw;
}

/** Flatten a nested object into dot-separated key paths for listing */
function flattenObject(obj: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool actions
// ---------------------------------------------------------------------------

function handleGet(params: Record<string, unknown>): ToolResult {
  const key = params.key;
  if (typeof key !== "string" || !key.trim()) {
    return { success: false, output: "Missing required parameter: key", error: "missing_param" };
  }
  const config = loadConfig();
  if (!config) {
    return { success: false, output: "Config file not found.", error: "no_config" };
  }
  const value = getNestedValue(config as unknown as Record<string, unknown>, key.trim());
  if (value === undefined) {
    return { success: true, output: `Key "${key.trim()}" is not set.` };
  }
  return { success: true, output: `${key.trim()}: ${JSON.stringify(value)}` };
}

function handleSet(params: Record<string, unknown>): ToolResult {
  const key = params.key;
  if (typeof key !== "string" || !key.trim()) {
    return { success: false, output: "Missing required parameter: key", error: "missing_param" };
  }
  const value = params.value;
  if (value === undefined || value === null) {
    return { success: false, output: "Missing required parameter: value", error: "missing_param" };
  }

  const config = loadConfig() ?? { agent: { name: "Betsy" } } as BetsyConfig;
  const coerced = typeof value === "string" ? coerceValue(value) : value;
  setNestedValue(config as unknown as Record<string, unknown>, key.trim(), coerced);
  saveConfig(config);
  return { success: true, output: `Set ${key.trim()} = ${JSON.stringify(coerced)}` };
}

function handleAppend(params: Record<string, unknown>): ToolResult {
  const key = params.key;
  if (typeof key !== "string" || !key.trim()) {
    return { success: false, output: "Missing required parameter: key", error: "missing_param" };
  }
  const value = params.value;
  if (value === undefined || value === null) {
    return { success: false, output: "Missing required parameter: value", error: "missing_param" };
  }

  const config = loadConfig() ?? { agent: { name: "Betsy" } } as BetsyConfig;
  const existing = getNestedValue(config as unknown as Record<string, unknown>, key.trim());
  const arr = Array.isArray(existing) ? existing : [];
  arr.push(typeof value === "string" ? value : String(value));
  setNestedValue(config as unknown as Record<string, unknown>, key.trim(), arr);
  saveConfig(config);
  return { success: true, output: `Appended "${value}" to ${key.trim()} (now ${arr.length} items)` };
}

function handleList(): ToolResult {
  const config = loadConfig();
  if (!config) {
    return { success: true, output: "Config is empty (no config file found)." };
  }
  const flat = flattenObject(config as unknown as Record<string, unknown>);
  const keys = Object.keys(flat);
  if (keys.length === 0) {
    return { success: true, output: "Config is empty." };
  }
  const lines = keys.map((k) => `- ${k}: ${JSON.stringify(flat[k])}`);
  return { success: true, output: `${keys.length} key(s):\n${lines.join("\n")}` };
}

export const selfConfigTool: Tool = {
  name: "self_config",
  description:
    "Read or write Betsy's own configuration stored in ~/.betsy/config.yaml. " +
    "Uses dot-notation for nested keys. " +
    "Key examples: agent.name, agent.gender (female/male/neutral), " +
    "agent.personality.tone, agent.personality.style, agent.personality.custom_instructions, " +
    "owner.name (owner's name), owner.facts (array of facts about owner). " +
    "action=get retrieves a single key, action=set writes a key-value pair, " +
    "action=list shows all configuration entries.",
  parameters: [
    { name: "action", type: "string", description: "One of: get, set, append, list. Use append to add items to array fields like owner.facts", required: true },
    { name: "key", type: "string", description: "Config key in dot-notation, e.g. agent.gender (required for get/set)" },
    { name: "value", type: "string", description: "Config value (required for set)" },
  ],

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action;
    if (typeof action !== "string" || !action.trim()) {
      return { success: false, output: "Missing required parameter: action", error: "missing_param" };
    }

    switch (action.trim()) {
      case "get":
        return handleGet(params);
      case "set":
        return handleSet(params);
      case "append":
        return handleAppend(params);
      case "list":
        return handleList();
      default:
        return {
          success: false,
          output: `Unknown action: ${action}. Use get, set, or list.`,
          error: "invalid_action",
        };
    }
  },
};
