# Betsy auth-relay

Standalone OAuth relay service for Betsy Personal v2 (multi-tenant mode).

## What it is

`auth-relay` is a tiny standalone Node.js HTTP service that runs on
`auth.betsyai.io` (or equivalent) and performs interactive OAuth 2.0
consent flows with upstream providers (Google, Notion) on behalf of
Betsy workspaces.

It is deliberately decoupled from the main multi-server:

- No database access. No `workspace_id`-scoped Postgres calls.
- Only talks to the OAuth provider and to the multi-server.
- Token delivery to the multi-server uses an HMAC-signed POST to
  `/oauth/token` (contract lives in `src/multi/oauth/relay-callback.ts`).

## Why it's separate

1. **Callback URL stability.** Google/Notion require the redirect URI
   to be registered statically. Pinning it to a dedicated hostname
   (`auth.betsyai.io/callback`) lets us redeploy the main app behind
   any URL without reconfiguring OAuth clients.
2. **Blast radius.** The relay handles third-party OAuth codes but
   never touches the database. A compromise of the relay would leak at
   most the shared HMAC secret, not workspace data.
3. **Operational independence.** The relay can be restarted, scaled,
   or replaced without downtime on the main product.

## Flow

```
User                Relay (auth.betsyai.io)      Google           Multi-server (api.betsyai.io)
 |                          |                      |                        |
 | GET /start?provider=...  |                      |                        |
 |-------------------------->                      |                        |
 | 302 -> Google authorize  |                      |                        |
 |<--------------------------                      |                        |
 | GET accounts.google.com  |                      |                        |
 |------------------------------------------------->                        |
 | consent + redirect       |                      |                        |
 |<-------------------------------------------------                        |
 | GET /callback?code=..&state=nonce                |                        |
 |-------------------------->                      |                        |
 |                          | POST /token (code -> tokens)                  |
 |                          |--------------------->                        |
 |                          |<---------------------                         |
 |                          | POST /oauth/token (HMAC-signed)               |
 |                          |---------------------------------------------->|
 |                          |<----------------------------------------------|
 | 302 -> return_to?status=ok                      |                        |
 |<--------------------------                      |                        |
```

## Env vars

| Var | Required | Description |
|---|---|---|
| `BC_RELAY_PORT` | no | HTTP port to bind. Default `3787`. |
| `BC_RELAY_PUBLIC_URL` | yes | Public HTTPS URL, e.g. `https://auth.betsyai.io`. Used to build the `redirect_uri`. |
| `BC_UPSTREAM_URL` | yes | Multi-server base URL, e.g. `https://api.betsyai.io`. The relay POSTs to `${UPSTREAM}/oauth/token`. |
| `BC_OAUTH_RELAY_SECRET` | yes | HMAC-SHA256 secret, shared with the multi-server. |
| `BC_RELAY_ALLOWED_RETURN_TO` | yes | Comma-separated list of allowed origins for the `return_to` query param (e.g. `https://app.betsyai.io,https://dash.betsyai.io`). |
| `BC_GOOGLE_CLIENT_ID` | one of | Google OAuth client id. |
| `BC_GOOGLE_CLIENT_SECRET` | one of | Google OAuth client secret. |
| `BC_NOTION_CLIENT_ID` | opt | Notion OAuth client id. |
| `BC_NOTION_CLIENT_SECRET` | opt | Notion OAuth client secret. |

At least one provider pair must be set.

## Local run

```bash
export BC_RELAY_PORT=3787
export BC_RELAY_PUBLIC_URL=http://127.0.0.1:3787
export BC_UPSTREAM_URL=http://127.0.0.1:3778
export BC_OAUTH_RELAY_SECRET=dev-secret
export BC_RELAY_ALLOWED_RETURN_TO=http://127.0.0.1:5173
export BC_GOOGLE_CLIENT_ID=...apps.googleusercontent.com
export BC_GOOGLE_CLIENT_SECRET=...

npm run auth-relay           # tsx dev run
npm run auth-relay:build     # tsup build -> dist/auth-relay/
npm run auth-relay:sim       # end-to-end simulation, exits 0 on success
```

## Production deployment

1. **TLS termination** — put nginx or caddy in front, terminate HTTPS
   for `auth.betsyai.io`, reverse-proxy to `127.0.0.1:${BC_RELAY_PORT}`.
2. **Systemd unit** — see `deploy/auth-relay.service` (TODO: add to
   infra repo). Minimal example:

   ```ini
   [Unit]
   Description=Betsy auth-relay
   After=network.target

   [Service]
   Type=simple
   User=betsy
   EnvironmentFile=/etc/betsy/auth-relay.env
   WorkingDirectory=/opt/betsy-auth-relay
   ExecStart=/usr/bin/node dist/auth-relay/server.cjs
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```
3. **Provider console** — register the redirect URI
   `https://auth.betsyai.io/callback` with Google, Notion, etc.
4. **Shared secret** — generate a strong secret (`openssl rand -hex 32`)
   and put it in BOTH `auth-relay.env` and the multi-server env as
   `BC_OAUTH_RELAY_SECRET`. Rotate by deploying simultaneously.

## Trust model

- The relay holds the OAuth client_secret for each provider and the
  HMAC upstream secret. It does NOT hold any user token after the
  callback completes — everything is immediately forwarded upstream.
- The multi-server verifies every POST on `/oauth/token` with
  timing-safe HMAC + anti-replay (±300s timestamp skew).
- The relay rejects any `return_to` URL that is not in the
  operator-configured allowlist, preventing open-redirect abuse.
- Authorization codes, access tokens, refresh tokens and client
  secrets are NEVER written to stdout/stderr. Logs contain only
  provider id, workspace id, nonce prefix, and status.

## Security checklist (pre-production)

- [ ] `BC_RELAY_PUBLIC_URL` uses `https://` (a warning is logged otherwise).
- [ ] `BC_OAUTH_RELAY_SECRET` ≥ 32 random bytes, different from dev.
- [ ] `BC_RELAY_ALLOWED_RETURN_TO` lists only your real front-end origins.
- [ ] Provider redirect URIs in their consoles match `${BC_RELAY_PUBLIC_URL}/callback` exactly.
- [ ] Clock is NTP-synced (±300s tolerance for HMAC timestamp).
- [ ] Reverse proxy strips any incoming `X-Relay-*` headers from the internet.

## Files

```
src/auth-relay/
├── README.md           — this file
├── types.ts            — shared types
├── config.ts           — env var loader + return_to allowlist
├── providers.ts        — Google/Notion provider registry
├── state-store.ts      — in-memory CSRF state with TTL
├── rate-limit.ts       — per-IP rate limiter for /start
├── google-exchange.ts  — Google token endpoint client
├── notion-exchange.ts  — Notion token endpoint client
├── upstream-client.ts  — HMAC-signed POST to multi-server
├── server.ts           — HTTP handlers + routing + bootstrap
└── sim.ts              — end-to-end local simulation
```

Tests live under `tests/auth-relay/`.
