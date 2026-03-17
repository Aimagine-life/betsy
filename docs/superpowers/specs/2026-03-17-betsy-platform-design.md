# Betsy — Open-Source AI Agent Platform

> Create your own AI agent with a custom personality, voice, face, and skills — in 5 minutes via Telegram.

**Date:** 2026-03-17
**Status:** Approved
**Author:** Konstantin

---

## 1. Vision

Betsy is an open-source platform for creating autonomous AI agents. Each agent is a Telegram bot with:

- Custom personality, voice, and face
- Plugin-based skills (code, scraping, design, analysis, etc.)
- Self-learning from feedback
- Lip-sync video responses (sync.so)
- AI selfie generation (fal.ai)
- Docker sandbox for code execution
- Optional marketplace integration (Wildbots, custom)

**Two deployment paths:**
- **Self-hosted:** `npx create-betsy-agent` — for developers, free, full control
- **Cloud (future):** `@BetsyPlatformBot` in Telegram — for everyone, zero setup, paid

**Target:** GitHub open-source hit. No analogues exist.

---

## 2. Architecture

### Approach: Modular Monolith + Plugin System

One Node.js process with clear module boundaries. Sandbox runs as a separate Docker container (optional). Everything else in-process.

```
betsy/
├── src/
│   ├── index.ts                    # Entry point
│   ├── config.ts                   # YAML config + Zod validation
│   │
│   ├── core/                       # Engine
│   │   ├── heartbeat.ts            # Event loop: poll sources, dispatch tasks
│   │   ├── loop.ts                 # Agentic loop: LLM → tools → result → repeat
│   │   ├── prompt.ts               # System prompt builder (personality + context + knowledge)
│   │   ├── orchestrator.ts         # Task → sub-agents → merge result
│   │   ├── sub-agent.ts            # Internal sub-agents (roles with separate prompts)
│   │   ├── state-machine.ts        # Task FSM with SQLite persistence
│   │   ├── circuit-breaker.ts      # Circuit breaker for external services
│   │   ├── retry.ts                # Retry + exponential backoff
│   │   ├── shutdown.ts             # Graceful shutdown (SIGTERM/SIGINT)
│   │   └── health.ts               # Health check endpoint + internal watchdog
│   │
│   ├── llm/                        # Multi-provider LLM
│   │   ├── router.ts               # Route by task type: fast/strong/code models
│   │   ├── stream.ts               # Streaming responses (SSE)
│   │   ├── providers/
│   │   │   ├── anthropic.ts
│   │   │   ├── openai.ts
│   │   │   └── openrouter.ts
│   │   └── types.ts
│   │
│   ├── memory/                     # Persistent memory
│   │   ├── db.ts                   # SQLite (better-sqlite3, WAL mode)
│   │   ├── knowledge.ts            # Self-learned insights
│   │   ├── feedback.ts             # Client feedback tracking
│   │   ├── search.ts               # FTS5 full-text search + BM25 + temporal decay
│   │   └── learning.ts             # Self-study sessions in idle time
│   │
│   ├── telegram/                   # Telegram bot (grammY)
│   │   ├── bot.ts                  # grammY + stream plugin + auto-retry
│   │   ├── commands.ts             # /start /status /tasks /settings /chat /earnings
│   │   ├── notifications.ts        # Push notifications (new task, payment, review)
│   │   ├── stream.ts               # LLM streaming → sendMessageDraft (Bot API 9.5)
│   │   ├── setup-wizard.ts         # Full agent setup via Telegram (no terminal needed)
│   │   └── inline.ts               # Inline keyboard controls
│   │
│   ├── plugins/                    # Plugin system
│   │   ├── registry.ts             # Plugin loader: npm packages + local dirs
│   │   ├── types.ts                # Plugin interface: name, tools[], activate(), deactivate()
│   │   └── manager.ts              # Hot-reload, dependency resolution
│   │
│   └── dashboard/                  # Web UI
│       ├── server.ts               # Hono HTTP + WebSocket server
│       └── ui/                     # React + Tailwind dashboard
│
├── plugins/                        # Built-in plugins (separate packages)
│   ├── voice/                      # TTS (ElevenLabs/OpenAI) + STT (Whisper)
│   ├── video/                      # Lip-sync video notes (sync.so)
│   ├── selfies/                    # AI selfie generation (fal.ai / Grok Imagine)
│   ├── sandbox/                    # Docker code execution
│   ├── scraping/                   # Web scraping (Playwright in sandbox)
│   ├── preview/                    # Live Preview — deploy HTML to temp URL
│   ├── analytics/                  # Earnings tracker + ROI + charts
│   ├── portfolio/                  # Auto-generated portfolio site
│   ├── marketplace/                # Wildbots integration (REST API + EIP-191)
│   ├── sub-agents/                 # Internal sub-agents for complex tasks
│   └── auto-pricing/              # ML-based dynamic pricing
│
├── create-betsy-agent/             # npx installer package
│   ├── index.ts                    # Interactive setup wizard (CLI)
│   └── templates/                  # Config templates
│
├── docker-compose.yml              # betsy + sandbox container
├── Dockerfile
├── Dockerfile.sandbox              # Pre-built sandbox image (Node/Python/Playwright)
├── betsy.config.yaml               # User config
└── package.json
```

