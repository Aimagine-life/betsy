/**
 * Declarative catalog of well-known MCP servers users can attach to a workspace.
 *
 * This is NOT auto-installed — the settings UI surfaces these entries so users
 * opt in explicitly. Secrets are never stored here: for OAuth providers the
 * oauth spec plus the per-workspace OAuthRepo produce env vars at startup time
 * (see `oauth-resolver.ts`). For plain envs, `envTemplate` documents them.
 */

export type BuiltinMcpCategory = 'productivity' | 'browser' | 'storage' | 'dev' | 'other'

export interface BuiltinMcpOAuth {
  provider: 'google' | 'notion' | 'github'
  scopes: string[]
  /** Map of MCP-server env var name → field name from OAuthTokenRecord */
  envMap: Record<string, 'access_token' | 'refresh_token' | 'expires_at' | 'account_label'>
}

export interface BuiltinMcpServer {
  id: string
  name: string
  description: string
  category: BuiltinMcpCategory
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  /** Static envs (not secrets — paths, modes). Secrets come via oauth resolver. */
  envTemplate?: Record<string, string>
  oauth?: BuiltinMcpOAuth
  docsUrl?: string
  /** If true, this entry is a stub: package name not verified working with token injection. */
  experimental?: boolean
  /** Free-form notes for UI / future devs. */
  notes?: string
}

export const BUILTIN_MCP_SERVERS: BuiltinMcpServer[] = [
  {
    id: 'gcal',
    name: 'Google Calendar',
    description: 'Чтение и создание событий, поиск свободного времени.',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@cocal/google-calendar-mcp'],
    oauth: {
      provider: 'google',
      scopes: ['https://www.googleapis.com/auth/calendar'],
      envMap: {
        GOOGLE_OAUTH_ACCESS_TOKEN: 'access_token',
        GOOGLE_OAUTH_REFRESH_TOKEN: 'refresh_token',
      },
    },
    docsUrl: 'https://github.com/nspady/google-calendar-mcp',
    experimental: true,
    notes:
      'Upstream @cocal/google-calendar-mcp expects GOOGLE_OAUTH_CREDENTIALS pointing to a gcp-oauth.keys.json file and performs its own browser auth — it does NOT consume a pre-issued access token via env. Needs a thin wrapper that materialises our OAuthTokenRecord into the file format before process start, or a fork accepting GOOGLE_OAUTH_ACCESS_TOKEN directly.',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Чтение писем, черновики, поиск.',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
    oauth: {
      provider: 'google',
      scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.modify',
      ],
      envMap: {
        GMAIL_ACCESS_TOKEN: 'access_token',
        GMAIL_REFRESH_TOKEN: 'refresh_token',
      },
    },
    docsUrl: 'https://github.com/GongRzhe/Gmail-MCP-Server',
    experimental: true,
    notes:
      'All audited Gmail MCP servers either run their own browser OAuth dance (@gongrzhe/server-gmail-autoauth-mcp) or expect credentials to be passed per tool-call rather than via env (baryhuang/mcp-headless-gmail, @peakmojo/mcp-server-headless-gmail). Until we ship a wrapper that injects our refreshed access_token into the package-specific credential file, this entry stays experimental.',
  },
  {
    id: 'gdrive',
    name: 'Google Drive',
    description: 'Список файлов, чтение содержимого.',
    category: 'storage',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@isaacphi/mcp-gdrive'],
    oauth: {
      provider: 'google',
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      envMap: { GDRIVE_ACCESS_TOKEN: 'access_token' },
    },
    docsUrl: 'https://github.com/isaacphi/mcp-gdrive',
    experimental: true,
    notes:
      'Original @modelcontextprotocol/server-gdrive was archived. Community fork @isaacphi/mcp-gdrive requires CLIENT_ID, CLIENT_SECRET and a writable GDRIVE_CREDS_DIR and triggers an interactive browser login on first use — it does not accept a pre-issued access token. Same wrapper strategy as gcal is required before this can run headless.',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Поиск и чтение страниц, создание заметок.',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    oauth: {
      provider: 'notion',
      scopes: [],
      envMap: { NOTION_API_KEY: 'access_token' },
    },
  },
  {
    id: 'playwright',
    name: 'Browser (Playwright)',
    description: 'Открыть страницу, заполнить форму, кликнуть, сделать скриншот.',
    category: 'browser',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    notes: 'No OAuth required.',
  },
  {
    id: 'fs',
    name: 'Filesystem',
    description: 'Чтение/запись файлов в выбранной папке.',
    category: 'storage',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    envTemplate: {
      BC_FS_ROOT: 'Корневая папка для доступа (абсолютный путь). Передайте её также как последний аргумент команды через UI.',
    },
    notes: 'Filesystem path is added to args at workspace-config time, not here.',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Issues, pull requests, репозитории, поиск кода.',
    category: 'dev',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    oauth: {
      provider: 'github',
      scopes: ['repo', 'read:user'],
      envMap: { GITHUB_PERSONAL_ACCESS_TOKEN: 'access_token' },
    },
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    notes:
      'Official MCP server, consumes GITHUB_PERSONAL_ACCESS_TOKEN via env. Works with either a PAT or an OAuth access_token from our relay.',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Каналы, сообщения, история, реакции.',
    category: 'productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    envTemplate: {
      SLACK_TEAM_ID: 'ID рабочего пространства Slack (начинается на T...).',
      SLACK_BOT_TOKEN: 'Bot User OAuth Token (xoxb-...). В multi-режиме подставляется из OAuth relay.',
    },
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
    experimental: true,
    notes:
      'Official package consumes SLACK_BOT_TOKEN + SLACK_TEAM_ID via env. Marked experimental because we do not yet have a Slack OAuth relay provider — user must paste a bot token manually through envTemplate.',
  },
]

export function getBuiltinMcpServer(id: string): BuiltinMcpServer | undefined {
  return BUILTIN_MCP_SERVERS.find((s) => s.id === id)
}
