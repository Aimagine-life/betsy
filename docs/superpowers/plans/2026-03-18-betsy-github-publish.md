# Betsy — GitHub Publish: План реализации

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Превратить Betsy из Telegram-бота в автономного мультиканального AI-агента с agentic loop, инструментами, скиллами и user-friendly установкой через визард.

**Architecture:** Core (agentic loop, tools, LLM, память, скиллы) + Channel adapters (Telegram, Max, Browser) + Plugin system. UI визард + дашборд в браузере.

**Tech Stack:** TypeScript, better-sqlite3 (FTS5), grammY (Telegram), Playwright (виртуальный браузер), React + Tailwind (UI), Zod (validation), WebSocket (browser chat)

**Spec:** `docs/superpowers/specs/2026-03-17-betsy-github-publish-design.md`
**Repo:** `https://github.com/Aimagine-life/betsy`

**Scope:** Это MVP. Отложенные задачи перечислены в конце.

---

## File Structure

### Удаляем:
- `src/wildbots/` — полностью
- `src/marketplace/` — полностью
- `src/loop/` — полностью (переписываем как core/engine.ts)
- `src/heartbeat.ts`
- `src/agent.ts`
- `src/memory/` — старая память (marketplace)
- `src/tools/` — старые tools (marketplace)
- `src/llm/` — старый LLM
- `test/loop.test.ts`

### Создаём:

**Core — ядро агента:**
- `src/core/index.ts` — barrel export
- `src/core/types.ts` — IncomingMessage, OutgoingMessage, LLMMessage
- `src/core/config.ts` — Zod + YAML, ~/.betsy/config.yaml
- `src/core/security.ts` — пароль (PBKDF2), шифрование ключей (AES-256)
- `src/core/engine.ts` — **agentic loop** (multi-turn tool use)
- `src/core/context.ts` — управление контекстом LLM (sliding window + суммаризация)
- `src/core/prompt.ts` — системный промпт + личность
- `src/core/costs.ts` — отслеживание расходов (токены × цена модели)
- `src/core/updates.ts` — проверка обновлений через GitHub API
- `src/core/llm/router.ts` — fast/strong роутер
- `src/core/llm/types.ts` — LLMClient, LLMResponse, LLMStreamChunk
- `src/core/llm/providers/openrouter.ts` — OpenRouter провайдер
- `src/core/memory/db.ts` — SQLite + FTS5
- `src/core/memory/knowledge.ts` — база знаний
- `src/core/memory/learning.ts` — самообучение

**Tools — инструменты агента:**
- `src/core/tools/types.ts` — Tool interface, ToolResult
- `src/core/tools/registry.ts` — реестр инструментов
- `src/core/tools/shell.ts` — выполнение команд
- `src/core/tools/files.ts` — чтение/запись файлов
- `src/core/tools/http.ts` — HTTP-запросы
- `src/core/tools/browser.ts` — Playwright (виртуальный браузер)
- `src/core/tools/memory.ts` — поиск/сохранение знаний
- `src/core/tools/npm-install.ts` — установка пакетов
- `src/core/tools/scheduler.ts` — планировщик задач
- `src/core/tools/self-config.ts` — изменение настроек
- `src/core/tools/ssh.ts` — подключение к серверам

**Skills — навыки агента:**
- `src/core/skills/types.ts` — Skill interface
- `src/core/skills/manager.ts` — загрузка, запуск, CRUD скиллов
- `src/core/skills/builtin/monitor.ts` — мониторинг сайта
- `src/core/skills/builtin/daily-summary.ts` — ежедневная сводка

**Channels — адаптеры каналов:**
- `src/channels/types.ts` — Channel interface
- `src/channels/telegram/index.ts` — Telegram адаптер
- `src/channels/telegram/handlers.ts` — обработчики команд/сообщений
- `src/channels/telegram/voice.ts` — TTS + STT
- `src/channels/telegram/video.ts` — видео-кружочки
- `src/channels/telegram/selfies.ts` — AI-селфи
- `src/channels/browser/index.ts` — Browser-канал (WebSocket)

