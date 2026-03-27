# Service Connector — Design Spec

**Date:** 2026-03-28
**Status:** Approved

## Overview

System for connecting Betsy to external services (Google, GitHub, VK, Yandex, Reddit, Mail.ru) with OAuth authentication, so non-technical users can say "подключи Google" and everything works automatically.

## Constraints

- Target audience: non-technical users
- Betsy will be packaged as a single .exe for Windows
- No Python dependencies, no external CLI tools
- All data stored in SQLite (already used by Betsy)
- Domain: betsyai.io, OAuth relay: auth.betsyai.io

## Architecture

Three components:

```
Betsy (.exe on user's machine)     auth.betsyai.io (relay)     Google/GitHub/VK
        │                               │                          │
        │  connect_service(google)      │                          │
        │──► POST /start/google ───────►│                          │
        │◄── { instance_id, auth_url } ◄│                          │
        │                               │                          │
        │  sends auth_url to user       │                          │
        │  user clicks, authorizes      │──► OAuth redirect ──────►│
        │                               │◄── callback + code ◄────│
        │                               │──► exchange code→token ─►│
        │                               │◄── access_token ◄──────│
        │                               │  stores token in RAM     │
        │  polls every 3s               │  (TTL 5 min)             │
        │──► GET /poll/:instance_id ───►│                          │
        │◄── { access_token, ... } ◄───│                          │
        │  saves token locally          │  deletes from RAM        │
        │                               │                          │
        │  user: "что в почте?"         │                          │
        │──► http + Bearer token ──────────────────────────────────►│
        │◄── API response ◄────────────────────────────────────────│
```

## Component 1: OAuth Relay (`auth.betsyai.io`)

Lightweight stateless Node.js server. Sole purpose: mediate OAuth flows.

### Endpoints

**`POST /start/:service`**
- Body: `{ scopes: ["gmail", "youtube"] }`
- Generates `instance_id` (crypto random UUID)
- Builds OAuth authorization URL with correct scopes
- Returns: `{ instance_id, auth_url }`
- Stores `{ instance_id, service, scopes, created_at }` in RAM

**`GET /callback/:service`**
- Receives OAuth callback from provider (code + state)
- Exchanges `code` for `access_token` + `refresh_token`
- Stores tokens in RAM keyed by `instance_id` (from OAuth state param)
- Returns HTML page: "Готово! Можешь закрыть это окно."
- TTL: 5 minutes, then tokens are deleted from RAM

**`GET /poll/:instance_id`**
- Returns `{ status: "pending" }` or `{ status: "complete", access_token, refresh_token, expires_in, scopes }`
- On successful poll: deletes tokens from RAM (one-time retrieval)
- After TTL expires: returns `{ status: "expired" }`

**`POST /refresh/:service`**
- Body: `{ refresh_token }`
- Uses stored client_secret to refresh the token
- Returns: `{ access_token, expires_in }`

### Configuration (on relay server)

```yaml
services:
  google:
    client_id: "..."
    client_secret: "..."
    auth_url: "https://accounts.google.com/o/oauth2/v2/auth"
    token_url: "https://oauth2.googleapis.com/token"
    scopes:
      gmail:
        - "https://www.googleapis.com/auth/gmail.readonly"
        - "https://www.googleapis.com/auth/gmail.send"
        - "https://www.googleapis.com/auth/gmail.modify"
      youtube:
        - "https://www.googleapis.com/auth/youtube.readonly"
        - "https://www.googleapis.com/auth/youtube.force-ssl"
      calendar:
        - "https://www.googleapis.com/auth/calendar"
        - "https://www.googleapis.com/auth/calendar.events"
      drive:
        - "https://www.googleapis.com/auth/drive"
        - "https://www.googleapis.com/auth/drive.file"
      contacts:
        - "https://www.googleapis.com/auth/contacts.readonly"
  github:
    client_id: "..."
    client_secret: "..."
    auth_url: "https://github.com/login/oauth/authorize"
    token_url: "https://github.com/login/oauth/access_token"
    scopes:
      default: ["repo", "user"]
  vk:
    client_id: "..."
    client_secret: "..."
    auth_url: "https://oauth.vk.com/authorize"
    token_url: "https://oauth.vk.com/access_token"
    scopes:
      default: ["messages", "wall", "friends", "photos"]
  yandex:
    client_id: "..."
    client_secret: "..."
    auth_url: "https://oauth.yandex.ru/authorize"
    token_url: "https://oauth.yandex.ru/token"
    scopes:
      mail: ["mail:imap_full"]
      disk: ["cloud_api:disk.read", "cloud_api:disk.write"]
  reddit:
    client_id: "..."
    client_secret: "..."
    auth_url: "https://www.reddit.com/api/v1/authorize"
    token_url: "https://www.reddit.com/api/v1/access_token"
    scopes:
      default: ["read", "identity", "mysubreddits"]
  mailru:
    client_id: "..."
    client_secret: "..."
    auth_url: "https://oauth.mail.ru/login"
    token_url: "https://oauth.mail.ru/token"
    scopes:
      default: ["userinfo", "mail.imap"]
```

