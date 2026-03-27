import { getDB } from "../core/memory/db.js";
import { encrypt, decrypt } from "./crypto.js";

export interface SaveTokenParams {
  serviceId: string;
  userId: string;
  accessToken: string;
  refreshToken?: string;
  scopes: string;
  expiresAt: number;
}

export interface StoredToken {
  serviceId: string;
  userId: string;
  accessToken: string;
  refreshToken: string | null;
  scopes: string;
  expiresAt: number;
  createdAt: number;
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
    const rows = db.prepare("SELECT * FROM service_tokens WHERE user_id = ?").all(userId) as TokenRow[];
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