**Plugins:**
- `src/plugins/types.ts` — Plugin interface
- `src/plugins/registry.ts` — реестр плагинов

**Server + UI:**
- `src/server.ts` — HTTP + WebSocket сервер
- `src/index.ts` — entry point (переписать)
- `src/ui/pages/Wizard.tsx` — визард (5 шагов)
- `src/ui/pages/wizard/ApiKeyStep.tsx`
- `src/ui/pages/wizard/PasswordStep.tsx`
- `src/ui/pages/wizard/PersonalityStep.tsx`
- `src/ui/pages/wizard/ChannelsStep.tsx`
- `src/ui/pages/wizard/DoneStep.tsx`
- `src/ui/pages/Status.tsx` — статус + расходы
- `src/ui/pages/BrowserChat.tsx` — чат в браузере
- `src/ui/pages/Tasks.tsx` — активные задачи с прогрессом
- `src/ui/pages/Skills.tsx` — управление скиллами
- `src/ui/pages/Backup.tsx` — экспорт/импорт

**Docker:**
- `Dockerfile`
- `.dockerignore`

**Tests:**
- `test/core/engine.test.ts`
- `test/core/config.test.ts`
- `test/core/security.test.ts`
- `test/core/context.test.ts`
- `test/core/tools/shell.test.ts`
- `test/core/tools/browser.test.ts`
- `test/core/tools/memory.test.ts`
- `test/core/skills/manager.test.ts`
- `test/channels/telegram.test.ts`
- `test/channels/browser.test.ts`
- `test/server.test.ts`
- `test/integration.test.ts`

---

## Phase 1: Зачистка

### Task 1: Удалить marketplace-код

**Files:**
- Delete: `src/wildbots/`, `src/marketplace/`, `src/loop/`, `src/heartbeat.ts`, `src/agent.ts`, `src/memory/`, `src/tools/`, `src/llm/`, `test/loop.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Удалить файлы**

```bash
rm -rf src/wildbots src/marketplace src/loop src/memory src/tools src/llm
rm src/heartbeat.ts src/agent.ts
rm test/loop.test.ts
```

- [ ] **Step 2: Удалить зависимости из package.json**

Удалить: `viem`, `minisearch`
Добавить: `playwright` (виртуальный браузер)

- [ ] **Step 3: npm install**

- [ ] **Step 4: Коммит**

```bash
git add -A && git commit -m "chore: remove marketplace code, add playwright"
```

---

## Phase 2: Core — ядро агента

### Task 2: Типы и интерфейсы

**Files:** `src/core/types.ts`, `src/channels/types.ts`, `src/core/tools/types.ts`

- [ ] **Step 1: Написать тест** (`test/core/types.test.ts`)
- [ ] **Step 2: Создать src/core/types.ts** — IncomingMessage, OutgoingMessage, LLMMessage
- [ ] **Step 3: Создать src/channels/types.ts** — Channel interface
- [ ] **Step 4: Создать src/core/tools/types.ts** — Tool, ToolResult, ToolParam

```typescript
interface Tool {
  name: string
  description: string           // описание для LLM
  parameters: ToolParam[]       // параметры для LLM
  requiresConfirmation?: boolean // опасный инструмент?
  execute(params: Record<string, unknown>): Promise<ToolResult>
}

