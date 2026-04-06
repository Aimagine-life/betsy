# Betsy

Autonomous AI assistant with personality, voice, video circles, and self-learning.

## Commands

```bash
npm run build        # Build backend (tsup)
npm run build:ui     # Build frontend (Vite)
npm run build:all    # Build both
npm run dev          # Run dev server (tsx)
npm run typecheck    # TypeScript check (tsc --noEmit)
npm test             # Run tests (vitest)
```

## Architecture

- **src/core/engine.ts** — Agentic loop (LLM → tool calls → repeat, max 20 turns)
- **src/core/tools/** — Tool system: `Tool` interface + `ToolRegistry`. Each tool is a class implementing `Tool`
- **src/core/llm/** — LLM router, OpenRouter provider
- **src/core/memory/** — SQLite-based memory (better-sqlite3): knowledge base, learning
- **src/core/skills/** — Betsy's skill system (built-in: daily-summary, monitor)
- **src/core/config.ts** — YAML config loader (zod schema), config lives at `~/.betsy/config.yaml`
- **src/channels/** — Communication channels: `telegram` (grammy), `browser` (WebSocket)
- **src/server.ts** — HTTP server + WebSocket + JWT auth + static file serving
- **src/plugins/** — Plugin registry and types
- **src/ui/** — React + Tailwind frontend (Vite), pages: BrowserChat, Status, Skills, Wizard, Backup

## Key Patterns

- Tools implement `Tool` interface from `src/core/tools/types.ts` (name, description, parameters, execute)
- Tools are registered via `ToolRegistry.register(tool)`
- Config is validated with zod, supports both flat and nested LLM formats
- Server uses raw `node:http` + `ws`, no Express
- JWT auth with HS256 (node:crypto, no library)
- Dangerous shell commands are blacklisted in `ShellTool`

## Config

- Config file: `~/.betsy/config.yaml` (see `betsy.config.yaml.example`)
- Contains API keys — never commit real config
- Docker exposes port 3777

## Language

- Project UI and logs are in Russian
- Code and comments are in English

## Personal Betsy v2 — multi-tenant mode

- `BETSY_MODE=multi` dispatches to `src/multi/server.ts` (Personal Betsy v2 SaaS).
- `src/core/*` and `src/channels/*` are **single-mode only** — they must stay pure and not know about `workspace_id`.
- `src/multi/*` may import from `src/core/*` but never vice-versa.
- All multi-tenant DB access goes through `withWorkspace(pool, workspaceId, fn)` from `src/multi/db/rls.ts`. Postgres Row-Level Security enforces isolation at the database level.
- `asAdmin(pool, fn)` bypasses RLS only for system operations (creating new workspaces, billing reconciliation). Never pass user input as workspace_id to `asAdmin`.
- Env vars for multi-mode: `BC_*` prefix. Single-mode env stays as is.
- New runtime deps for multi live under `src/multi/` only.
- Tests for multi live in `tests/multi/` mirror structure of `src/multi/`.
- Integration tests (against real Postgres) are gated on `BC_TEST_DATABASE_URL` env var and skip otherwise.