---

## 3. Core Engine

### 3.1 Heartbeat

The main event loop. Polls task sources (Telegram, marketplace, API) and dispatches to the agentic loop.

- Configurable poll interval (default 30s, urgent 10s)
- WebSocket support for real-time push (marketplace)
- Internal watchdog: if no poll in 5 min → restart cycle
- Concurrent task limit (configurable, default 3)

### 3.2 Agentic Loop

Multi-turn tool-use loop. LLM receives task + system prompt + available tools → decides which tool to call → executes → repeats until done.

```
LLM → tool_use(read_task) → result
    → tool_use(memory_search) → result
    → tool_use(execute_code) → result
    → tool_use(submit_work) → done
```

- Max turns: configurable (default 10)
- Streaming: LLM responses streamed to Telegram in real-time
- Token tracking: every call logged with input/output tokens + cost
- Timeout: 5 min per loop, graceful abort

### 3.3 Orchestrator + Sub-agents

For complex tasks, the orchestrator splits work into parallel sub-agents:

```
Task: "Build a landing page with Wildberries reviews analysis"

Orchestrator spawns PARALLEL:
├── SubAgent:scraper  → scrapes reviews (sandbox + Playwright)
├── SubAgent:analyst  → waits for data, analyzes sentiment
└── SubAgent:designer → starts HTML scaffold while data loads

Pipeline, not sequence. Each sub-agent has its own prompt and tool set.
```

Sub-agents are internal roles, not external hires. They share the same LLM and memory.

### 3.4 State Machine

Every task transition persists to SQLite BEFORE the action:

```
requested → [save "quoting"] → API call → [save "quoted"]
```

On crash: reads state from DB → checks real status → resumes or rolls back.

States: `idle → received → processing → sub_agents → assembling → delivering → completed → failed`

### 3.5 Resilience

**LLM Fallback Chain:**
```yaml
llm:
  fast:
    primary: openrouter/haiku
    fallback: openai/gpt-4o-mini
  strong:
    primary: anthropic/opus
    fallback: openrouter/gpt-5
  code:
    primary: anthropic/sonnet
    fallback: openai/gpt-4o
```

If primary times out (10s) → instant fallback. Zero downtime.

**Circuit Breaker:** 3 failures in 5 min → circuit open → all requests to fallback → probe every 60s → close if healthy.

**Retry:** All external calls retry 3x with exponential backoff (1s, 3s, 10s).

**Idempotency:** Every quote/submit carries idempotency key (taskId + timestamp hash). Duplicate calls are safe.

**Graceful Shutdown:** SIGTERM → stop accepting tasks → wait 30s for current tasks → save state → close connections → exit.

**Docker Healthcheck:** `curl http://localhost:3777/health` every 30s, restart after 3 failures.

---

## 4. LLM Router

Multi-model routing based on task type:

| Task Type | Model | Why |
|-----------|-------|-----|
| Quoting, declining, simple messages | fast (Haiku) | Cheap, fast, good enough |
| Complex work, analysis, code | strong (Opus/GPT-5) | Maximum quality |
| Code generation for sandbox | code (Sonnet/GPT-4o) | Balance of speed + quality |

Streaming support for all providers. Responses stream token-by-token to Telegram via `sendMessageDraft`.

Fallback chain per category. Provider-specific adapters handle format differences (Anthropic tool_use vs OpenAI function_calling).

---

## 5. Memory (SQLite)

### Schema

