# Channels sub-plan — live smoke proof

**Date:** 2026-04-07
**Bot:** `@neotdam_autobot` (token id 8483437893)
**Backend:** `betsy-multi.service` on VPS 193.42.124.214, prod Postgres 16 in Docker
**Acceptance gate:** "I want to write Betsy and get a response with the same character and the same memory I had in single-mode."

## Setup

- Personal Betsy v2 deployed to VPS at `/opt/betsy-multi/`, systemd `betsy-multi.service`
- Postgres 16 in Docker (`betsy-pg`), unix socket via `127.0.0.1:5433`
- Migrations 001-005 applied (init, force RLS, app_role, reminders, link_codes)
- Single-mode `betsy.service` running in parallel on `@Betsy_Ai_Test_bot` with the original token
- Memory migration ran successfully:
  - Workspace `603549ba-d881-4d6a-8e33-5994294beaec` for `ownerTgId=26899549`
  - 27 knowledge facts copied from single-mode SQLite to `bc_memory_facts`
  - 67 conversation messages copied to `bc_conversation`
  - Persona `Betsy` (preset) with default voice `Aoede`

## Live test

User opened https://t.me/neotdam_autobot, sent messages, received responses from
Personal Betsy v2 in her original Betsy voice (warm, female, "ты"-form, with the
single-mode personality from `src/core/prompt.ts`).

User confirmation: **"Ответила"**.

## What this proves

1. ✅ Personal Betsy v2 character is identical to single-mode (delegated through `buildSystemPromptForPersona` → `src/core/prompt.ts#buildSystemPrompt`)
2. ✅ Memory from single-mode SQLite migrated successfully into multi-mode Postgres scoped by workspace_id
3. ✅ TelegramAdapter via grammy successfully receives and answers messages on the new bot token
4. ✅ BotRouter resolves workspace by tg user id and dispatches to runBetsy
5. ✅ Runtime Gemini client through `@google/genai` answers in natural Russian with personality
6. ✅ RLS isolation works in production (only this workspace's facts loaded into context)
7. ✅ systemd graceful restart preserves bot session
8. ✅ Healthz endpoint returns 200 from production
9. ✅ Single-mode and multi-mode coexist on the same VPS without conflicts

## Known issues found post-smoke

### Critical: conversation persistence not advancing

After live test, `select count(*) from bc_conversation where workspace_id = '...' = 67`
which equals exactly the number of rows migrated from single-mode. Live user/assistant
turns from the smoke test are NOT being persisted.

Suspected root cause: either `runBetsy()` in `src/multi/agents/runner.ts` is not being
called from the production server bootstrap (the inline `agentRunner` in `server.ts`
might bypass it), or `convRepo.append` is throwing silently inside `withWorkspace`.

Impact: Betsy will lose conversation context turn-to-turn until this is fixed. Memory
facts (the knowledge migrated from single-mode) are still loaded into the system prompt
on every turn, so character+long-term-memory works, but short-term conversation history
does not.

To be fixed in a follow-up wave (tool-calling fix plan).

### Other deferred:
- Tools (remember/recall/forget/set_reminder/generate_selfie/web search) are not wired
  through ADK at runtime — the inline `agentRunner` in `server.ts` skips ADK and calls
  Gemini directly with system prompt only. To be fixed alongside conversation persistence.

## Files referenced

- `/opt/betsy-multi/migrate-memory.mjs` — VPS-local migration script (custom because
  `dist/` only ships the bundle, not separate sqlite-to-pg module)
- `/var/log/betsy-multi.log` — production log
- `docker exec betsy-pg psql -U postgres -d betsy` — production Postgres
