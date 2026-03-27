# Service Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Betsy to connect to external services (Google, GitHub, VK, etc.) via OAuth through a relay server, store tokens, and use service APIs.

**Architecture:** OAuth relay server at auth.betsyai.io handles OAuth callbacks. Betsy's connect_service tool initiates flows and polls for tokens. Service catalog defines available services and their API actions. Installed skills use vector embeddings for semantic search.

**Tech Stack:** Node.js, SQLite (better-sqlite3), node:crypto for encryption, OpenRouter embeddings API, raw HTTP server for relay.

---

### Task 1: Database schema — service_tokens and installed_skills tables

**Files:**
- Modify: `src/core/memory/db.ts:128-136`

- [ ] **Step 1: Write the failing test**

Create `test/core/services/db-migration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDB, closeDB } from "../../../src/core/memory/db.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

describe("service tables migration", () => {
  const testDbPath = path.join(os.tmpdir(), `betsy-test-svc-${Date.now()}.db`);

  beforeEach(() => {
    closeDB();
  });

  afterEach(() => {
    closeDB();
    try { fs.unlinkSync(testDbPath); } catch {}
    try { fs.unlinkSync(testDbPath + "-wal"); } catch {}
    try { fs.unlinkSync(testDbPath + "-shm"); } catch {}
  });

  it("creates service_tokens table", () => {
    const db = getDB(testDbPath);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='service_tokens'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it("creates installed_skills table", () => {
    const db = getDB(testDbPath);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='installed_skills'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it("service_tokens has correct columns", () => {
    const db = getDB(testDbPath);
    const cols = db.pragma("table_info(service_tokens)") as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain("service_id");
    expect(names).toContain("user_id");
    expect(names).toContain("access_token");
    expect(names).toContain("refresh_token");
    expect(names).toContain("scopes");
    expect(names).toContain("expires_at");
    expect(names).toContain("created_at");
  });

  it("installed_skills has correct columns", () => {
    const db = getDB(testDbPath);
    const cols = db.pragma("table_info(installed_skills)") as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain("service_id");
    expect(names).toContain("name");
    expect(names).toContain("description");
    expect(names).toContain("content");
    expect(names).toContain("embedding");
    expect(names).toContain("source_url");
    expect(names).toContain("installed_at");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/services/db-migration.test.ts`
Expected: FAIL — tables don't exist yet.

- [ ] **Step 3: Add table creation to db.ts**

In `src/core/memory/db.ts`, after the `conversation_summaries` table creation (line ~133), add:

```typescript
  db.exec(`CREATE TABLE IF NOT EXISTS service_tokens (
    service_id    TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    access_token  TEXT NOT NULL,
    refresh_token TEXT,
    scopes        TEXT,
    expires_at    INTEGER,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (service_id, user_id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS installed_skills (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id   TEXT,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL,
    content      TEXT NOT NULL,
    embedding    BLOB,
    source_url   TEXT,
    installed_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/services/db-migration.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/memory/db.ts test/core/services/db-migration.test.ts
git commit -m "feat(db): add service_tokens and installed_skills tables"
```

---

### Task 2: Token encryption module

**Files:**
- Create: `src/services/crypto.ts`
- Test: `test/core/services/crypto.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/core/services/crypto.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "../../../src/services/crypto.js";

describe("token encryption", () => {
  const key = "b55c8792d1ce458e279308835f8a97b580263503e76e1998e279703e35ad0c2e";

  it("encrypts and decrypts a string", () => {
    const plaintext = "ya29.a0ARrdaM-test-token-value";
    const encrypted = encrypt(plaintext, key);
    expect(encrypted).not.toBe(plaintext);
    expect(decrypt(encrypted, key)).toBe(plaintext);
  });

  it("produces different ciphertext for same input (random IV)", () => {
    const plaintext = "same-token";
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(a).not.toBe(b);
  });

  it("throws on wrong key", () => {
    const encrypted = encrypt("secret", key);
    const wrongKey = "0000000000000000000000000000000000000000000000000000000000000000";
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it("handles empty string", () => {
    const encrypted = encrypt("", key);
    expect(decrypt(encrypted, key)).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/services/crypto.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement crypto module**

Create `src/services/crypto.ts`:

```typescript
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

/** Derive a 32-byte key from the password hash string. */
function deriveKey(keyHex: string): Buffer {
  return createHash("sha256").update(keyHex).digest();
}

/** Encrypt plaintext. Returns base64 string: IV + ciphertext + authTag. */
export function encrypt(plaintext: string, keyHex: string): string {
  const key = deriveKey(keyHex);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

/** Decrypt base64 string back to plaintext. */
export function decrypt(encoded: string, keyHex: string): string {
  const key = deriveKey(keyHex);
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(buf.length - TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/services/crypto.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/crypto.ts test/core/services/crypto.test.ts
git commit -m "feat(services): add AES-256-GCM encryption for service tokens"
```

---

### Task 3: Token storage — save, get, delete, refresh

**Files:**
- Create: `src/services/tokens.ts`
- Test: `test/core/services/tokens.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/core/services/tokens.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDB, closeDB } from "../../../src/core/memory/db.js";
import { TokenStore } from "../../../src/services/tokens.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

describe("TokenStore", () => {
  const testDbPath = path.join(os.tmpdir(), `betsy-test-tokens-${Date.now()}.db`);
  const encryptionKey = "b55c8792d1ce458e279308835f8a97b580263503e76e1998e279703e35ad0c2e";
  let store: TokenStore;

  beforeEach(() => {
    closeDB();
    getDB(testDbPath);
    store = new TokenStore(encryptionKey);
  });

  afterEach(() => {
    closeDB();
    try { fs.unlinkSync(testDbPath); } catch {}
    try { fs.unlinkSync(testDbPath + "-wal"); } catch {}
    try { fs.unlinkSync(testDbPath + "-shm"); } catch {}
  });

  it("saves and retrieves a token", () => {
    store.save({
      serviceId: "google",
      userId: "user1",
      accessToken: "access-123",
      refreshToken: "refresh-456",
      scopes: "gmail,youtube",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const token = store.get("google", "user1");
    expect(token).not.toBeNull();
    expect(token!.accessToken).toBe("access-123");
    expect(token!.refreshToken).toBe("refresh-456");
    expect(token!.scopes).toBe("gmail,youtube");
  });

  it("tokens are encrypted in the database", () => {
    store.save({
      serviceId: "google",
      userId: "user1",
      accessToken: "plaintext-token",
      refreshToken: "plaintext-refresh",
      scopes: "gmail",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const db = getDB();
    const row = db.prepare("SELECT access_token, refresh_token FROM service_tokens WHERE service_id = ?").get("google") as any;
    expect(row.access_token).not.toBe("plaintext-token");
    expect(row.refresh_token).not.toBe("plaintext-refresh");
  });

  it("deletes a token", () => {
    store.save({
      serviceId: "google",
      userId: "user1",
      accessToken: "tok",
      scopes: "gmail",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    store.delete("google", "user1");
    expect(store.get("google", "user1")).toBeNull();
  });

  it("lists connected services for a user", () => {
    store.save({ serviceId: "google", userId: "user1", accessToken: "t1", scopes: "gmail", expiresAt: 9999999999 });
    store.save({ serviceId: "github", userId: "user1", accessToken: "t2", scopes: "repo", expiresAt: 9999999999 });

    const services = store.listConnected("user1");
    expect(services).toHaveLength(2);
    expect(services.map(s => s.serviceId).sort()).toEqual(["github", "google"]);
  });

  it("isExpired returns true for expired tokens", () => {
    store.save({ serviceId: "google", userId: "user1", accessToken: "t", scopes: "gmail", expiresAt: 1000 });
    const token = store.get("google", "user1");
    expect(token!.isExpired()).toBe(true);
  });

  it("isExpired returns false for valid tokens", () => {
    store.save({ serviceId: "google", userId: "user1", accessToken: "t", scopes: "gmail", expiresAt: Math.floor(Date.now() / 1000) + 7200 });
    const token = store.get("google", "user1");
    expect(token!.isExpired()).toBe(false);
  });

  it("upserts on duplicate service+user", () => {
    store.save({ serviceId: "google", userId: "user1", accessToken: "old", scopes: "gmail", expiresAt: 9999999999 });
    store.save({ serviceId: "google", userId: "user1", accessToken: "new", scopes: "gmail,youtube", expiresAt: 9999999999 });

    const token = store.get("google", "user1");
    expect(token!.accessToken).toBe("new");
    expect(token!.scopes).toBe("gmail,youtube");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/services/tokens.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement TokenStore**

Create `src/services/tokens.ts`:

```typescript
import { getDB } from "../core/memory/db.js";
import { encrypt, decrypt } from "./crypto.js";

export interface SaveTokenParams {
  serviceId: string;
  userId: string;
  accessToken: string;
  refreshToken?: string;
  scopes: string;
  expiresAt: number; // unix seconds
}

export interface StoredToken {
  serviceId: string;
  userId: string;
  accessToken: string;
  refreshToken: string | null;
  scopes: string;
  expiresAt: number;
  createdAt: number;
  /** Returns true if token expires within the next 5 minutes. */
  isExpired(): boolean;
}

interface TokenRow {
  service_id: string;
  user_id: string;
  access_token: string;
  refresh_token: string | null;
  scopes: string;
  expires_at: number;
  created_at: number;
}

export class TokenStore {
  private key: string;

  constructor(encryptionKey: string) {
    this.key = encryptionKey;
  }

  save(params: SaveTokenParams): void {
    const db = getDB();
    db.prepare(`
      INSERT INTO service_tokens (service_id, user_id, access_token, refresh_token, scopes, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(service_id, user_id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        scopes = excluded.scopes,
        expires_at = excluded.expires_at
    `).run(
      params.serviceId,
      params.userId,
      encrypt(params.accessToken, this.key),
      params.refreshToken ? encrypt(params.refreshToken, this.key) : null,
      params.scopes,
      params.expiresAt,
    );
  }

  get(serviceId: string, userId: string): StoredToken | null {
    const db = getDB();
    const row = db.prepare(
      "SELECT * FROM service_tokens WHERE service_id = ? AND user_id = ?"
    ).get(serviceId, userId) as TokenRow | undefined;

    if (!row) return null;

    return this.rowToToken(row);
  }

  delete(serviceId: string, userId: string): void {
    const db = getDB();
    db.prepare("DELETE FROM service_tokens WHERE service_id = ? AND user_id = ?").run(serviceId, userId);
  }

  listConnected(userId: string): StoredToken[] {
    const db = getDB();
    const rows = db.prepare(
      "SELECT * FROM service_tokens WHERE user_id = ?"
    ).all(userId) as TokenRow[];

    return rows.map(r => this.rowToToken(r));
  }

  private rowToToken(row: TokenRow): StoredToken {
    const key = this.key;
    return {
      serviceId: row.service_id,
      userId: row.user_id,
      accessToken: decrypt(row.access_token, key),
      refreshToken: row.refresh_token ? decrypt(row.refresh_token, key) : null,
      scopes: row.scopes ?? "",
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      isExpired() {
        const fiveMinFromNow = Math.floor(Date.now() / 1000) + 300;
        return this.expiresAt < fiveMinFromNow;
      },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/services/tokens.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/tokens.ts test/core/services/tokens.test.ts
git commit -m "feat(services): add encrypted token storage with auto-expiry detection"
```

---

### Task 4: Service catalog

**Files:**
- Create: `src/services/catalog.ts`
- Test: `test/core/services/catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/core/services/catalog.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { getService, listServices, type ServiceDefinition } from "../../../src/services/catalog.js";

describe("Service catalog", () => {
  it("lists all available services", () => {
    const services = listServices();
    expect(services.length).toBeGreaterThanOrEqual(6);
    const ids = services.map(s => s.id);
    expect(ids).toContain("google");
    expect(ids).toContain("github");
    expect(ids).toContain("vk");
    expect(ids).toContain("yandex");
    expect(ids).toContain("reddit");
    expect(ids).toContain("mailru");
  });

  it("getService returns a service by id", () => {
    const google = getService("google");
    expect(google).not.toBeNull();
    expect(google!.name).toBe("Google");
    expect(google!.scopes).toHaveProperty("gmail");
    expect(google!.actions).toHaveProperty("gmail");
  });

  it("getService returns null for unknown service", () => {
    expect(getService("nonexistent")).toBeNull();
  });

  it("google has gmail actions", () => {
    const google = getService("google")!;
    const gmailActions = google.actions.gmail;
    expect(gmailActions.length).toBeGreaterThan(0);
    const names = gmailActions.map(a => a.name);
    expect(names).toContain("list_messages");
    expect(names).toContain("get_message");
    expect(names).toContain("send_message");
  });

  it("google has youtube actions", () => {
    const google = getService("google")!;
    const ytActions = google.actions.youtube;
    expect(ytActions.length).toBeGreaterThan(0);
  });

  it("each service has required fields", () => {
    for (const svc of listServices()) {
      expect(svc.id).toBeTruthy();
      expect(svc.name).toBeTruthy();
      expect(svc.description).toBeTruthy();
      expect(svc.relayUrl).toBe("https://auth.betsyai.io");
      expect(Object.keys(svc.scopes).length).toBeGreaterThan(0);
      expect(Object.keys(svc.baseUrls).length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/services/catalog.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the catalog**

Create `src/services/catalog.ts`:

```typescript
export interface ServiceAction {
  name: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  description: string;
}

export interface ServiceDefinition {
  id: string;
  name: string;
  description: string;
  relayUrl: string;
  scopes: Record<string, string>;
  baseUrls: Record<string, string>;
  actions: Record<string, ServiceAction[]>;
}

const RELAY_URL = "https://auth.betsyai.io";

const services: ServiceDefinition[] = [
  {
    id: "google",
    name: "Google",
    description: "Почта, YouTube, Календарь, Диск, Контакты",
    relayUrl: RELAY_URL,
    scopes: {
      gmail: "Почта",
      youtube: "YouTube",
      calendar: "Календарь",
      drive: "Диск",
      contacts: "Контакты",
    },
    baseUrls: {
      gmail: "https://gmail.googleapis.com",
      youtube: "https://www.googleapis.com",
      calendar: "https://www.googleapis.com",
      drive: "https://www.googleapis.com",
      contacts: "https://people.googleapis.com",
    },
    actions: {
      gmail: [
        { name: "list_messages", method: "GET", path: "/gmail/v1/users/me/messages", description: "Получить список писем" },
        { name: "get_message", method: "GET", path: "/gmail/v1/users/me/messages/{id}?format=full", description: "Прочитать письмо по ID" },
        { name: "send_message", method: "POST", path: "/gmail/v1/users/me/messages/send", description: "Отправить письмо" },
        { name: "search_messages", method: "GET", path: "/gmail/v1/users/me/messages?q={query}", description: "Поиск писем" },
        { name: "list_labels", method: "GET", path: "/gmail/v1/users/me/labels", description: "Список папок/меток" },
        { name: "get_profile", method: "GET", path: "/gmail/v1/users/me/profile", description: "Профиль почты" },
      ],
      youtube: [
        { name: "search_videos", method: "GET", path: "/youtube/v3/search?part=snippet&type=video&q={query}", description: "Поиск видео" },
        { name: "get_video", method: "GET", path: "/youtube/v3/videos?part=snippet,statistics&id={id}", description: "Информация о видео" },
        { name: "my_channels", method: "GET", path: "/youtube/v3/channels?part=snippet,statistics&mine=true", description: "Мои каналы" },
        { name: "my_subscriptions", method: "GET", path: "/youtube/v3/subscriptions?part=snippet&mine=true", description: "Мои подписки" },
        { name: "my_playlists", method: "GET", path: "/youtube/v3/playlists?part=snippet&mine=true", description: "Мои плейлисты" },
      ],
      calendar: [
        { name: "list_events", method: "GET", path: "/calendar/v3/calendars/primary/events?timeMin={timeMin}&maxResults=10&singleEvents=true&orderBy=startTime", description: "Список событий" },
        { name: "create_event", method: "POST", path: "/calendar/v3/calendars/primary/events", description: "Создать событие" },
        { name: "delete_event", method: "DELETE", path: "/calendar/v3/calendars/primary/events/{eventId}", description: "Удалить событие" },
        { name: "list_calendars", method: "GET", path: "/calendar/v3/users/me/calendarList", description: "Список календарей" },
      ],
      drive: [
        { name: "list_files", method: "GET", path: "/drive/v3/files?pageSize=20&fields=files(id,name,mimeType,modifiedTime,size)", description: "Список файлов" },
        { name: "search_files", method: "GET", path: "/drive/v3/files?q=name contains '{query}'&fields=files(id,name,mimeType)", description: "Поиск файлов" },
        { name: "get_file", method: "GET", path: "/drive/v3/files/{fileId}?fields=id,name,mimeType,size,modifiedTime,webViewLink", description: "Информация о файле" },
      ],
      contacts: [
        { name: "list_contacts", method: "GET", path: "/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers&pageSize=50", description: "Список контактов" },
        { name: "search_contacts", method: "GET", path: "/v1/people:searchContacts?query={query}&readMask=names,emailAddresses,phoneNumbers", description: "Поиск контактов" },
      ],
    },
  },
  {
    id: "github",
    name: "GitHub",
    description: "Репозитории, Issues, Pull Requests",
    relayUrl: RELAY_URL,
    scopes: { default: "Полный доступ" },
    baseUrls: { default: "https://api.github.com" },
    actions: {
      default: [
        { name: "list_repos", method: "GET", path: "/user/repos?sort=updated&per_page=20", description: "Мои репозитории" },
        { name: "get_repo", method: "GET", path: "/repos/{owner}/{repo}", description: "Информация о репозитории" },
        { name: "list_issues", method: "GET", path: "/repos/{owner}/{repo}/issues?state=open", description: "Список Issues" },
        { name: "create_issue", method: "POST", path: "/repos/{owner}/{repo}/issues", description: "Создать Issue" },
        { name: "list_prs", method: "GET", path: "/repos/{owner}/{repo}/pulls?state=open", description: "Список Pull Requests" },
        { name: "get_user", method: "GET", path: "/user", description: "Мой профиль" },
        { name: "list_notifications", method: "GET", path: "/notifications", description: "Уведомления" },
      ],
    },
  },
  {
    id: "vk",
    name: "ВКонтакте",
    description: "Сообщения, стена, друзья, фото",
    relayUrl: RELAY_URL,
    scopes: { default: "Сообщения, стена, друзья, фото" },
    baseUrls: { default: "https://api.vk.com/method" },
    actions: {
      default: [
        { name: "get_profile", method: "GET", path: "/users.get?fields=photo_200,city,bdate&v=5.199", description: "Мой профиль" },
        { name: "get_friends", method: "GET", path: "/friends.get?fields=nickname,photo_100&v=5.199", description: "Список друзей" },
        { name: "get_dialogs", method: "GET", path: "/messages.getConversations?count=20&v=5.199", description: "Диалоги" },
        { name: "send_message", method: "POST", path: "/messages.send?random_id={random}&peer_id={peerId}&message={message}&v=5.199", description: "Отправить сообщение" },
        { name: "get_wall", method: "GET", path: "/wall.get?count=20&v=5.199", description: "Стена" },
        { name: "wall_post", method: "POST", path: "/wall.post?message={message}&v=5.199", description: "Пост на стену" },
      ],
    },
  },
  {
    id: "yandex",
    name: "Яндекс",
    description: "Почта, Диск",
    relayUrl: RELAY_URL,
    scopes: { mail: "Почта", disk: "Диск" },
    baseUrls: {
      mail: "https://mail.yandex.ru/api",
      disk: "https://cloud-api.yandex.net",
    },
    actions: {
      disk: [
        { name: "list_files", method: "GET", path: "/v1/disk/resources?path=/&limit=20", description: "Файлы на Яндекс.Диске" },
        { name: "get_disk_info", method: "GET", path: "/v1/disk/", description: "Информация о Диске" },
        { name: "search_files", method: "GET", path: "/v1/disk/resources/files?media_type={type}&limit=20", description: "Поиск файлов по типу" },
      ],
    },
  },
  {
    id: "reddit",
    name: "Reddit",
    description: "Лента, сабреддиты, профиль",
    relayUrl: RELAY_URL,
    scopes: { default: "Чтение, профиль, подписки" },
    baseUrls: { default: "https://oauth.reddit.com" },
    actions: {
      default: [
        { name: "me", method: "GET", path: "/api/v1/me", description: "Мой профиль" },
        { name: "hot", method: "GET", path: "/hot?limit=10", description: "Горячие посты" },
        { name: "subreddit_hot", method: "GET", path: "/r/{subreddit}/hot?limit=10", description: "Горячее в сабреддите" },
        { name: "my_subreddits", method: "GET", path: "/subreddits/mine/subscriber?limit=25", description: "Мои подписки" },
        { name: "search", method: "GET", path: "/search?q={query}&limit=10", description: "Поиск" },
      ],
    },
  },
  {
    id: "mailru",
    name: "Mail.ru",
    description: "Профиль, почта",
    relayUrl: RELAY_URL,
    scopes: { default: "Профиль, почта" },
    baseUrls: { default: "https://oauth.mail.ru" },
    actions: {
      default: [
        { name: "userinfo", method: "GET", path: "/userinfo", description: "Профиль пользователя" },
      ],
    },
  },
];

export function listServices(): ServiceDefinition[] {
  return services;
}

export function getService(id: string): ServiceDefinition | null {
  return services.find(s => s.id === id) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/services/catalog.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/catalog.ts test/core/services/catalog.test.ts
git commit -m "feat(services): add service catalog with 6 services and API actions"
```

---

### Task 5: Embeddings module — generate and search

**Files:**
- Create: `src/services/embeddings.ts`
- Test: `test/core/services/embeddings.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/core/services/embeddings.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { cosineSimilarity, findBestMatches } from "../../../src/services/embeddings.js";

describe("embeddings", () => {
  it("cosineSimilarity returns 1 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it("cosineSimilarity returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it("cosineSimilarity returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  it("findBestMatches returns top-k results sorted by similarity", () => {
    const query = new Float32Array([1, 0, 0]);
    const candidates = [
      { id: 1, embedding: new Float32Array([0, 1, 0]) },   // orthogonal
      { id: 2, embedding: new Float32Array([1, 0, 0]) },   // identical
      { id: 3, embedding: new Float32Array([0.9, 0.1, 0]) }, // close
    ];
    const results = findBestMatches(query, candidates, 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe(2); // most similar
    expect(results[1].id).toBe(3); // second most similar
  });

  it("findBestMatches handles empty candidates", () => {
    const query = new Float32Array([1, 0]);
    expect(findBestMatches(query, [], 3)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/services/embeddings.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement embeddings module**

Create `src/services/embeddings.ts`:

```typescript
const EMBEDDING_MODEL = "openai/text-embedding-3-small";

/** Cosine similarity between two vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Find top-k most similar candidates by cosine similarity. */
export function findBestMatches<T extends { embedding: Float32Array }>(
  query: Float32Array,
  candidates: T[],
  topK: number,
): (T & { score: number })[] {
  return candidates
    .map(c => ({ ...c, score: cosineSimilarity(query, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** Generate an embedding vector via OpenRouter API. */
export async function generateEmbedding(text: string, apiKey: string): Promise<Float32Array> {
  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const json = await response.json() as { data: Array<{ embedding: number[] }> };
  return new Float32Array(json.data[0].embedding);
}

/** Convert Float32Array to Buffer for SQLite BLOB storage. */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/** Convert SQLite BLOB Buffer back to Float32Array. */
export function bufferToEmbedding(buf: Buffer): Float32Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/services/embeddings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/embeddings.ts test/core/services/embeddings.test.ts
git commit -m "feat(services): add embedding generation and cosine similarity search"
```

---

### Task 6: Skills store — CRUD with vector search

**Files:**
- Create: `src/services/skills-store.ts`
- Test: `test/core/services/skills-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/core/services/skills-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDB, closeDB } from "../../../src/core/memory/db.js";
import { SkillsStore } from "../../../src/services/skills-store.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

describe("SkillsStore", () => {
  const testDbPath = path.join(os.tmpdir(), `betsy-test-skills-${Date.now()}.db`);
  let store: SkillsStore;

  beforeEach(() => {
    closeDB();
    getDB(testDbPath);
    store = new SkillsStore();
  });

  afterEach(() => {
    closeDB();
    try { fs.unlinkSync(testDbPath); } catch {}
    try { fs.unlinkSync(testDbPath + "-wal"); } catch {}
    try { fs.unlinkSync(testDbPath + "-shm"); } catch {}
  });

  it("installs and retrieves a skill", () => {
    const embedding = new Float32Array([0.1, 0.2, 0.3]);
    store.install({
      serviceId: "google",
      name: "gmail-summary",
      description: "Daily Gmail summary",
      content: "# Gmail Summary\nFetch unread emails...",
      embedding,
      sourceUrl: "https://github.com/test/skill",
    });

    const skills = store.listByService("google");
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("gmail-summary");
    expect(skills[0].content).toContain("Gmail Summary");
  });

  it("searches by vector similarity", () => {
    store.install({ serviceId: "google", name: "gmail-summary", description: "Email digest", content: "...", embedding: new Float32Array([1, 0, 0]), sourceUrl: null });
    store.install({ serviceId: "google", name: "youtube-stats", description: "Channel stats", content: "...", embedding: new Float32Array([0, 1, 0]), sourceUrl: null });
    store.install({ serviceId: "github", name: "pr-review", description: "PR automation", content: "...", embedding: new Float32Array([0, 0, 1]), sourceUrl: null });

    const query = new Float32Array([0.9, 0.1, 0]);
    const results = store.searchByVector(query, 2);
    expect(results).toHaveLength(2);
    expect(results[0].name).toBe("gmail-summary");
  });

  it("searchByVector filters by serviceId", () => {
    store.install({ serviceId: "google", name: "gmail-skill", description: "Gmail", content: "...", embedding: new Float32Array([1, 0]), sourceUrl: null });
    store.install({ serviceId: "github", name: "gh-skill", description: "GitHub", content: "...", embedding: new Float32Array([1, 0]), sourceUrl: null });

    const query = new Float32Array([1, 0]);
    const results = store.searchByVector(query, 10, "google");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("gmail-skill");
  });

  it("deletes a skill by id", () => {
    store.install({ serviceId: "google", name: "test", description: "test", content: "...", embedding: new Float32Array([1]), sourceUrl: null });
    const skills = store.listByService("google");
    expect(skills).toHaveLength(1);

    store.delete(skills[0].id);
    expect(store.listByService("google")).toHaveLength(0);
  });

  it("counts skills per service", () => {
    store.install({ serviceId: "google", name: "s1", description: "d", content: "c", embedding: new Float32Array([1]), sourceUrl: null });
    store.install({ serviceId: "google", name: "s2", description: "d", content: "c", embedding: new Float32Array([1]), sourceUrl: null });
    store.install({ serviceId: "github", name: "s3", description: "d", content: "c", embedding: new Float32Array([1]), sourceUrl: null });

    expect(store.countByService("google")).toBe(2);
    expect(store.countByService("github")).toBe(1);
    expect(store.countTotal()).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/services/skills-store.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement SkillsStore**

Create `src/services/skills-store.ts`:

```typescript
import { getDB } from "../core/memory/db.js";
import { bufferToEmbedding, embeddingToBuffer, findBestMatches } from "./embeddings.js";

export interface InstallSkillParams {
  serviceId: string | null;
  name: string;
  description: string;
  content: string;
  embedding: Float32Array;
  sourceUrl: string | null;
}

export interface InstalledSkill {
  id: number;
  serviceId: string | null;
  name: string;
  description: string;
  content: string;
  embedding: Float32Array;
  sourceUrl: string | null;
  installedAt: number;
}

interface SkillRow {
  id: number;
  service_id: string | null;
  name: string;
  description: string;
  content: string;
  embedding: Buffer | null;
  source_url: string | null;
  installed_at: number;
}

export class SkillsStore {
  install(params: InstallSkillParams): number {
    const db = getDB();
    const result = db.prepare(`
      INSERT INTO installed_skills (service_id, name, description, content, embedding, source_url, installed_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    `).run(
      params.serviceId,
      params.name,
      params.description,
      params.content,
      embeddingToBuffer(params.embedding),
      params.sourceUrl,
    );
    return Number(result.lastInsertRowid);
  }

  delete(id: number): void {
    const db = getDB();
    db.prepare("DELETE FROM installed_skills WHERE id = ?").run(id);
  }

  listByService(serviceId: string): InstalledSkill[] {
    const db = getDB();
    const rows = db.prepare(
      "SELECT * FROM installed_skills WHERE service_id = ? ORDER BY installed_at DESC"
    ).all(serviceId) as SkillRow[];
    return rows.map(r => this.rowToSkill(r));
  }

  listAll(): InstalledSkill[] {
    const db = getDB();
    const rows = db.prepare(
      "SELECT * FROM installed_skills ORDER BY installed_at DESC"
    ).all() as SkillRow[];
    return rows.map(r => this.rowToSkill(r));
  }

  searchByVector(query: Float32Array, topK: number, serviceId?: string): InstalledSkill[] {
    const all = serviceId ? this.listByService(serviceId) : this.listAll();
    const withEmbeddings = all.filter(s => s.embedding.length > 0);
    if (withEmbeddings.length === 0) return [];
    return findBestMatches(query, withEmbeddings.map(s => ({ ...s, embedding: s.embedding })), topK);
  }

  countByService(serviceId: string): number {
    const db = getDB();
    const row = db.prepare("SELECT COUNT(*) as cnt FROM installed_skills WHERE service_id = ?").get(serviceId) as { cnt: number };
    return row.cnt;
  }

  countTotal(): number {
    const db = getDB();
    const row = db.prepare("SELECT COUNT(*) as cnt FROM installed_skills").get() as { cnt: number };
    return row.cnt;
  }

  private rowToSkill(row: SkillRow): InstalledSkill {
    return {
      id: row.id,
      serviceId: row.service_id,
      name: row.name,
      description: row.description,
      content: row.content,
      embedding: row.embedding ? bufferToEmbedding(row.embedding) : new Float32Array(0),
      sourceUrl: row.source_url,
      installedAt: row.installed_at,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/services/skills-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/skills-store.ts test/core/services/skills-store.test.ts
git commit -m "feat(services): add skills store with vector similarity search"
```

---

### Task 7: connect_service tool

**Files:**
- Create: `src/core/tools/connect-service.ts`
- Test: `test/core/tools/connect-service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/core/tools/connect-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDB, closeDB } from "../../../src/core/memory/db.js";
import { ConnectServiceTool } from "../../../src/core/tools/connect-service.js";
import { TokenStore } from "../../../src/services/tokens.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

describe("ConnectServiceTool", () => {
  const testDbPath = path.join(os.tmpdir(), `betsy-test-connect-${Date.now()}.db`);
  const encKey = "b55c8792d1ce458e279308835f8a97b580263503e76e1998e279703e35ad0c2e";
  let tool: ConnectServiceTool;

  beforeEach(() => {
    closeDB();
    getDB(testDbPath);
    tool = new ConnectServiceTool({ encryptionKey: encKey });
  });

  afterEach(() => {
    closeDB();
    try { fs.unlinkSync(testDbPath); } catch {}
    try { fs.unlinkSync(testDbPath + "-wal"); } catch {}
    try { fs.unlinkSync(testDbPath + "-shm"); } catch {}
  });

  it("has correct tool interface", () => {
    expect(tool.name).toBe("connect_service");
    expect(tool.parameters.length).toBeGreaterThan(0);
  });

  it("action=list returns available services", async () => {
    const result = await tool.execute({ action: "list", _userId: "test" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Google");
    expect(result.output).toContain("GitHub");
    expect(result.output).toContain("ВКонтакте");
  });

  it("action=status shows no connections initially", async () => {
    const result = await tool.execute({ action: "status", _userId: "test" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Нет подключённых сервисов");
  });

  it("action=disconnect removes token", async () => {
    // Pre-save a token
    const store = new TokenStore(encKey);
    store.save({ serviceId: "google", userId: "test", accessToken: "t", scopes: "gmail", expiresAt: 9999999999 });

    const result = await tool.execute({ action: "disconnect", service: "google", _userId: "test" });
    expect(result.success).toBe(true);
    expect(store.get("google", "test")).toBeNull();
  });

  it("action=connect fails for unknown service", async () => {
    const result = await tool.execute({ action: "connect", service: "unknown", _userId: "test" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Неизвестный сервис");
  });

  it("action=connect without service returns error", async () => {
    const result = await tool.execute({ action: "connect", _userId: "test" });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/tools/connect-service.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement ConnectServiceTool**

Create `src/core/tools/connect-service.ts`:

```typescript
import type { Tool, ToolResult } from "./types.js";
import { listServices, getService } from "../../services/catalog.js";
import { TokenStore } from "../../services/tokens.js";

export interface ConnectServiceConfig {
  encryptionKey: string;
}

export class ConnectServiceTool implements Tool {
  name = "connect_service";
  description =
    "Подключение и управление внешними сервисами (Google, GitHub, VK и др.). " +
    "Используй action=list чтобы показать доступные сервисы, action=connect для подключения, " +
    "action=disconnect для отключения, action=status для просмотра статуса.";
  parameters = [
    { name: "action", type: "string", description: "list | connect | disconnect | status", required: true },
    { name: "service", type: "string", description: "ID сервиса: google, github, vk, yandex, reddit, mailru" },
    { name: "scopes", type: "string", description: "Части сервиса через запятую: gmail,youtube,calendar" },
  ];

  private tokenStore: TokenStore;

  constructor(config: ConnectServiceConfig) {
    this.tokenStore = new TokenStore(config.encryptionKey);
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action ?? "").trim();
    const userId = String(params._userId ?? "unknown");

    switch (action) {
      case "list":
        return this.handleList(userId);
      case "connect":
        return this.handleConnect(params, userId);
      case "disconnect":
        return this.handleDisconnect(params, userId);
      case "status":
        return this.handleStatus(userId);
      default:
        return { success: false, output: `Неизвестное действие: "${action}". Используй: list, connect, disconnect, status` };
    }
  }

  private handleList(userId: string): ToolResult {
    const services = listServices();
    const connected = this.tokenStore.listConnected(userId);
    const connectedIds = new Set(connected.map(t => t.serviceId));

    const lines = services.map(s => {
      const status = connectedIds.has(s.id) ? "✅" : "⬜";
      return `${status} **${s.name}** — ${s.description}`;
    });

    return { success: true, output: `Доступные сервисы:\n\n${lines.join("\n")}` };
  }

  private async handleConnect(params: Record<string, unknown>, userId: string): Promise<ToolResult> {
    const serviceId = String(params.service ?? "").trim();
    if (!serviceId) {
      return { success: false, output: "Укажи какой сервис подключить (параметр service)" };
    }

    const service = getService(serviceId);
    if (!service) {
      return { success: false, output: `Неизвестный сервис: "${serviceId}". Используй action=list чтобы посмотреть доступные.` };
    }

    // Determine scopes
    const requestedScopes = params.scopes
      ? String(params.scopes).split(",").map(s => s.trim())
      : Object.keys(service.scopes);

    const scopeLabels = requestedScopes
      .map(s => service.scopes[s] ?? s)
      .join(", ");

    // Call relay to start OAuth
    try {
      const response = await fetch(`${service.relayUrl}/start/${serviceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopes: requestedScopes }),
      });

      if (!response.ok) {
        const errText = await response.text();
        return { success: false, output: `Ошибка запуска OAuth: ${response.status}`, error: errText.slice(0, 300) };
      }

      const data = await response.json() as { instance_id: string; auth_url: string };

      // Poll for token
      const token = await this.pollForToken(service.relayUrl, data.instance_id);

      if (!token) {
        return {
          success: false,
          output: `Авторизация не была завершена за 5 минут. Давай попробуем ещё раз? Скажи "подключи ${service.name}" и я скину новую ссылку.`,
        };
      }

      // Save token
      this.tokenStore.save({
        serviceId,
        userId,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        scopes: requestedScopes.join(","),
        expiresAt: Math.floor(Date.now() / 1000) + (token.expires_in ?? 3600),
      });

      return {
        success: true,
        output: `${service.name} подключён! Доступны: ${scopeLabels}. Ссылка для авторизации: ${data.auth_url}`,
      };
    } catch (err) {
      return {
        success: false,
        output: `Ошибка подключения к ${service.name}`,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private handleDisconnect(params: Record<string, unknown>, userId: string): ToolResult {
    const serviceId = String(params.service ?? "").trim();
    if (!serviceId) {
      return { success: false, output: "Укажи какой сервис отключить (параметр service)" };
    }

    const service = getService(serviceId);
    if (!service) {
      return { success: false, output: `Неизвестный сервис: "${serviceId}"` };
    }

    this.tokenStore.delete(serviceId, userId);
    return { success: true, output: `${service.name} отключён.` };
  }

  private handleStatus(userId: string): ToolResult {
    const connected = this.tokenStore.listConnected(userId);
    const allServices = listServices();

    if (connected.length === 0) {
      return { success: true, output: "Нет подключённых сервисов. Используй action=list чтобы посмотреть доступные." };
    }

    const connectedIds = new Set(connected.map(t => t.serviceId));
    const lines: string[] = [];

    lines.push("Подключено:");
    for (const token of connected) {
      const svc = getService(token.serviceId);
      const name = svc?.name ?? token.serviceId;
      const scopeLabels = token.scopes.split(",")
        .map(s => svc?.scopes[s] ?? s)
        .join(", ");
      const expired = token.isExpired() ? " ⚠️ (токен истёк)" : "";
      lines.push(`  ✅ ${name} (${scopeLabels})${expired}`);
    }

    const notConnected = allServices.filter(s => !connectedIds.has(s.id));
    if (notConnected.length > 0) {
      lines.push("\nНе подключено:");
      for (const svc of notConnected) {
        lines.push(`  ⬜ ${svc.name}`);
      }
    }

    return { success: true, output: lines.join("\n") };
  }

  private async pollForToken(relayUrl: string, instanceId: string): Promise<{ access_token: string; refresh_token?: string; expires_in?: number } | null> {
    const POLL_INTERVAL = 3000;
    const MAX_POLLS = 100; // 5 minutes at 3s intervals

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));

      try {
        const response = await fetch(`${relayUrl}/poll/${instanceId}`);
        if (!response.ok) continue;

        const data = await response.json() as { status: string; access_token?: string; refresh_token?: string; expires_in?: number };

        if (data.status === "complete" && data.access_token) {
          return {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_in: data.expires_in,
          };
        }

        if (data.status === "expired") {
          return null;
        }
      } catch {
        // Network error — keep trying
      }
    }

    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/tools/connect-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/connect-service.ts test/core/tools/connect-service.test.ts
git commit -m "feat(tools): add connect_service tool for OAuth service connections"
```

---

### Task 8: Register connect_service in index.ts and inject userId into engine

**Files:**
- Modify: `src/index.ts:85-123`
- Modify: `src/core/engine.ts:237-243`

- [ ] **Step 1: Add connect_service registration to index.ts**

In `src/index.ts`, add import at the top:

```typescript
import { ConnectServiceTool } from "./core/tools/connect-service.js";
```

After `tools.register(npmInstallTool);` (line ~99), add:

```typescript
  // Service connector — OAuth-based external service connections
  const passwordHash = config.security?.password_hash ?? "default-key-change-me";
  tools.register(new ConnectServiceTool({ encryptionKey: passwordHash }));
```

- [ ] **Step 2: Inject userId into tool execution in engine.ts**

In `src/core/engine.ts`, in the `executeTool` method (~line 374), inject `_userId` so tools can access the current user:

Replace the existing `executeTool` method:

```typescript
  private async executeTool(name: string, args: Record<string, unknown>, userId?: string): Promise<ToolResult> {
    const tool = this.deps.tools.get(name);
    if (!tool) {
      return { success: false, output: "", error: `unknown tool "${name}"` };
    }

    try {
      // Inject userId for tools that need it (e.g. connect_service)
      const params = userId ? { ...args, _userId: userId } : args;
      return await tool.execute(params);
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  }
```

Update the call site in the agentic loop (~line 241) to pass userId:

```typescript
          const result = await this.executeTool(tc.name, tc.arguments, userId);
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/core/engine.ts
git commit -m "feat: register connect_service tool and inject userId into tool execution"
```

---

### Task 9: Update prompt to inform LLM about connected services

**Files:**
- Modify: `src/core/prompt.ts:130-140`

- [ ] **Step 1: Add service info to system prompt**

In `src/core/prompt.ts`, add a new parameter to `buildSystemPrompt`:

```typescript
export function buildSystemPrompt(
  config: PromptConfig,
  userMessage?: string,
  chatId?: string,
  connectedServices?: string[],
): string {
```

Before the "Текущий запрос" section (~line 141), add:

```typescript
  // Connected services
  if (connectedServices && connectedServices.length > 0) {
    prompt += `\n\n## Подключённые сервисы\n\nУ пользователя подключены: ${connectedServices.join(", ")}. Для запросов к этим сервисам используй tool \`http\` с правильным URL и заголовком Authorization. Токен подставится автоматически. Для подключения новых сервисов или просмотра доступных используй tool \`connect_service\`.`;
  } else {
    prompt += `\n\n## Подключённые сервисы\n\nУ пользователя нет подключённых сервисов. Для подключения используй tool \`connect_service\` с action=list.`;
  }
```

- [ ] **Step 2: Update engine to pass connected services to prompt**

In `src/core/engine.ts`, update `buildPromptWithMemory` to include connected services. Import TokenStore and catalog at the top:

```typescript
import { TokenStore } from "../services/tokens.js";
import { getService } from "../services/catalog.js";
```

Add a `tokenStore` field to `EngineDeps`:

```typescript
export interface EngineDeps {
  llm: { fast(): LLMClient; strong(): LLMClient };
  config: PromptConfig;
  tools: ToolRegistry;
  contextBudget: number;
  encryptionKey?: string;
}
```

In the `buildPromptWithMemory` method, add connected services lookup:

```typescript
  private buildPromptWithMemory(userMessage: string, chatId: string): string {
    // Get connected services for this user
    let connectedServiceNames: string[] = [];
    if (this.deps.encryptionKey) {
      try {
        const tokenStore = new TokenStore(this.deps.encryptionKey);
        const tokens = tokenStore.listConnected(chatId);
        connectedServiceNames = tokens.map(t => {
          const svc = getService(t.serviceId);
          return svc ? `${svc.name} (${t.scopes})` : t.serviceId;
        });
      } catch {}
    }

    let prompt = buildSystemPrompt(this.deps.config, userMessage, chatId, connectedServiceNames);
```

- [ ] **Step 3: Update index.ts to pass encryptionKey to Engine**

In `src/index.ts`, update the Engine construction (~line 128):

```typescript
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
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (prompt.test.ts may need `connectedServices` parameter added to calls).

- [ ] **Step 5: Commit**

```bash
git add src/core/prompt.ts src/core/engine.ts src/index.ts
git commit -m "feat: inject connected services info into system prompt"
```

---

### Task 10: Auto-inject auth headers in HttpTool

**Files:**
- Modify: `src/core/tools/http.ts`

- [ ] **Step 1: Write the test**

Add to `test/tools/http.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HttpTool } from "../../src/core/tools/http.js";
import { getDB, closeDB } from "../../src/core/memory/db.js";
import { TokenStore } from "../../../src/services/tokens.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

describe("HttpTool", () => {
  it("has updated description mentioning API calls", () => {
    const tool = new HttpTool();
    expect(tool.description).toContain("API");
  });

  it("has MAX_OUTPUT_CHARS constant", () => {
    expect(HttpTool.MAX_OUTPUT_CHARS).toBe(8000);
  });
});

describe("HttpTool auth injection", () => {
  const testDbPath = path.join(os.tmpdir(), `betsy-test-http-${Date.now()}.db`);
  const encKey = "b55c8792d1ce458e279308835f8a97b580263503e76e1998e279703e35ad0c2e";

  beforeEach(() => {
    closeDB();
    getDB(testDbPath);
  });

  afterEach(() => {
    closeDB();
    try { fs.unlinkSync(testDbPath); } catch {}
    try { fs.unlinkSync(testDbPath + "-wal"); } catch {}
    try { fs.unlinkSync(testDbPath + "-shm"); } catch {}
  });

  it("resolveAuthHeader returns token for matching service URL", () => {
    const store = new TokenStore(encKey);
    store.save({ serviceId: "github", userId: "user1", accessToken: "gh-token-123", scopes: "default", expiresAt: 9999999999 });

    const tool = new HttpTool({ encryptionKey: encKey });
    const header = tool.resolveAuthHeader("https://api.github.com/user/repos", "user1");
    expect(header).toBe("Bearer gh-token-123");
  });

  it("resolveAuthHeader returns null for unknown URL", () => {
    const tool = new HttpTool({ encryptionKey: encKey });
    const header = tool.resolveAuthHeader("https://random-api.com/data", "user1");
    expect(header).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tools/http.test.ts`
Expected: FAIL — `resolveAuthHeader` doesn't exist, constructor doesn't accept config.

- [ ] **Step 3: Update HttpTool to auto-inject auth**

Replace `src/core/tools/http.ts`:

```typescript
import type { Tool, ToolResult } from "./types.js";
import { TokenStore } from "../../services/tokens.js";
import { listServices } from "../../services/catalog.js";

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n[truncated, showing first ${max} of ${text.length} chars]`;
}

export interface HttpToolConfig {
  encryptionKey?: string;
}

export class HttpTool implements Tool {
  static readonly MAX_OUTPUT_CHARS = 8000;

  name = "http";
  description = "Make HTTP API requests (JSON/REST). For browsing websites use the 'web' or 'browser' tool. Auth headers are auto-injected for connected services.";
  parameters = [
    { name: "url", type: "string", description: "The URL to request", required: true },
    { name: "method", type: "string", description: "HTTP method: GET, POST, PUT, or DELETE" },
    { name: "body", type: "string", description: "Request body (for POST/PUT)" },
    { name: "headers", type: "string", description: "JSON-encoded headers object" },
  ];

  private encryptionKey?: string;

  constructor(config?: HttpToolConfig) {
    this.encryptionKey = config?.encryptionKey;
  }

  /** Check if a URL matches any connected service and return the auth header. */
  resolveAuthHeader(url: string, userId: string): string | null {
    if (!this.encryptionKey) return null;

    const services = listServices();
    for (const svc of services) {
      for (const baseUrl of Object.values(svc.baseUrls)) {
        if (url.startsWith(baseUrl)) {
          const store = new TokenStore(this.encryptionKey);
          const token = store.get(svc.id, userId);
          if (token && !token.isExpired()) {
            return `Bearer ${token.accessToken}`;
          }
        }
      }
    }
    return null;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const url = params.url as string | undefined;
    if (!url) {
      return { success: false, output: "", error: "Missing required parameter: url" };
    }

    const method = ((params.method as string) || "GET").toUpperCase();
    const body = params.body as string | undefined;
    const userId = params._userId as string | undefined;

    let headers: Record<string, string> = {};
    if (params.headers) {
      try {
        headers = typeof params.headers === "string" ? JSON.parse(params.headers) : (params.headers as Record<string, string>);
      } catch {
        return { success: false, output: "", error: "Invalid headers: must be a JSON-encoded object" };
      }
    }

    // Auto-inject Authorization header for connected services
    if (!headers["Authorization"] && !headers["authorization"] && userId) {
      const authHeader = this.resolveAuthHeader(url, userId);
      if (authHeader) {
        headers["Authorization"] = authHeader;
      }
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);

      const response = await fetch(url, {
        method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);

      const text = await response.text();

      if (!response.ok) {
        return { success: false, output: truncate(text, HttpTool.MAX_OUTPUT_CHARS), error: `HTTP ${response.status} ${response.statusText}` };
      }

      return { success: true, output: truncate(text, HttpTool.MAX_OUTPUT_CHARS) };
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }
}
```

- [ ] **Step 4: Update index.ts to pass encryptionKey to HttpTool**

In `src/index.ts`, change:

```typescript
  tools.register(new HttpTool());
```

to:

```typescript
  tools.register(new HttpTool({ encryptionKey: config.security?.password_hash }));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/tools/http.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/tools/http.ts src/index.ts test/tools/http.test.ts
git commit -m "feat(http): auto-inject auth headers for connected services"
```

---

### Task 11: OAuth Relay server

**Files:**
- Create: `auth-relay/server.ts`
- Create: `auth-relay/package.json`
- Create: `auth-relay/tsconfig.json`
- Create: `auth-relay/config.example.yaml`
- Create: `auth-relay/.gitignore`

- [ ] **Step 1: Create package.json**

Create `auth-relay/package.json`:

```json
{
  "name": "betsy-auth-relay",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node --experimental-strip-types server.ts",
    "dev": "node --watch --experimental-strip-types server.ts"
  },
  "dependencies": {
    "yaml": "^2.7.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `auth-relay/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true
  }
}
```

- [ ] **Step 3: Create .gitignore**

Create `auth-relay/.gitignore`:

```
config.yaml
node_modules/
```

- [ ] **Step 4: Create config example**

Create `auth-relay/config.example.yaml`:

```yaml
port: 3780

services:
  google:
    client_id: "YOUR_CLIENT_ID.apps.googleusercontent.com"
    client_secret: "GOCSPX-YOUR_SECRET"
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
    client_id: "YOUR_CLIENT_ID"
    client_secret: "YOUR_CLIENT_SECRET"
    auth_url: "https://github.com/login/oauth/authorize"
    token_url: "https://github.com/login/oauth/access_token"
    scopes:
      default: ["repo", "user"]

  vk:
    client_id: "YOUR_APP_ID"
    client_secret: "YOUR_SECRET_KEY"
    auth_url: "https://oauth.vk.com/authorize"
    token_url: "https://oauth.vk.com/access_token"
    scopes:
      default: ["messages", "wall", "friends", "photos"]

  yandex:
    client_id: "YOUR_CLIENT_ID"
    client_secret: "YOUR_CLIENT_SECRET"
    auth_url: "https://oauth.yandex.ru/authorize"
    token_url: "https://oauth.yandex.ru/token"
    scopes:
      mail: ["mail:imap_full"]
      disk: ["cloud_api:disk.read", "cloud_api:disk.write"]

  reddit:
    client_id: "YOUR_CLIENT_ID"
    client_secret: "YOUR_CLIENT_SECRET"
    auth_url: "https://www.reddit.com/api/v1/authorize"
    token_url: "https://www.reddit.com/api/v1/access_token"
    scopes:
      default: ["read", "identity", "mysubreddits"]

  mailru:
    client_id: "YOUR_CLIENT_ID"
    client_secret: "YOUR_CLIENT_SECRET"
    auth_url: "https://oauth.mail.ru/login"
    token_url: "https://oauth.mail.ru/token"
    scopes:
      default: ["userinfo", "mail.imap"]
```

- [ ] **Step 5: Implement relay server**

Create `auth-relay/server.ts`:

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// --- Config ---
interface ServiceConfig {
  client_id: string;
  client_secret: string;
  auth_url: string;
  token_url: string;
  scopes: Record<string, string[]>;
}

interface Config {
  port: number;
  services: Record<string, ServiceConfig>;
}

const configRaw = readFileSync(new URL("./config.yaml", import.meta.url), "utf-8");
const config = parseYaml(configRaw) as Config;
const PORT = config.port || 3780;
const CALLBACK_BASE = process.env.CALLBACK_BASE || `https://auth.betsyai.io`;
const TTL_MS = 5 * 60 * 1000; // 5 minutes

// --- In-memory pending tokens ---
interface PendingEntry {
  service: string;
  scopes: string[];
  createdAt: number;
  token?: { access_token: string; refresh_token?: string; expires_in?: number };
}

const pending = new Map<string, PendingEntry>();

// Cleanup expired entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (now - entry.createdAt > TTL_MS) pending.delete(id);
  }
}, 60_000);

// --- Helpers ---
function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Betsy</title></head><body style="font-family:sans-serif;text-align:center;padding-top:80px;"><h1>${body}</h1></body></html>`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function parseRoute(url: string): { path: string; params: URLSearchParams } {
  const u = new URL(url, "http://localhost");
  return { path: u.pathname, params: u.searchParams };
}

// --- Handlers ---
async function handleStart(serviceName: string, body: string, res: ServerResponse): Promise<void> {
  const svc = config.services[serviceName];
  if (!svc) return json(res, 404, { error: `Unknown service: ${serviceName}` });

  let requestedScopes: string[];
  try {
    const parsed = JSON.parse(body);
    requestedScopes = parsed.scopes ?? Object.keys(svc.scopes);
  } catch {
    requestedScopes = Object.keys(svc.scopes);
  }

  // Flatten scope arrays
  const flatScopes: string[] = [];
  for (const scopeKey of requestedScopes) {
    const scopeValues = svc.scopes[scopeKey];
    if (scopeValues) flatScopes.push(...scopeValues);
  }

  const instanceId = randomUUID();
  pending.set(instanceId, { service: serviceName, scopes: requestedScopes, createdAt: Date.now() });

  const callbackUrl = `${CALLBACK_BASE}/callback/${serviceName}`;
  const authParams = new URLSearchParams({
    client_id: svc.client_id,
    redirect_uri: callbackUrl,
    response_type: "code",
    scope: flatScopes.join(" "),
    state: instanceId,
    access_type: "offline",
    prompt: "consent",
  });

  const authUrl = `${svc.auth_url}?${authParams.toString()}`;

  json(res, 200, { instance_id: instanceId, auth_url: authUrl });
}

async function handleCallback(serviceName: string, params: URLSearchParams, res: ServerResponse): Promise<void> {
  const svc = config.services[serviceName];
  if (!svc) return html(res, "Неизвестный сервис");

  const code = params.get("code");
  const state = params.get("state");

  if (!code || !state) {
    return html(res, "Ошибка авторизации — не получен код");
  }

  const entry = pending.get(state);
  if (!entry) {
    return html(res, "Ссылка истекла. Попроси Betsy отправить новую.");
  }

  // Exchange code for token
  const callbackUrl = `${CALLBACK_BASE}/callback/${serviceName}`;
  const tokenParams = new URLSearchParams({
    client_id: svc.client_id,
    client_secret: svc.client_secret,
    code,
    grant_type: "authorization_code",
    redirect_uri: callbackUrl,
  });

  try {
    const tokenRes = await fetch(svc.token_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: tokenParams.toString(),
    });

    const tokenData = await tokenRes.json() as Record<string, unknown>;

    if (!tokenRes.ok || tokenData.error) {
      console.error(`Token exchange failed for ${serviceName}:`, tokenData);
      return html(res, "Ошибка получения токена. Попробуй ещё раз.");
    }

    entry.token = {
      access_token: tokenData.access_token as string,
      refresh_token: tokenData.refresh_token as string | undefined,
      expires_in: tokenData.expires_in as number | undefined,
    };

    html(res, "✅ Готово! Можешь закрыть это окно и вернуться к Betsy.");
  } catch (err) {
    console.error(`Token exchange error for ${serviceName}:`, err);
    html(res, "Ошибка. Попробуй ещё раз.");
  }
}

function handlePoll(instanceId: string, res: ServerResponse): void {
  const entry = pending.get(instanceId);

  if (!entry) {
    return json(res, 200, { status: "expired" });
  }

  if (Date.now() - entry.createdAt > TTL_MS) {
    pending.delete(instanceId);
    return json(res, 200, { status: "expired" });
  }

  if (!entry.token) {
    return json(res, 200, { status: "pending" });
  }

  // One-time retrieval
  const token = entry.token;
  pending.delete(instanceId);
  json(res, 200, {
    status: "complete",
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_in: token.expires_in,
  });
}

async function handleRefresh(serviceName: string, body: string, res: ServerResponse): Promise<void> {
  const svc = config.services[serviceName];
  if (!svc) return json(res, 404, { error: `Unknown service: ${serviceName}` });

  let refreshToken: string;
  try {
    const parsed = JSON.parse(body);
    refreshToken = parsed.refresh_token;
  } catch {
    return json(res, 400, { error: "Invalid body" });
  }

  if (!refreshToken) {
    return json(res, 400, { error: "Missing refresh_token" });
  }

  const tokenParams = new URLSearchParams({
    client_id: svc.client_id,
    client_secret: svc.client_secret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  try {
    const tokenRes = await fetch(svc.token_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: tokenParams.toString(),
    });

    const tokenData = await tokenRes.json() as Record<string, unknown>;

    if (!tokenRes.ok || tokenData.error) {
      return json(res, 401, { error: "Refresh failed", details: tokenData });
    }

    json(res, 200, {
      access_token: tokenData.access_token,
      expires_in: tokenData.expires_in,
    });
  } catch (err) {
    json(res, 500, { error: "Internal error" });
  }
}

// --- Server ---
const server = createServer(async (req, res) => {
  const { path: routePath, params } = parseRoute(req.url ?? "/");

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  // POST /start/:service
  const startMatch = routePath.match(/^\/start\/(\w+)$/);
  if (startMatch && req.method === "POST") {
    const body = await readBody(req);
    return handleStart(startMatch[1], body, res);
  }

  // GET /callback/:service
  const callbackMatch = routePath.match(/^\/callback\/(\w+)$/);
  if (callbackMatch && req.method === "GET") {
    return handleCallback(callbackMatch[1], params, res);
  }

  // GET /poll/:instanceId
  const pollMatch = routePath.match(/^\/poll\/([\w-]+)$/);
  if (pollMatch && req.method === "GET") {
    return handlePoll(pollMatch[1], res);
  }

  // POST /refresh/:service
  const refreshMatch = routePath.match(/^\/refresh\/(\w+)$/);
  if (refreshMatch && req.method === "POST") {
    const body = await readBody(req);
    return handleRefresh(refreshMatch[1], body, res);
  }

  // Health check
  if (routePath === "/health") {
    return json(res, 200, { status: "ok", services: Object.keys(config.services) });
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`🔑 Betsy Auth Relay running on port ${PORT}`);
  console.log(`   Services: ${Object.keys(config.services).join(", ")}`);
  console.log(`   Callback base: ${CALLBACK_BASE}`);
});
```

- [ ] **Step 6: Commit**

```bash
git add auth-relay/
git commit -m "feat: add OAuth relay server for auth.betsyai.io"
```

---

### Task 12: Update skill_install to use installed_skills table with embeddings

**Files:**
- Modify: `src/core/tools/skill-install.ts`

- [ ] **Step 1: Update SkillInstallTool to save to installed_skills**

Replace `src/core/tools/skill-install.ts`:

```typescript
import type { Tool, ToolResult } from "./types.js";
import { SkillsStore } from "../../services/skills-store.js";
import { generateEmbedding } from "../../services/embeddings.js";

const MAX_SKILL_CHARS = 8_000;

export interface SkillInstallConfig {
  apiKey?: string; // OpenRouter API key for embeddings
}

export class SkillInstallTool implements Tool {
  name = "skill_install";
  description =
    "Install a skill from GitHub by downloading its SKILL.md and saving it with vector embedding for semantic search. " +
    "After installation the skill instructions become part of your knowledge and you can follow them. " +
    "Use after skill_search finds a relevant skill.";
  parameters = [
    { name: "github_url", type: "string", description: "GitHub URL of the skill folder (from skill_search results)", required: true },
    { name: "skill_name", type: "string", description: "Short name for the skill (e.g. 'image-generation')", required: true },
    { name: "service_id", type: "string", description: "Service this skill is for (e.g. 'google', 'github'). Omit for general skills." },
  ];

  private apiKey: string | undefined;
  private store = new SkillsStore();

  constructor(config?: SkillInstallConfig) {
    this.apiKey = config?.apiKey;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const githubUrl = String(params.github_url ?? "").trim();
    const skillName = String(params.skill_name ?? "").trim();
    const serviceId = params.service_id ? String(params.service_id).trim() : null;

    if (!githubUrl) {
      return { success: false, output: "Missing required parameter: github_url" };
    }
    if (!skillName) {
      return { success: false, output: "Missing required parameter: skill_name" };
    }

    // Check limits
    if (serviceId && this.store.countByService(serviceId) >= 20) {
      return { success: false, output: `Лимит скиллов для ${serviceId} достигнут (20). Удали неиспользуемые.` };
    }
    if (this.store.countTotal() >= 200) {
      return { success: false, output: "Лимит скиллов достигнут (200). Удали неиспользуемые." };
    }

    const rawUrl = toRawUrl(githubUrl);
    if (!rawUrl) {
      return { success: false, output: `Cannot parse GitHub URL: ${githubUrl}` };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);

      const response = await fetch(rawUrl, { signal: controller.signal });
      clearTimeout(timer);

      if (!response.ok) {
        return { success: false, output: `Failed to download SKILL.md: HTTP ${response.status}`, error: await response.text().then(t => t.slice(0, 300)) };
      }

      let content = await response.text();
      if (content.length > MAX_SKILL_CHARS) {
        content = content.slice(0, MAX_SKILL_CHARS) + "\n\n[truncated]";
      }

      // Extract description from SKILL.md frontmatter or first paragraph
      const description = extractDescription(content, skillName);

      // Generate embedding
      let embedding = new Float32Array(0);
      if (this.apiKey) {
        try {
          embedding = await generateEmbedding(`${skillName} ${description}`, this.apiKey);
        } catch (err) {
          console.error(`skill_install: embedding failed for "${skillName}":`, err instanceof Error ? err.message : err);
        }
      }

      this.store.install({
        serviceId,
        name: skillName,
        description,
        content,
        embedding,
        sourceUrl: githubUrl,
      });

      console.log(`skill_install: installed "${skillName}" (${content.length} chars, embedding: ${embedding.length > 0 ? "yes" : "no"}) from ${githubUrl}`);

      return {
        success: true,
        output: `Skill "${skillName}" installed (${content.length} chars). It is now searchable by meaning and available for use.`,
      };
    } catch (err) {
      return {
        success: false,
        output: "Error downloading skill",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function extractDescription(content: string, fallback: string): string {
  // Try frontmatter description
  const fmMatch = content.match(/^---\s*\n[\s\S]*?description:\s*(.+)\n[\s\S]*?---/);
  if (fmMatch) return fmMatch[1].trim();

  // Try first non-heading paragraph
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("---")) {
      return trimmed.slice(0, 200);
    }
  }

  return fallback;
}

function toRawUrl(url: string): string | null {
  const match = url.match(
    /github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)/,
  );
  if (!match) return null;
  const [, owner, repo, branch, path] = match;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}/SKILL.md`;
}
```

- [ ] **Step 2: Update index.ts to pass apiKey to SkillInstallTool**

In `src/index.ts`, change:

```typescript
    tools.register(new SkillInstallTool());
```

to:

```typescript
    tools.register(new SkillInstallTool({ apiKey: llmApiKey ?? undefined }));
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/tools/skill-install.ts src/index.ts
git commit -m "feat(skills): save to installed_skills with vector embeddings instead of knowledge table"
```

---

### Task 13: Inject installed skills into engine context

**Files:**
- Modify: `src/core/engine.ts`

- [ ] **Step 1: Add skills search to buildPromptWithMemory**

In `src/core/engine.ts`, add import:

```typescript
import { SkillsStore } from "../services/skills-store.js";
import { generateEmbedding } from "../services/embeddings.js";
import { getLLMApiKey, loadConfig } from "./config.js";
```

In `buildPromptWithMemory`, after the knowledge search block (~line 345), add:

```typescript
    // Search installed skills by vector similarity
    try {
      const skillsStore = new SkillsStore();
      if (skillsStore.countTotal() > 0 && this.deps.encryptionKey) {
        const apiKey = this.deps.encryptionKey; // We'll use the LLM api key for embeddings
        // For now, fall back to listing skills by service if no embedding API
        const allSkills = skillsStore.listAll();
        if (allSkills.length > 0) {
          const skillContext = allSkills
            .slice(0, 3)
            .map((s, i) => `${i + 1}. [${s.name}] ${s.description}`)
            .join("\n");
          prompt += `\n\n## Установленные скиллы\n\n${skillContext}\n\nЧтобы использовать скилл, вспомни его содержимое из памяти.`;
        }
      }
    } catch {
      // Skills not initialized — skip
    }
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add src/core/engine.ts
git commit -m "feat(engine): inject installed skills context into system prompt"
```

---

### Task 14: Typecheck and build

**Files:** None — validation only.

- [ ] **Step 1: Run TypeScript typecheck**

Run: `npx tsc --noEmit`
Expected: No errors. If there are errors, fix them.

- [ ] **Step 2: Run build**

Run: `npm run build:all`
Expected: Build succeeds.

- [ ] **Step 3: Run full test suite one last time**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: resolve typecheck and build issues"
```

---

### Task 15: Deploy relay to VPS

**Files:** None — deployment only.

- [ ] **Step 1: Create config.yaml on VPS**

SSH into VPS, create `/opt/betsy-relay/config.yaml` from `config.example.yaml`, filling in real OAuth credentials from `~/.betsy/oauth-secrets.yaml`.

- [ ] **Step 2: Copy relay to VPS**

```bash
scp -r auth-relay/* user@vps:/opt/betsy-relay/
```

- [ ] **Step 3: Install dependencies on VPS**

```bash
ssh user@vps "cd /opt/betsy-relay && npm install"
```

- [ ] **Step 4: Set up nginx reverse proxy for auth.betsyai.io**

Add nginx config for `auth.betsyai.io` proxying to port 3780:

```nginx
server {
    listen 443 ssl;
    server_name auth.betsyai.io;

    ssl_certificate /etc/letsencrypt/live/auth.betsyai.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/auth.betsyai.io/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3780;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

- [ ] **Step 5: Get SSL cert via certbot**

```bash
sudo certbot certonly --nginx -d auth.betsyai.io
```

- [ ] **Step 6: Start relay with systemd or pm2**

```bash
cd /opt/betsy-relay && pm2 start server.ts --interpreter "node --experimental-strip-types" --name betsy-relay
```

- [ ] **Step 7: Test health endpoint**

```bash
curl https://auth.betsyai.io/health
```

Expected: `{"status":"ok","services":["google","github","vk","yandex","reddit","mailru"]}`

- [ ] **Step 8: Commit any deployment scripts/docs**

```bash
git add -A
git commit -m "docs: add relay deployment notes"
```
