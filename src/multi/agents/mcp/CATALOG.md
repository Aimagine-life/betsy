# Built-in MCP Server Catalog

Эти серверы доступны из коробки Personal Betsy v2. Подключаются через
`connect_integration({id})` или из UI настроек workspace. Секреты никогда не
хранятся в этом каталоге: для OAuth-провайдеров токены подставляются рантайм-
резолвером из `OAuthRepo` (см. `oauth-resolver.ts`), а `envTemplate` задаёт
нечувствительные поля.

Источник истины — массив `BUILTIN_MCP_SERVERS` в `builtin.ts`. Этот файл —
человекочитаемое зеркало для удобства навигации.

## Готовые (production-ready)

| ID | Сервис | Категория | Пакет | Авторизация |
|----|--------|-----------|-------|-------------|
| `notion` | Notion | productivity | `@notionhq/notion-mcp-server` | OAuth (Notion) -> `NOTION_API_KEY` |
| `playwright` | Browser (Playwright) | browser | `@playwright/mcp@latest` | не требуется |
| `fs` | Filesystem | storage | `@modelcontextprotocol/server-filesystem` | локальный путь через `BC_FS_ROOT` |
| `github` | GitHub | dev | `@modelcontextprotocol/server-github` | OAuth (GitHub) -> `GITHUB_PERSONAL_ACCESS_TOKEN` |

## Экспериментальные (требуют верификации / wrapper)

| ID | Сервис | Категория | Пакет | Почему experimental |
|----|--------|-----------|-------|---------------------|
| `gcal` | Google Calendar | productivity | `@cocal/google-calendar-mcp` | Ждёт `GOOGLE_OAUTH_CREDENTIALS` (путь к файлу) и делает свой browser-flow. Нужна обёртка, материализующая наш `OAuthTokenRecord` в формат пакета. |
| `gmail` | Gmail | productivity | `@gongrzhe/server-gmail-autoauth-mcp` | Все изученные Gmail MCP-серверы либо делают свой OAuth, либо принимают токен per-call. Нужна обёртка для инъекции refreshed access_token. |
| `gdrive` | Google Drive | storage | `@isaacphi/mcp-gdrive` | Требует `CLIENT_ID`/`CLIENT_SECRET`/`GDRIVE_CREDS_DIR` и интерактивный браузер-логин. Та же стратегия обёртки, что и у `gcal`. |
| `slack` | Slack | productivity | `@modelcontextprotocol/server-slack` | Пакет готов и принимает `SLACK_BOT_TOKEN` через env, но у нас пока нет Slack OAuth relay провайдера — токен приходится вводить вручную. |

## Notes

- Трёх Google-провайдеров (`gcal`/`gmail`/`gdrive`) объединяет одна проблема:
  ни один из протестированных npm-пакетов не принимает готовый access_token
  через env. Решение — shim-процесс, который создаёт ожидаемый файл с
  credentials из нашего `OAuthRepo` перед запуском сервера. До реализации
  shim'а записи остаются `experimental: true`.
- `github` переведён в production-ready: официальный пакет консьюмит
  `GITHUB_PERSONAL_ACCESS_TOKEN` и совместим и с PAT, и с OAuth access_token
  из нашего relay.
- `slack` добавлен как experimental на уровне каталога: сам сервер стабилен,
  но OAuth relay для Slack ещё не реализован — см. polish3.
- Интерфейсы `BuiltinMcpServer` / `BuiltinMcpOAuth` стабильны; менять можно
  только содержимое массива.