interface ToolResult {
  success: boolean
  output: string
  error?: string
}
```

- [ ] **Step 5: Тесты проходят**
- [ ] **Step 6: Коммит**

### Task 3: Конфиг

**Files:** `src/core/config.ts`, `test/core/config.test.ts`

- [ ] **Step 1: Тест** — loadConfig/saveConfig, null если нет файла
- [ ] **Step 2: Реализация** — Zod-схема, YAML, ~/.betsy/config.yaml
- [ ] **Step 3: Тест проходит**
- [ ] **Step 4: Коммит**

### Task 4: Безопасность

**Files:** `src/core/security.ts`, `test/core/security.test.ts`

- [ ] **Step 1: Тест** — hashPassword, verifyPassword, encrypt, decrypt
- [ ] **Step 2: Реализация** — PBKDF2 + AES-256-GCM, node:crypto
- [ ] **Step 3: Тест проходит**
- [ ] **Step 4: Коммит**

### Task 5: LLM (перенос из telegram/)

**Files:** `src/core/llm/`

- [ ] **Step 1: Скопировать** telegram/llm/ → core/llm/
- [ ] **Step 2: Обновить импорты**, убрать зависимость от telegram/config
- [ ] **Step 3: Тест** — создание роутера, получение fast/strong клиента
- [ ] **Step 4: Коммит**

### Task 6: Память (перенос из telegram/)

**Files:** `src/core/memory/`

- [ ] **Step 1: Скопировать** telegram/memory/ → core/memory/
- [ ] **Step 2: Обновить импорты**
- [ ] **Step 3: Тест** — addKnowledge, searchKnowledge, FTS5
- [ ] **Step 4: Коммит**

### Task 7: Промпт и личность

**Files:** `src/core/prompt.ts`

- [ ] **Step 1: Скопировать** telegram/core/prompt.ts → core/prompt.ts
- [ ] **Step 2: Убрать Telegram-специфику** (response mode теги)
- [ ] **Step 3: Тест** — buildSystemPrompt с personality
- [ ] **Step 4: Коммит**

### Task 8: Управление контекстом LLM

**Files:** `src/core/context.ts`, `test/core/context.test.ts`

- [ ] **Step 1: Тест** — sliding window обрезает длинную историю, суммаризация

```typescript
describe('Context', () => {
  it('keeps last N messages within token limit', () => {
    const ctx = new ContextManager({ maxTokens: 4000 })
    // добавить 100 сообщений
    const trimmed = ctx.getMessages(history)
    // должно быть <= maxTokens
  })

  it('summarizes old messages', async () => {
    const ctx = new ContextManager({ maxTokens: 4000, llm: mockLLM })
    // должен вызвать LLM для суммаризации
  })
})
```

- [ ] **Step 2: Реализация** — sliding window + LLM-суммаризация старых сообщений
- [ ] **Step 3: Тест проходит**
- [ ] **Step 4: Коммит**

---

## Phase 3: Tools — инструменты

### Task 9: Tool registry

**Files:** `src/core/tools/registry.ts`

- [ ] **Step 1: Реализация** — регистрация, получение, список tools
- [ ] **Step 2: Коммит**

### Task 10: Tool — shell

**Files:** `src/core/tools/shell.ts`, `test/core/tools/shell.test.ts`

- [ ] **Step 1: Тест** — выполнить `echo hello`, получить output

```typescript
it('executes command and returns output', async () => {
  const tool = new ShellTool()
  const result = await tool.execute({ command: 'echo hello' })
  expect(result.success).toBe(true)
  expect(result.output.trim()).toBe('hello')
})

