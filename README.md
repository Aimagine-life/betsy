<p align="right">
  <a href="README.ru.md">🇷🇺 Русский</a> | 🇬🇧 English
</p>

<p align="center">
  <img src="https://i.ibb.co/rKmJSLvZ/photo-2026-03-19-00-33-38.jpg" alt="Betsy" width="300" />
</p>

<h1 align="center">Betsy</h1>

<p align="center">
  <b>AI companion with personality, voice, memory, and her own face</b>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#features">Features</a> •
  <a href="#server-deployment">Server Deployment</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#development">Development</a>
</p>

---

## Not just a bot. A companion.

Betsy is an **autonomous AI agent** that lives on your server. She has her own personality, voice, face — and she gets things done on her own. She doesn't wait for commands — she acts. She doesn't forget — she learns. She doesn't go down at night because of a zero balance — she switches to a free model and keeps working.

She can be anyone — from a caring friend to a tough mentor. It all depends on how you set her up.

## Work and play. Your perfect AI companion.

<p align="center">
  <img src="https://i.ibb.co/1fL31BmX/photo-2026-03-18-23-54-53.jpg" alt="Betsy — work and play" width="400" />
</p>

Betsy is equally great at business tasks and casual conversation. Morning — meeting reminders and news digest. Afternoon — information search, file management, command execution. Evening — heart-to-heart talks, jokes, and selfies on request.

## Any avatar. Any personality.

Want Brad Pitt? Done. Want your first grade teacher? Sure. Want a grumpy sysadmin who only replies when he's in the mood? Go for it.

Personality is set in the config: name, gender, tone, style, custom instructions. Everything else — voice, avatar, communication style — adapts accordingly.

<p align="center">
  <img src="https://i.ibb.co/4n5g1nCH/photo-2026-03-19-00-18-21.jpg" alt="Customizable personality" width="400" />
</p>

## Why Betsy?

| | Regular chatbots | **Betsy** |
|---|---|---|
| **Personality** | Template responses | Customizable character, tone, style |
| **Memory** | Forgets after restart | Remembers everything, learns from conversations |
| **Voice** | Text only | Voice messages, video circles, selfies |
| **Actions** | Only responds | Executes commands, browses the web, works with files |
| **Uptime** | Goes down on zero balance | Auto-fallback to free models |
| **Control** | Someone else's server | Your server, your data |

## Features

### 🗣 Voice

Send a voice message — she replies with a voice message. Via MiniMax (built-in) or ElevenLabs (vast voice library). When the voice matches the personality — it's a whole different experience.

### 🎥 Video circles

Betsy sends video circles with lip-sync — lips move in sync with speech. Like a real video call, but in Telegram.

<p align="center">
  <img src="https://i.ibb.co/7N0tSqnj/0319-1.gif" alt="Betsy video circles in Telegram" width="350" />
</p>

### 📸 Selfies

Ask and she'll send one. Sometimes she'll send one on her own. Generated via fal.ai with consistent appearance from a reference photo. She works out and takes care of herself — here's proof:

<p align="center">
  <img src="https://i.ibb.co/qFR5dGXC/photo-2026-03-18-11-19-30.jpg" alt="Betsy works out — proof" width="400" />
</p>

She's also diligent — sends proof of her work:

<p align="center">
  <img src="https://i.ibb.co/8gCfNnW9/photo-2026-03-18-22-45-29.jpg" alt="Betsy sends proof of work" width="400" />
</p>

### 🧠 Memory & self-learning

Remembers what you talked about before. Doesn't ask the same thing ten times. Extracts facts from conversations and saves them to a knowledge base. Without memory, the whole "personality" falls apart after a reboot — that's why it was the first thing I built.

### 💬 Reply context awareness

Reply to a week-old message — she'll understand what you're talking about. If there was an image — she'll understand that too. No need to re-explain context.

### 🔄 Never goes down

Balance ran out? Automatically switches to free models via OpenRouter. Cycles through a chain of models until it finds a working one. Balance replenished? Switches back to the main model on its own. Betsy is **always** available.

```yaml
llm:
  fast_model: google/gemini-2.5-flash        # fast responses
  strong_model: anthropic/claude-sonnet-4     # complex tasks
  fallback_models:                             # when balance hits zero
    - qwen/qwen3-coder:free
    - meta-llama/llama-3.3-70b-instruct:free
```

### 🔧 Autonomous agent

