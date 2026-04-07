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
    notes: 'Verify package name and env-var contract before enabling in prod.',
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
    experimental: true,
    notes: 'Upstream package does its own OAuth dance — may need a wrapper that accepts injected tokens.',
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
    experimental: true,
    notes: 'Original @modelcontextprotocol/server-gdrive was archived; community fork as fallback.',
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
]

export function getBuiltinMcpServer(id: string): BuiltinMcpServer | undefined {
  return BUILTIN_MCP_SERVERS.find((s) => s.id === id)
}