it('returns error for bad command', async () => {
  const tool = new ShellTool()
  const result = await tool.execute({ command: 'nonexistent_command_xyz' })
  expect(result.success).toBe(false)
})
```

- [ ] **Step 2: Реализация** — child_process.exec с timeout, blacklist опасных команд
- [ ] **Step 3: Тест проходит**
- [ ] **Step 4: Коммит**

### Task 11: Tool — files

**Files:** `src/core/tools/files.ts`, `test/core/tools/files.test.ts`

- [ ] **Step 1: Тест** — read, write, list
- [ ] **Step 2: Реализация** — fs.readFile, fs.writeFile, fs.readdir
- [ ] **Step 3: Коммит**

### Task 12: Tool — http

**Files:** `src/core/tools/http.ts`

- [ ] **Step 1: Реализация** — fetch wrapper с timeout, возвращает body/status/headers
- [ ] **Step 2: Коммит**

### Task 13: Tool — browser (Playwright)

**Files:** `src/core/tools/browser.ts`, `test/core/tools/browser.test.ts`

- [ ] **Step 1: Тест** — open URL, get text content, take screenshot

```typescript
it('opens page and returns text', async () => {
  const tool = new BrowserTool()
  const result = await tool.execute({
    action: 'get_text',
    url: 'https://example.com'
  })
  expect(result.success).toBe(true)
  expect(result.output).toContain('Example Domain')
})
```

- [ ] **Step 2: Реализация**

Действия:
- `get_text` — открыть URL, вернуть текст страницы
- `screenshot` — открыть URL, вернуть скриншот (base64)
- `search` — Google search, вернуть результаты
- `click` — кликнуть по элементу
- `fill` — заполнить форму
- `evaluate` — выполнить JS на странице

Playwright запускается lazy (при первом вызове). Один браузер на весь процесс.
При первом запуске — автоматическая установка Chromium с прогрессом.

- [ ] **Step 3: Тест проходит**
- [ ] **Step 4: Коммит**

### Task 14: Tool — memory

**Files:** `src/core/tools/memory.ts`

- [ ] **Step 1: Реализация** — search, save, delete через core/memory/
- [ ] **Step 2: Коммит**

### Task 15: Tool — npm_install

**Files:** `src/core/tools/npm-install.ts`

- [ ] **Step 1: Реализация** — `npm install <package>` с проверкой: пакеты `betsy-*` без подтверждения, остальные требуют подтверждения
- [ ] **Step 2: Коммит**

### Task 16: Tool — scheduler

**Files:** `src/core/tools/scheduler.ts`

- [ ] **Step 1: Реализация** — cron-like планировщик на node-cron или setTimeout. CRUD задач, хранение в SQLite.
- [ ] **Step 2: Коммит**

### Task 17: Tool — self_config

**Files:** `src/core/tools/self-config.ts`

- [ ] **Step 1: Реализация** — чтение/изменение config.yaml через core/config
- [ ] **Step 2: Коммит**

### Task 18: Tool — ssh

**Files:** `src/core/tools/ssh.ts`

- [ ] **Step 1: Реализация** — подключение к серверу, выполнение команд через `node-ssh`
- [ ] **Step 2: Коммит**

---

## Phase 4: Agentic Loop

### Task 19: Engine — agentic loop

**Files:** `src/core/engine.ts`, `test/core/engine.test.ts`

Это центральный компонент — многоходовой цикл с инструментами.

```typescript
class Engine {
  constructor(deps: { llm: LLMRouter, config: BetsyConfig, tools: ToolRegistry })

  // Основной метод — обрабатывает сообщение через agentic loop
  async process(msg: IncomingMessage): Promise<OutgoingMessage>

  // Один шаг цикла
  private async step(messages: LLMMessage[]): Promise<{ done: boolean, response?: string }>