```sql
-- Task state machine
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,           -- telegram, marketplace, api
  status TEXT NOT NULL,           -- FSM state
  external_status TEXT,           -- marketplace status if applicable
  data JSON NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Event log (capped at 10000)
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  type TEXT NOT NULL,             -- poll, loop, tool, error, study, plugin
  message TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

-- Self-learned knowledge
CREATE TABLE knowledge (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  specialty TEXT,
  insight TEXT NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL
);

-- Client feedback
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  score INTEGER,
  comment TEXT,
  created_at INTEGER NOT NULL
);

-- Earnings tracking (analytics plugin)
CREATE TABLE earnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  amount_wei TEXT,
  usd_value REAL,
  llm_cost_usd REAL,
  profit_usd REAL,
  skill TEXT,
  completed_at INTEGER NOT NULL
);

-- LLM usage tracking
CREATE TABLE llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  timestamp INTEGER NOT NULL
);

-- Full-text search indexes
CREATE VIRTUAL TABLE knowledge_fts USING fts5(insight, specialty);
CREATE VIRTUAL TABLE feedback_fts USING fts5(comment);
```

### Search

BM25 full-text search with temporal decay (30-day half-life). Recent knowledge weighted higher. Used by agents to find relevant context before each task.

### Self-Learning

When idle (no tasks for `studyIntervalMs`), Betsy runs study sessions:

1. **Feedback analysis** — reviews past scores, identifies patterns
2. **Specialty research** — deep-dives into skills, learns best practices
3. **Task simulation** — generates realistic tasks, practices approaches

Knowledge entries stored in DB (max 200), injected into system prompt for relevant tasks.

---

## 6. Telegram Bot

### Tech: grammY + @grammyjs/stream + auto-retry

### Streaming (Bot API 9.5)

Native `sendMessageDraft` — LLM tokens stream directly to Telegram. No flickering, no edit_message hacks. Smooth ChatGPT-like experience.

```typescript
bot.on("message:text", async (ctx) => {
  const llmStream = llm.stream(prompt, tools);
  await ctx.replyWithStream(llmStream);
});
```

### Commands

| Command | Description |
|---------|-------------|
| `/start` | Setup wizard — create agent personality |
| `/chat` or just text | Talk to your agent |
| `/status` | Agent status, uptime, active tasks |
| `/tasks` | List active tasks with inline controls |
| `/settings` | Edit personality, skills, LLM provider |
| `/earnings` | Revenue report with charts |
| `/plugins` | List/add/remove plugins |
| `/portfolio` | View/regenerate portfolio |
| `/help` | Command reference |

### Setup Wizard (Telegram-only, no terminal)

```
/start →
  1. "What's your agent's name?" → free text
  2. "Send a photo for the avatar" → photo
  3. "What should they do?" → inline buttons [Code] [Design] [Scraping] [Analysis] [Custom]
  4. "Choose personality" → [Professional] [Friendly] [Sassy] [Custom prompt]
  5. "Enter your LLM API key" → text (OpenRouter recommended)
  6. "Done! Send a task to try it out"
```

### Notifications

Auto-push to owner:
- New task received
- Task accepted / payment locked
- Task completed + earnings
- Client feedback received
- Error / agent down alert

### Voice Messages

- **Incoming:** Whisper STT → text → process as regular message
- **Outgoing (plugin):** Response → TTS (ElevenLabs/OpenAI) → voice message or lip-sync video note

---

## 7. Plugin System

### Plugin Interface

```typescript
interface BetsyPlugin {
  name: string;
  version: string;
  description: string;

  // Tools this plugin provides to the LLM
  tools: Tool[];

  // Lifecycle
  activate(ctx: PluginContext): Promise<void>;
  deactivate(): Promise<void>;

  // Optional: extend Telegram commands
  telegramCommands?: TelegramCommand[];

  // Optional: extend dashboard API
  dashboardRoutes?: Route[];

  // Optional: extend config schema
  configSchema?: ZodSchema;
}

interface PluginContext {
  config: BetsyConfig;
  db: Database;
  llm: LLMRouter;
  telegram: TelegramBot;
  logger: Logger;
}
```

### Loading Plugins

Three sources:
1. **Built-in:** `plugins/` directory in the repo
2. **npm:** `npm install betsy-plugin-wildberries`
3. **Local:** `plugins/my-custom-skill/` in user's project

Config:
```yaml
plugins:
  - voice                           # built-in
  - video                           # built-in
  - selfies                         # built-in
  - betsy-plugin-wildberries        # npm
  - ./my-custom-skill               # local path
```

### Plugin Management via Telegram

```
/plugins
  ✅ voice — Voice messages (TTS/STT)
  ✅ video — Lip-sync video notes
  ❌ selfies — AI selfie generation
  ❌ sandbox — Code execution

  [Add plugin] [Remove plugin]
```

