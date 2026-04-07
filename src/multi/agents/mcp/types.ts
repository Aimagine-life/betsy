/**
 * Types for the per-workspace MCP (Model Context Protocol) layer.
 *
 * SECURITY: McpServerConfig.env may contain OAuth tokens / API keys.
 * Never log env values; only log key names if needed.
 */

export type McpTransport = 'stdio' | 'sse' | 'http'

export interface McpServerConfig {
  /** DB row id (uuid). Optional for builtin/in-memory configs. */
  id?: string
  /** User-friendly name, unique per workspace. Used as tool prefix. */
  name: string
  transport: McpTransport
  /** stdio: executable command */
  command?: string
  /** stdio: arguments */
  args?: string[]
  /** stdio: env vars (may contain secrets) */
  env?: Record<string, string>
  /** sse / http: server URL */
  url?: string
  enabled: boolean
  /** Additional free-form config (timeouts, auth headers, etc.) */
  config?: Record<string, unknown>
}

/**
 * Tool metadata as exposed by an MCP server.
 * inputSchema is JSON Schema (draft-07-ish, as per MCP spec).
 */
export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  /** Concatenated text content blocks (best-effort). */
  text: string
  /** Whether the tool reported isError = true. */
  isError: boolean
  /** Raw structured content if returned. */
  structuredContent?: unknown
}