  // Callback для прогресса (шаг выполнен, инструмент вызван)
  onProgress(handler: (status: string) => void): void
}
```

Логика `process()`:
1. Построить системный промпт (personality + knowledge + facts)
2. Добавить сообщение пользователя в историю
3. **Цикл:**
   a. Вызвать LLM с историей + описаниями tools
   b. Если LLM вернул tool_call:
      - Проверить requiresConfirmation → спросить владельца
      - Выполнить tool → получить result
      - Добавить tool_call + result в историю
      - Отправить прогресс через onProgress
      - Вернуться к (a)
   c. Если LLM вернул текст → это ответ, выход из цикла
4. Сохранить ответ в историю
5. Извлечь факты фоново
6. Вернуть OutgoingMessage

- [ ] **Step 1: Тест**

```typescript
describe('Engine — agentic loop', () => {
  it('simple message — no tools, direct response', async () => {
    const mockLLM = createMockLLM([
      { type: 'text', text: 'Привет!' }
    ])
    const engine = new Engine({ llm: mockLLM, config: testConfig, tools: emptyRegistry })
    const res = await engine.process(msg('Привет'))
    expect(res.text).toBe('Привет!')
  })

  it('uses tool and returns final response', async () => {
    const mockLLM = createMockLLM([
      { type: 'tool_call', name: 'shell', params: { command: 'echo 42' } },
      { type: 'text', text: 'Результат: 42' }
    ])
    const engine = new Engine({ llm: mockLLM, config: testConfig, tools: toolsWithShell })
    const res = await engine.process(msg('Запусти echo 42'))
    expect(res.text).toBe('Результат: 42')
  })

  it('multi-step: tool → tool → response', async () => {
    const mockLLM = createMockLLM([
      { type: 'tool_call', name: 'shell', params: { command: 'ls' } },
      { type: 'tool_call', name: 'files', params: { action: 'read', path: 'README.md' } },
      { type: 'text', text: 'Вот содержимое файла...' }
    ])
    const engine = new Engine({ llm: mockLLM, config: testConfig, tools: fullRegistry })
    const res = await engine.process(msg('Покажи README'))
    expect(res.text).toContain('содержимое')
  })

  it('sends progress updates', async () => {
    const progress: string[] = []
    const engine = new Engine({ llm: mockLLMWithTools, config: testConfig, tools: fullRegistry })
    engine.onProgress(status => progress.push(status))
    await engine.process(msg('Найди информацию'))
    expect(progress.length).toBeGreaterThan(0)
  })

  it('respects max turns limit', async () => {
    // LLM бесконечно вызывает tools
    const engine = new Engine({ llm: infiniteToolLLM, config: testConfig, tools: fullRegistry })
    const res = await engine.process(msg('Зациклись'))
    expect(res.text).toContain('лимит') // должен остановиться
  })
})
```

- [ ] **Step 2: Реализация** — полный agentic loop с tool_call parsing, progress callback, max turns
- [ ] **Step 3: Добавить подтверждение опасных команд** — если tool.requiresConfirmation, спросить владельца
- [ ] **Step 4: Тесты проходят**
- [ ] **Step 5: Коммит**

### Task 20: Отслеживание расходов

**Files:** `src/core/costs.ts`

- [ ] **Step 1: Реализация** — считать токены каждого вызова LLM, хранить в SQLite, API для дашборда
- [ ] **Step 2: Коммит**

### Task 21: Проверка обновлений

**Files:** `src/core/updates.ts`, `test/core/updates.test.ts`

- [ ] **Step 1: Тест** — mock GitHub API, проверка semver
- [ ] **Step 2: Реализация** — fetch GitHub releases, сравнить версии
- [ ] **Step 3: Коммит**

---

## Phase 5: Skills

### Task 22: Skills manager

**Files:** `src/core/skills/types.ts`, `src/core/skills/manager.ts`, `test/core/skills/manager.test.ts`

```typescript
interface Skill {
  name: string
  description: string
  trigger: string | { scheduler: string }
  steps: SkillStep[]
}

class SkillManager {
  load(): Skill[]                           // загрузить из ~/.betsy/skills/
  save(skill: Skill): void                  // сохранить
  delete(name: string): void                // удалить
  run(name: string, engine: Engine): Promise<string>  // запустить
  list(): Skill[]                           // список
}
```

- [ ] **Step 1: Тест** — save/load/delete/list скиллов
- [ ] **Step 2: Реализация**
- [ ] **Step 3: Коммит**

### Task 23: Встроенные скиллы

**Files:** `src/core/skills/builtin/`

- [ ] **Step 1: monitor.ts** — мониторинг сайта (перенос из telegram/monitor.ts, адаптация к tools)
- [ ] **Step 2: daily-summary.ts** — ежедневная сводка (статистика за день)
- [ ] **Step 3: Коммит**

---

## Phase 6: Channels

### Task 24: Telegram адаптер

**Files:** `src/channels/telegram/`

- [ ] **Step 1: Создать TelegramChannel** — implements Channel interface

```typescript
class TelegramChannel implements Channel {
  name = 'telegram'
  requiredConfig = ['token']