### What relay does NOT store
- No user tokens on disk. Received → forwarded → deleted from RAM.
- No database. Fully stateless.
- No user data, no analytics, no logs of tokens.

### Security
- `instance_id`: cryptographically random 128-bit UUID
- Tokens delivered exactly once per `instance_id`
- HTTPS required
- Tokens passed via POST body, never in URL parameters
- 5-minute TTL on pending tokens

### Stack
- Node.js + raw http (consistent with Betsy's approach)
- Single file, ~300 lines
- Deployed on same VPS as betsyai.io or separate lightweight instance

## Component 2: Service Registry (inside Betsy)

### Service Catalog (`src/services/catalog.ts`)

Static array of service definitions, bundled into the exe.

```typescript
interface ServiceAction {
  name: string;          // "list_messages"
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;          // "/gmail/v1/users/me/messages"
  description: string;   // "Получить список писем"
}

interface ServiceDefinition {
  id: string;                              // "google"
  name: string;                            // "Google"
  description: string;                     // "Почта, YouTube, Календарь, Диск"
  relayUrl: string;                        // "https://auth.betsyai.io"
  scopes: Record<string, string>;          // { gmail: "Почта", youtube: "YouTube", ... }
  baseUrls: Record<string, string>;        // { gmail: "https://gmail.googleapis.com", ... }
  actions: Record<string, ServiceAction[]>;// { gmail: [...], youtube: [...] }
}
```

Actions contain 10-20 most common operations per service — reliable, typed endpoints. Not full API documentation, but enough for Betsy's LLM to make correct HTTP requests.

### Token Storage (SQLite)

```sql
CREATE TABLE service_tokens (
  service_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  access_token  TEXT NOT NULL,    -- encrypted with security.password_hash
  refresh_token TEXT,             -- encrypted
  scopes        TEXT,             -- "gmail,youtube,calendar"
  expires_at    INTEGER,          -- unix timestamp
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (service_id, user_id)
);
```

Encryption: AES-256-GCM using key derived from `security.password_hash` in config. Uses `node:crypto` (already available, no new dependencies).

### Auto-refresh logic

When Betsy makes an API request to a connected service:
1. Get token from `service_tokens`
2. If `expires_at` < now + 5min → refresh via relay `POST /refresh/:service`
3. Update token in DB
4. Make the API request with fresh token
5. If 401 anyway → try refresh once more → if still fails, tell user to reconnect

## Component 3: `connect_service` Tool

Single new tool registered in ToolRegistry.

```typescript
name: "connect_service"
description: "Подключение и управление внешними сервисами (Google, GitHub, VK и др.)"
parameters: [
  { name: "action", type: "string", description: "list | connect | disconnect | status", required: true },
  { name: "service", type: "string", description: "ID сервиса: google, github, vk, yandex, reddit, mailru" },
  { name: "scopes", type: "string", description: "Части сервиса через запятую: gmail,youtube,calendar" },
]
```

**Actions:**
- `list` — returns available services from catalog with connection status
- `connect` — initiates OAuth flow: POST to relay /start, returns auth_url, starts polling
- `disconnect` — deletes tokens for service from DB
- `status` — shows which services are connected and with which scopes

**Polling behavior:**
- After generating auth_url, Betsy polls relay every 3 seconds
- Timeout: 5 minutes
- On success: saves tokens, returns "Подключено!"
- On timeout: returns "Авторизация не завершена. Попробовать ещё раз? Я скину новую ссылку."

## Component 4: Installed Skills with Vector Search

### Schema

```sql
CREATE TABLE installed_skills (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id   TEXT,               -- "google", "github", NULL for general
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  content      TEXT NOT NULL,      -- full SKILL.md text
  embedding    BLOB,               -- float32 vector from embedding API
  source_url   TEXT,               -- SkillsMP GitHub URL
  installed_at INTEGER NOT NULL
);
```

### Embedding generation
- On skill install: send `name + " " + description` to embedding API via OpenRouter
- Store resulting vector as BLOB (Float32Array → Buffer)
- Model: `openai/text-embedding-3-small` via OpenRouter (1536 dimensions, ~6KB per vector, cheapest option)

### Search flow
1. User message → generate embedding for the query
2. Cosine similarity against all installed_skills embeddings
3. If `service_id` is known from context → filter to that service first
4. Return top 3 matches by similarity score
5. Inject full `content` of matched skills into LLM context

### Limits
- Max 20 skills per service
- Max 200 skills total
- On overflow: Betsy suggests removing unused skills

## User Flows

### Flow 1: First connection
```
User: "Подключи мне Google"
Betsy: → connect_service(connect, google, "gmail,youtube,calendar,drive")
       → POST auth.betsyai.io/start/google
       → sends auth_url to user: "Перейди по ссылке и разреши доступ 👉 [link]"
       → polls /poll/:instance_id every 3s
       → receives tokens → saves to DB
       → "Отлично, Google подключён! Мне доступны почта, YouTube, календарь и диск."
```

### Flow 2: Simple request (built-in actions)
```
User: "Что у меня в почте?"
Betsy: → checks service_tokens: Google connected ✓
       → finds action gmail.list_messages from catalog
       → http GET https://gmail.googleapis.com/gmail/v1/users/me/messages
         Authorization: Bearer {token}
       → parses response, fetches top 5 message details
       → "У тебя 3 непрочитанных: ..."
```

### Flow 3: Complex request (needs skill)
```
User: "Каждое утро присылай сводку почты"
Betsy: → searches installed_skills by vector: no match
       → searches SkillsMP: "gmail daily summary" → found
       → installs skill: downloads SKILL.md, generates embedding, saves to DB
       → follows skill instructions
       → creates scheduler task: cron "0 8 * * *"
       → "Готово! Каждый день в 8 утра пришлю сводку."
```

### Flow 4: Token expired
```
User: "Проверь почту"
Betsy: → http GET Gmail API → 401
       → POST auth.betsyai.io/refresh/google with refresh_token
       → receives new access_token → updates DB
       → retries request → success
       → "У тебя 2 новых письма..."

If refresh also fails:
       → "Доступ к Google слетел. Перейди по ссылке чтобы переподключить 👉 [link]"
```

### Flow 5: Auth timeout
```
Betsy: → sends auth_url to user
       → polls for 5 minutes → no response
       → "Не получилось подключить Google — авторизация не была завершена.
          Давай попробуем ещё раз? Я скину новую ссылку."
```

### Flow 6: Connection status
```
User: "Что подключено?"
Betsy: → connect_service(status)
       → "Подключено: Google (почта, YouTube, календарь, диск), GitHub
          Не подключено: VK, Yandex, Reddit, Mail.ru
          Что-нибудь подключить?"
```

## Files to Create/Modify

### New files:
- `src/services/catalog.ts` — service definitions with actions
- `src/services/tokens.ts` — token storage, encryption, auto-refresh
- `src/services/embeddings.ts` — vector embedding generation + cosine similarity search
- `src/core/tools/connect-service.ts` — the connect_service tool
- `src/core/memory/skills.ts` — installed_skills table, CRUD, vector search
- `auth-relay/` — separate directory for the relay server
  - `auth-relay/server.ts` — relay HTTP server
  - `auth-relay/config.yaml` — OAuth client credentials (gitignored)
  - `auth-relay/config.example.yaml` — example config
  - `auth-relay/package.json` — minimal dependencies

### Modified files:
- `src/core/memory/db.ts` — add `service_tokens` and `installed_skills` table migrations
- `src/index.ts` — register `connect_service` tool
- `src/core/tools/http.ts` — auto-inject auth headers when service token is available
- `src/core/tools/skill-install.ts` — save to `installed_skills` instead of `knowledge`, generate embedding
- `src/core/engine.ts` — search `installed_skills` for context injection alongside knowledge

## What's Deferred (v2+)

- E2E encryption of tokens through relay
- Auto-update mechanism for exe
- Typed SDK-style adapters per service (replacing generic http + actions)
- Skill version checking and auto-updates
- Device flow as alternative to relay for services that support it
- Additional services beyond initial 6 (Discord, Spotify, Todoist, Twitter/X)
- Offline skill bundling in exe

## Services for v1

| Service | OAuth Provider | Key Features |
|---------|---------------|--------------|
| Google  | Google Cloud Console | Gmail, YouTube, Calendar, Drive, Contacts |
| GitHub  | GitHub OAuth Apps | Repos, Issues, PRs, User |
| VK      | VK Dev | Messages, Wall, Friends, Photos |
| Yandex  | Yandex OAuth | Mail, Disk |
| Reddit  | Reddit Apps | Read, Identity, Subreddits |
| Mail.ru | Mail.ru OAuth | Userinfo, IMAP |