Doesn't just answer questions — **does things**. Multi-step agentic loop: gets a task → calls tools → checks result → repeats until done.

<p align="center">
  <img src="https://i.ibb.co/3mDy1f6h/photo-2026-03-19-00-36-15.jpg" alt="Helpful assistant" width="400" />
</p>

### ⏰ Notifications & schedules

One-time reminders, recurring tasks, daily digests. Or just "did you eat today?" — depends on what personality you set up.

### 🌐 Virtual browser

Can browse websites on her own, search for information, read pages, and take screenshots. Via Playwright — a full headless browser.

### 🔌 Self-extension

Can install npm packages, change her own settings, connect new channels and plugins. Grows with you.

## Quick Start

```bash
# Install Node.js → https://nodejs.org

npx betsy
```

A browser will open — follow the wizard steps (60 seconds):

1. **API key** — register at [openrouter.ai](https://openrouter.ai) (free)
2. **Password** — to protect settings
3. **Personality** — name, character, communication style
4. **Channels** — Telegram, browser, and more
5. **Done** — chat right in the browser

## Server Deployment

```bash
npx betsy-install
```

Enter your server's IP, login, and password — the installer does everything: installs dependencies, configures systemd, launches Betsy.

### Docker

```bash
docker run -d \
  --name betsy \
  -p 3777:3777 \
  -v betsy-data:/root/.betsy \
  aimagine/betsy
```

## Channels

| Channel | Status | Requirements |
|---------|--------|-------------|
| 🌐 Browser | ✅ Ready | Nothing — enabled by default |
| 📱 Telegram | ✅ Ready | Token from [@BotFather](https://t.me/BotFather) |
| 💬 MAX Messenger | 🔜 Coming soon | — |

## 11 tools out of the box

| Tool | What it does |
|------|-------------|
| `shell` | Execute terminal commands |
| `files` | Read, write, list files |
| `http` | HTTP requests to any API |
| `web` | Web search |
| `browser` | Full browser — navigation, screenshots, page reading |
| `memory` | Search and save knowledge |
| `scheduler` | Reminders and recurring tasks |
| `selfie` | Selfie generation |
| `self_config` | Modify own settings |
| `npm_install` | Install npm packages |
| `ssh` | Connect to servers |

## Configuration

Config is stored in `~/.betsy/config.yaml`:

```yaml
agent:
  name: Betsy
  gender: female
  personality:
    tone: friendly          # friendly | professional | casual | sassy
    style: detailed         # concise | detailed | balanced
    custom_instructions: |
      You are a smart and fun assistant.

llm:
  provider: openrouter
  api_key: YOUR_OPENROUTER_API_KEY
  fast_model: google/gemini-2.5-flash
  strong_model: anthropic/claude-sonnet-4

channels:
  browser:
    enabled: true
  telegram:
    enabled: false
    token: YOUR_TELEGRAM_BOT_TOKEN

plugins:
  voice:
    enabled: false
  video:
    enabled: false
  selfies:
    enabled: false
```

## Architecture

```
betsy/
├── src/
│   ├── core/
│   │   ├── engine.ts       ← Agentic loop (LLM → tools → repeat)
│   │   ├── llm/            ← LLM router + OpenRouter provider + fallback
│   │   ├── memory/         ← SQLite: knowledge base, self-learning
│   │   ├── skills/         ← Skills (daily-summary, monitor)
│   │   └── tools/          ← 11 tools
│   ├── channels/
│   │   ├── telegram/       ← Telegram (grammy) + voice + video
│   │   └── browser/        ← WebSocket chat
│   ├── plugins/            ← Plugin registry
│   ├── server.ts           ← HTTP + WebSocket + JWT
│   └── ui/                 ← React + Tailwind (Vite)
│       └── pages/          ← Wizard, Chat, Status, Skills, Backup
```

## Roadmap

- 🎭 Personality gallery — pick a character from a catalog
- 💬 MAX Messenger — new channel
- 📦 MSI installer for Windows — download, run, done
- 🎙 ElevenLabs — expanded voice selection

## Development

```bash
npm run dev          # Dev server with hot-reload
npm run build:all    # Build backend and frontend
npm test             # Tests (vitest)
npm run typecheck    # Type checking
```

## Requirements

- Node.js 20+
- [OpenRouter](https://openrouter.ai) API key

## License

MIT — [Wildbots](https://github.com/wildbots)
