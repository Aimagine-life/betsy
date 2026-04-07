/**
 * Catalog of well-known MCP servers users can attach to their workspace.
 *
 * NOT auto-installed — this is a static catalog the future settings UI
 * will surface to let users opt in. Each entry is a template; the user
 * still has to provide secrets (env vars) when enabling.
 */
import type { McpServerConfig } from './types.js'

export interface BuiltinMcpServer {
  /** Stable id for the catalog UI. */
  id: string
  title: string
  description: string
  /** Template — `enabled: false` so it isn't activated by default. */
  template: Omit<McpServerConfig, 'id'>
  /** Names of env vars the user must supply (no values shipped). */
  requiredEnv?: string[]
}

export const BUILTIN_MCP_SERVERS: BuiltinMcpServer[] = [
  // Examples — kept commented so we don't accidentally ship a working default.
  //
  // {
  //   id: 'filesystem',
  //   title: 'Filesystem',
  //   description: 'Read/write files in a sandboxed directory.',
  //   template: {
  //     name: 'filesystem',
  //     transport: 'stdio',
  //     command: 'npx',
  //     args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/betsy-sandbox'],
  //     enabled: false,
  //   },
  // },
  // {
  //   id: 'fetch',
  //   title: 'Fetch',
  //   description: 'Fetch arbitrary URLs as text/markdown.',
  //   template: {
  //     name: 'fetch',
  //     transport: 'stdio',
  //     command: 'npx',
  //     args: ['-y', '@modelcontextprotocol/server-fetch'],
  //     enabled: false,
  //   },
  // },
  // {
  //   id: 'playwright',
  //   title: 'Playwright',
  //   description: 'Headless browser automation.',
  //   template: {
  //     name: 'playwright',
  //     transport: 'stdio',
  //     command: 'npx',
  //     args: ['-y', '@playwright/mcp'],
  //     enabled: false,
  //   },
  // },
]
