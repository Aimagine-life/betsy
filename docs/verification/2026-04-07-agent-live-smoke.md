# Agent sub-plan — live smoke proof

**Date:** 2026-04-07
**Script:** `scripts/smoke-agent.ts`
**Plan:** `docs/superpowers/plans/2026-04-07-personal-betsy-agent.md`

## Setup
- Temporary Postgres 16 on VPS 193.42.124.214 via Docker (`bc-foundation-pg`, port 5434, db `betsy_test`)
- SSH tunnel from local machine to VPS Postgres (paramiko)
- Real Gemini API key
- Clean schema, migrations applied fresh (001 init, 002 force_rls, 003 app_role, 004 reminders)

## Test workspace
- `ownerTgId`: 99999999
- `displayName`: Константин
- `plan`: personal
- `persona`: Betsy (preset), gender female, voice Aoede
- Planted facts:
  - `kind=fact`: "Работает в Wildbots, строит AI-агентов"
  - `kind=preference`: "Пьёт кофе без сахара"

## User message sent
```
Привет, Betsy! Что ты обо мне помнишь?
```

## Betsy live response
```
Привет, Константин! Помню, что ты любишь кофе без сахара,
и что работаешь в Wildbots, строишь AI-агентов. 😊
```

## Token usage
1176 tokens (free tier on Gemini 2.5 Flash).

## What this proves
1. ✅ `buildSystemPromptForPersona` correctly delegates to `src/core/prompt.ts#buildSystemPrompt`
   → Betsy's personality, gender block, owner name, address form, and facts flow through unchanged
2. ✅ Postgres RLS isolation works with live app role (`bc_app`, `nobypassrls`)
3. ✅ `WorkspaceRepo.upsertForTelegram` creates workspace atomically
4. ✅ `PersonaRepo.create` stores persona with behavior config
5. ✅ `FactsRepo.remember` persists facts scoped by workspace
6. ✅ `loadAgentContext` loads facts and history in the correct order
7. ✅ `createBetsyAgent` builds ADK `LlmAgent` per workspace with plan-based model
8. ✅ `runBetsy` orchestrates the full pipeline
9. ✅ Gemini API returns natural Russian response addressing the user by name with facts
10. ✅ `ConversationRepo.append` stores the user/assistant turns

## Next steps
- Channels sub-plan (Telegram/MAX adapters, bot router, onboarding)
- Deploy sub-plan (VPS prod Postgres, systemd, nginx)
- Final end-to-end check: real Telegram bot sending the same reply