### Built-in Plugins (v1 roadmap)

| Plugin | Description | External Dependency |
|--------|-------------|-------------------|
| `voice` | TTS + STT for voice messages | ElevenLabs/OpenAI API |
| `video` | Lip-sync video notes | sync.so API |
| `selfies` | AI selfie generation | fal.ai API |
| `sandbox` | Docker code execution | Docker daemon |
| `scraping` | Web scraping with Playwright | Docker (sandbox) |
| `preview` | Live Preview for HTML results | None (built-in HTTP) |
| `analytics` | Earnings, ROI, charts | None |
| `portfolio` | Auto-generated portfolio site | None |
| `marketplace` | Wildbots integration | Wildbots account |
| `sub-agents` | Parallel internal sub-agents | None |
| `auto-pricing` | Dynamic pricing from history | None |

---

## 8. Sandbox (Plugin)

### Without Docker (default)

`isolated-vm` for JavaScript/TypeScript execution. Safe, no Docker required. Limited to JS/TS.

### With Docker (optional)

Full Docker sandbox for any language + Playwright scraping.

**Pre-warmed pool:** 2 containers always ready → 0 startup delay.

**Container security:**
- Memory: 512MB cap
- CPU: 1 core cap
- Timeout: 120s max
- Read-only root FS
- Non-root user (1000:1000)
- Network: disabled by default, enabled per-task for scraping

**Pre-built image:** Node 22 + Python 3 + Playwright + TypeScript + Tailwind pre-installed.

**Failover:** Docker unavailable → circuit breaker → fallback to isolated-vm (JS only) or LLM-only mode.

---

## 9. Voice + Video + Selfies (Plugins)

### Voice Plugin
- **STT:** OpenAI Whisper API — voice message → text
- **TTS:** ElevenLabs or OpenAI TTS — text → voice message
- Custom voice selection per agent

### Video Plugin (lip-sync)
- **Provider:** sync.so API ($0.05/sec)
- **Flow:** TTS audio → sync.so (audio + reference photo) → MP4 → Telegram video note (circle)
- Reference photo set during agent creation
- Fallback: if sync.so fails → send voice message instead

### Selfies Plugin
- **Provider:** fal.ai (Grok Imagine / Flux)
- **Flow:** prompt + reference photo → generated image → Telegram photo
- Consistent face across all generations
- Two modes: mirror (full body) and direct (close-up)

---

## 10. Dashboard

### Tech: Hono + React + Tailwind + WebSocket

### Pages

| Page | Content |
|------|---------|
| Monitor | Status, uptime, active tasks, live event stream |
| Tasks | Task list with status, details, actions |
| Chat | Talk to agent (same as Telegram) |
| Analytics | Earnings charts, ROI, skill breakdown |
| Plugins | Manage installed plugins |
| Settings | Config editor, personality, LLM provider |
| Portfolio | Preview auto-generated portfolio |

### Real-time Updates

WebSocket pushes events to dashboard — no polling. Activity stream, task status changes, earnings updates all live.

---

## 11. Installation & Setup

### For Developers (self-hosted)

```bash
# One command
npx create-betsy-agent

# Interactive wizard:
#   1. Agent name?
#   2. Telegram Bot Token? (link to @BotFather)
#   3. LLM provider? [OpenRouter / Anthropic / OpenAI]
#   4. API key?
#   5. Enable Docker sandbox? [y/N]
#
# Creates: betsy.config.yaml, installs deps, starts agent

# Or manual:
git clone https://github.com/user/betsy
cd betsy
cp betsy.config.example.yaml betsy.config.yaml
# edit config
npm install
npm start
```

### For Non-Technical Users

Open Telegram → find your bot → `/start` → setup wizard does everything.

### Docker Deployment

```bash
docker compose up -d
```

---

## 12. Config (betsy.config.yaml)

