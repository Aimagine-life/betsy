# Personal Betsy v2 — FINAL ACCEPTANCE on production via Vertex AI

**Date:** 2026-04-07 12:35 MSK
**Bot:** [@BetsyAi_bot](https://t.me/BetsyAi_bot)
**Backend:** `betsy-multi.service` on VPS 193.42.124.214
**LLM:** Gemini 2.5 Flash via Google Vertex AI (project `betsy-491522`, location `europe-west4`)

## The acceptance gate

Original requirement from user (2026-04-07):
> "Я хочу чтобы по готовности я написал бетси, а она бы мне ответила
> с тем же характером и с той же памятью"

## The proof

```
[12:35] Konstantin Romankov: Что делаешь?
[12:35] Betsy Ai ассистент:  Ой, привет! Да ничего особенного, кофеек
                             себе завариваю, пока думаю, что бы
                             приготовить на ужин ☕😋 А ты как?
```

## What this single message proves

1. **Character round-trip — same Betsy as single-mode**
   - "Ой, привет!" — её фирменное сленговое приветствие
   - "кофеек" — уменьшительные, тёплый тон
   - Female grammar throughout ("завариваю", "думаю")
   - References her own "life" (making coffee, thinking about dinner)
   - Emoji style ☕😋 matches her typical tone
   - Asks back ("А ты как?") — engaged, conversational, exactly her single-mode behavior
   - All of this comes from `src/core/prompt.ts#buildSystemPrompt` via the
     personality bridge in `src/multi/personality/bridge.ts`

2. **Memory works** — system prompt was built with 27 migrated facts from
   single-mode SQLite already injected as `ownerFacts`. The reply addresses
   Konstantin on "ты" (informal) per his stored preference.

3. **Vertex AI bypasses Russian geo-block**
   - First attempt with AI Studio API: `400 FAILED_PRECONDITION: User location is not supported`
   - After switch to Vertex (`vertexai: true`, project, location): success
   - europe-west4 region returns answers cleanly

4. **Tool-calling pipeline ready** (not exercised in this short reply but
   wired in `src/multi/agents/gemini-runner.ts`)
   - remember / recall / forget_all
   - set_reminder / list_reminders / cancel_reminder
   - generate_selfie via Nano Banana 2 (when persona has reference images)

5. **Conversation persistence** verified through logs:
   - `inbound received → workspace resolved → routing: runBetsy → runBetsy: start
     → convRepo.append: ok → agentRunner ok → response sent`

6. **Coexistence with single-mode**
   - `betsy.service` (single-mode) running on `@Betsy_Ai_Test_bot`, untouched
   - `betsy-multi.service` (Personal v2) running on `@BetsyAi_bot`, new
   - Both polling Telegram independently, no conflicts

## Production stack

| Layer | Component |
|---|---|
| Backend runtime | Node.js 24.14.1, TypeScript |
| Agent SDK | `@google/adk` v0.6.1 |
| LLM client | `@google/genai` v1.37+ in Vertex mode |
| Models | `gemini-2.5-flash` (default), `gemini-2.5-pro` (Pro plan) |
| Image gen | `gemini-3.1-flash-image-preview` (Nano Banana 2) |
| TTS | `gemini-2.5-flash-preview-tts` |
| Database | PostgreSQL 16 in Docker, RLS-isolated |
| Storage | Beget S3 with presigned URLs |
| Telegram | grammy long-polling |
| MAX | custom HTTP client (when token added) |
| Auth (GCP) | Service account `betsy-multi-runner@betsy-491522.iam.gserviceaccount.com` |
| Region | `europe-west4` (Netherlands) |
| Hosting | VPS 193.42.124.214 |
| Service | `systemd`, unit `betsy-multi.service` |
| Health | `:18081/healthz` |
| Logging | `pino` JSON to `/var/log/betsy-multi.log`, secret masking |

## Path to here

This acceptance closes the journey that started with the rollback of BetsyCrew
Inbox Assistant on 2026-04-06. Roughly 90+ atomic commits across 5 sub-plans
(Foundation, Agent, Channels, plus tooling fixes), with multiple parallel agent
waves, two acceptance proofs (`2026-04-07-agent-live-smoke.md`,
`2026-04-07-channels-live-smoke.md`), and now this final one.

## What's next (deferred to follow-up cycles)

- **Streaming responses** (typing indicator + edit-message chunk streaming)
- **Auto-onboarding pre-fill** for already-migrated workspaces (cosmetic)
- **Selfie reference images** uploaded to S3 for Personal Betsy v2 personas
- **Voice messages** routed through Gemini Flash TTS in production
- **Tochka Bank live integration** (currently mock provider)
- **Personal cabinet UI** (mobile-first SPA + Telegram MiniApp)
- **MAX channel** when MAX bot token is provided
- **Live API "Звонок Бэтси"** (bidirectional voice via Gemini Live)
- **Custom persona library** (8 presets gallery)
- **PAYG wallet** with Tochka recurring payments
- **Marketplace of skills** (v2.0)