  async start(config) {
    // 1. Создать Bot(token) с autoRetry
    // 2. Зарегистрировать команды через handlers.ts
    // 3. Фильтр: только ownerChatId, остальным — "Я персональный бот"
    // 4. Конверсия grammY Message → IncomingMessage
    // 5. Вызов handler → получение OutgoingMessage
    // 6. Отправка: text/voice/video/selfie в зависимости от mode
    // 7. bot.start()
  }
}
```

- [ ] **Step 2: Перенести handlers.ts** — команды /start, /status, /help, /study, /voice, /video, /selfie
- [ ] **Step 3: Перенести voice.ts** — STT (Whisper) + TTS (MiniMax/OpenAI)
- [ ] **Step 4: Перенести video.ts, selfies.ts**
- [ ] **Step 5: Стриминг** — sendMessageDraft для потокового ответа
- [ ] **Step 6: Тест**
- [ ] **Step 7: Коммит**

### Task 25: Browser канал

**Files:** `src/channels/browser/index.ts`, `test/channels/browser.test.ts`

- [ ] **Step 1: Реализация** — WebSocket сервер, стриминг через SSE
- [ ] **Step 2: Тест**
- [ ] **Step 3: Коммит**

### Task 26: Plugins (перенос)

**Files:** `src/plugins/`

- [ ] **Step 1: Скопировать** telegram/plugins/ → src/plugins/
- [ ] **Step 2: Коммит**

---

## Phase 7: Server + UI

### Task 27: HTTP-сервер

**Files:** `src/server.ts`, `test/server.test.ts`

Endpoints:
- `GET /` → React UI
- `POST /api/auth` → пароль → JWT
- `GET /api/status` → каналы, память, tools, расходы
- `GET /api/config` → конфиг (ключи маскированы)
- `POST /api/config` → сохранить конфиг (из визарда)
- `GET /api/costs` → расходы по дням/моделям
- `GET /api/skills` → список скиллов
- `POST /api/backup/export` → скачать zip
- `POST /api/backup/import` → загрузить zip
- `WS /chat` → browser-канал

- [ ] **Step 1: Реализация**
- [ ] **Step 2: Тест** — auth, protected routes, config endpoints
- [ ] **Step 3: Коммит**

### Task 28: Entry point

**Files:** `src/index.ts`

- [ ] **Step 1: Переписать**

```typescript
async function main() {
  const config = loadConfig()

  if (!config) {
    // Первый запуск — визард
    console.log('🦀 Betsy запускается...')
    await startServer(null)
    console.log(`🌐 Открой: http://${getAddress()}:3777`)
    return
  }

  // Нормальный запуск
  const llm = new LLMRouter(config.llm)
  const tools = createToolRegistry(config)
  const engine = new Engine({ llm, config, tools })
  const channels: Channel[] = []

  // Browser — всегда
  channels.push(new BrowserChannel())

  // Telegram — если включён
  if (config.channels.telegram?.enabled)
    channels.push(new TelegramChannel())

  // Запуск
  await startServer(engine, channels)
  for (const ch of channels) {
    ch.onMessage(msg => engine.process(msg))
    await ch.start(config.channels[ch.name] || {})
  }

  // Фоновые процессы
  startLearningLoop(config, llm)
  startScheduler(config, engine)
  checkForUpdates(config, channels)

  // Playwright
  console.log('📥 Проверяю виртуальный браузер...')
  await ensurePlaywrightInstalled()

  console.log('🦀 Betsy запускается...')
  console.log(`🌐 Открой: http://${getAddress()}:3777`)
}
```

- [ ] **Step 2: Коммит**

### Task 29: UI — Визард

**Files:** `src/ui/pages/Wizard.tsx`, `src/ui/pages/wizard/*`

- [ ] **Step 1: Wizard.tsx** — 5 шагов, прогресс-бар, всё на русском
- [ ] **Step 2: ApiKeyStep.tsx** — OpenRouter ключ + ссылка
- [ ] **Step 3: PasswordStep.tsx** — пароль + подтверждение
- [ ] **Step 4: PersonalityStep.tsx** — имя, тон, стиль, инструкции
- [ ] **Step 5: ChannelsStep.tsx** — карточки каналов
- [ ] **Step 6: DoneStep.tsx** — чат + ссылки
- [ ] **Step 7: Коммит**

### Task 30: UI — Дашборд

**Files:** `src/ui/pages/Status.tsx`, `src/ui/pages/BrowserChat.tsx`, `src/ui/pages/Tasks.tsx`, `src/ui/pages/Skills.tsx`, `src/ui/pages/Backup.tsx`

- [ ] **Step 1: Status.tsx** — каналы, tools, память, расходы
- [ ] **Step 2: BrowserChat.tsx** — WebSocket чат со стримингом
- [ ] **Step 3: Tasks.tsx** — активные задачи с прогресс-баром
- [ ] **Step 4: Skills.tsx** — список скиллов, создание, удаление
- [ ] **Step 5: Backup.tsx** — экспорт/импорт
- [ ] **Step 6: Обновить App.tsx** — навигация: Главная, Чат, Задачи, Скиллы, Бэкап, Настройки
- [ ] **Step 7: Убрать marketplace UI** (Tasks marketplace, Setup wallet/register)
- [ ] **Step 8: Коммит**

---

## Phase 8: Финализация

### Task 31: Удалить старый telegram/ и config.ts

- [ ] **Step 1: `rm -rf src/telegram src/config.ts`**
- [ ] **Step 2: `npx tsc --noEmit`** — проверка компиляции
- [ ] **Step 3: `npx vitest run`** — все тесты
- [ ] **Step 4: Коммит**

### Task 32: package.json + README + Docker

- [ ] **Step 1: Обновить package.json** — name: "betsy", version 0.2.0, добавить playwright
- [ ] **Step 2: README.md на русском** (из спека секция 17)
- [ ] **Step 3: betsy.config.yaml.example** (новая схема)
- [ ] **Step 4: .gitignore** — .betsy/, data/, dist/, *.log
- [ ] **Step 5: Dockerfile**

```dockerfile
FROM node:22-slim
RUN npx playwright install --with-deps chromium
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
EXPOSE 3777
CMD ["node", "dist/index.js"]
```

- [ ] **Step 6: .dockerignore**
- [ ] **Step 7: Коммит**

### Task 33: Git cleanup — секреты

- [ ] **Step 1: BFG Repo Cleaner** — удалить betsy.config.yaml из всей истории
- [ ] **Step 2: git gc --prune=now --aggressive**
- [ ] **Step 3: Проверить** — `git log --all --full-history -- betsy.config.yaml` → пусто

### Task 34: Интеграционный тест

**Files:** `test/integration.test.ts`

- [ ] **Step 1: Тест** — message → engine (agentic loop) → tool call → response

```typescript
describe('Integration', () => {
  it('full flow: message → tool → response', async () => {
    const engine = createTestEngine()
    const res = await engine.process(msg('Выполни echo hello'))
    expect(res.text).toContain('hello')
  })

  it('browser channel receives response', async () => {
    // WebSocket test
  })
})
```

- [ ] **Step 2: Тест проходит**
- [ ] **Step 3: Коммит**

### Task 35: Финальная проверка

- [ ] **Step 1: Чистая установка** — `git clone && npm install && npm run build && npm run dev`
- [ ] **Step 2: Визард в браузере** — пройти все 5 шагов
- [ ] **Step 3: Чат в браузере** — сообщение → ответ
- [ ] **Step 4: Agentic loop** — попросить выполнить команду → подтвердить → результат
- [ ] **Step 5: Telegram** — `/start <код>` → бот отвечает
- [ ] **Step 6: npm test** — все тесты
- [ ] **Step 7: Финальный коммит + тег**

```bash
git commit --allow-empty -m "release: v0.2.0 — autonomous AI agent"
git tag v0.2.0
```

---

## Отложено (отдельные планы)

1. **Channel: Max** — адаптер для мессенджера Max
2. **betsy-install** — SSH-установщик для VPS (отдельный npm-пакет)
3. **Самодобавление каналов** — npm search + LLM-генерация кода
4. **Голосовые ответы в браузере** — Web Audio API
5. **Docker Hub** — CI/CD для сборки и публикации образа
6. **npm publish** — CI/CD для публикации на npm
7. **Видео-кружочки + селфи** — выделить в плагины
8. **Мета-скилл "Создание скилла"** — LLM генерирует YAML скилл из описания
9. **Уведомления об обновлениях** — отправка во все каналы
10. **HTTPS** — Let's Encrypt интеграция для VPS