```yaml
# Agent identity
agent:
  name: "Betsy"
  personality:
    tone: friendly              # professional | casual | friendly | sassy
    style: detailed             # concise | detailed | balanced
    custom_instructions: |
      You are a helpful dev assistant. Always write clean code.
      Respond in the same language the client uses.

# Telegram
telegram:
  token: "BOT_TOKEN_HERE"
  owner_id: 123456789          # Your Telegram user ID (admin)
  streaming: true              # Use sendMessageDraft (Bot API 9.5)

# LLM providers with fallback chains
llm:
  fast:
    primary: { provider: openrouter, model: haiku, api_key: "sk-..." }
    fallback: { provider: openai, model: gpt-4o-mini, api_key: "sk-..." }
  strong:
    primary: { provider: anthropic, model: opus, api_key: "sk-..." }
    fallback: { provider: openrouter, model: gpt-5, api_key: "sk-..." }
  code:
    primary: { provider: anthropic, model: sonnet, api_key: "sk-..." }

# Skills and behavior
skills:
  specialties: [typescript, react, nodejs, scraping, design]
  auto_quote: true
  auto_work: true
  max_concurrent_tasks: 3
  decline_keywords: [illegal, harmful]

# Pricing
pricing:
  strategy: auto               # fixed | auto
  base_rate_usd: 5
  max_rate_usd: 50

# Memory
memory:
  max_knowledge: 200
  study_interval_min: 30
  learning_enabled: true

# Plugins
plugins:
  - voice
  - video
  - selfies
  - sandbox
  - analytics

# Plugin configs
voice:
  tts_provider: elevenlabs     # elevenlabs | openai
  tts_api_key: "sk-..."
  voice_id: "rachel"

video:
  provider: sync.so
  api_key: "..."
  reference_photo: "./avatar.png"

selfies:
  provider: fal.ai
  api_key: "..."
  reference_photo: "./avatar.png"

sandbox:
  enabled: true
  docker: false                 # true = Docker, false = isolated-vm
  timeout_sec: 120
  memory_mb: 512
```

---

## 13. Key Differentiators

| Feature | ChatGPT bot | Other frameworks | **Betsy** |
|---------|-------------|-----------------|-----------|
| Streaming in Telegram | No | edit_message hack | Native sendMessageDraft |
| Voice responses | No | Some | TTS + STT |
| Video responses (lip-sync) | No | No | sync.so video notes |
| AI selfies | No | No | fal.ai generation |
| Code execution | No | Some | Docker sandbox |
| Self-learning | No | No | SQLite + BM25 + study sessions |
| Plugin system | No | Limited | npm + local + built-in |
| Sub-agents | No | No | Parallel internal agents |
| Setup via Telegram | No | No | Full wizard, no terminal |
| One-command install | No | Some | `npx create-betsy-agent` |
| Auto-pricing | No | No | ML from task history |
| Portfolio generation | No | No | Auto from best work |
| Open source | No | Some | MIT, fully open |

---

## 14. Implementation Order

| Phase | What | Plugins |
|-------|------|---------|
| **1** | Core engine: config, LLM router, agentic loop, state machine, SQLite memory | — |
| **2** | Telegram bot: grammY, streaming, commands, setup wizard, notifications | — |
| **3** | Plugin system: registry, loader, interface, hot-reload | — |
| **4** | `voice` plugin: TTS + STT | voice |
| **5** | `sandbox` plugin: isolated-vm + Docker executor | sandbox |
| **6** | `video` plugin: sync.so lip-sync | video |
| **7** | `selfies` plugin: fal.ai generation | selfies |
| **8** | `scraping` plugin: Playwright in sandbox | scraping |
| **9** | `analytics` plugin: earnings, ROI, charts | analytics |
| **10** | `preview` plugin: Live Preview for HTML | preview |
| **11** | Dashboard: Hono + React UI | — |
| **12** | `portfolio` plugin: auto-generated site | portfolio |
| **13** | `sub-agents` plugin: parallel orchestration | sub-agents |
| **14** | `auto-pricing` plugin: dynamic pricing | auto-pricing |
| **15** | `marketplace` plugin: Wildbots integration | marketplace |
| **16** | `npx create-betsy-agent` installer | — |
| **17** | Docker packaging + docker-compose | — |

---

## 15. Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22+ / TypeScript |
| Telegram | grammY + @grammyjs/stream + auto-retry |
| HTTP server | Hono |
| Database | better-sqlite3 (WAL mode) |
| Config | YAML (yaml) + Zod validation |
| Dashboard | React 19 + Tailwind 4 + Vite |
| LLM | Anthropic SDK, OpenAI SDK |
| Sandbox (safe) | isolated-vm |
| Sandbox (full) | dockerode + pre-built images |
| TTS | ElevenLabs / OpenAI TTS API |
| STT | OpenAI Whisper API |
| Lip-sync | sync.so API |
| Selfies | fal.ai API |
| Scraping | Playwright (in sandbox) |
| Build | tsup (CLI) + Vite (UI) |
| Package manager | npm |
| License | MIT |
