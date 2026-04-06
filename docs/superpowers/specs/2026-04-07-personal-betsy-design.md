# Personal Betsy v2 — Design Spec

**Дата:** 2026-04-07
**Статус:** Active, заменяет BetsyCrew Inbox Assistant (откачен 2026-04-06)
**Название продукта:** Personal Betsy (платформа — BetsyCrew)

## 1. Видение

Personal Betsy — это мульти-тенантная SaaS-обёртка над существующей single-mode Betsy. Каждый платящий подписчик получает свою личную Betsy с её характером, голосом, селфи, памятью и возможностями. Юзер общается с ней в Telegram или MAX (общая память между каналами), настраивает в личном кабинете на сайте / в Telegram MiniApp / в MAX MiniApp. Оплачивает подписку + PAYG-кошелёк для медиа через Точку Банк.

**Критически важно:** вайб, характер, personality, wizard-настройки и визуал Betsy сохраняются 1:1 из single-mode. Не новый продукт — **та же Betsy, но доступная миллионам через подписку**.

## 2. Архитектурный принцип

**Google ADK для TypeScript + Gemini + существующий код Betsy.** Мы не переписываем ядро, мы:
1. Создаём параллельный слой `src/multi/` для multi-tenant оркестрации
2. Существующие tools из `src/core/tools/` адаптируем под `FunctionTool` интерфейс ADK
3. Single-mode TS Betsy (`src/index.ts` → `src/server.ts`) продолжает работать на VPS на `:3777` параллельно
4. Multi-mode — новый entrypoint, новый systemd unit, другой порт

Правило изоляции: `src/core/*` не знает о `workspace_id`. `src/multi/*` оборачивает core и добавляет per-workspace контекст.

## 3. Технический стек

### Backend
- **Node.js 24.13+** (требование `@google/adk`)
- **TypeScript** — как сейчас
- **`@google/adk` v0.6.1+** — агентский движок (LlmAgent, workflow agents, multi-agent, MCP toolset, sessions)
- **`@google/genai` v1.37+** — для прямых вызовов Gemini (селфи через Nano Banana 2, TTS, Live API в v1.1)
- **PostgreSQL 16** — multi-tenant данные с Row-Level Security
- **`pg` + Drizzle ORM** — типизированный доступ
- **Alembic-аналог для node** — `drizzle-kit` для миграций
- **`pg-boss`** — очереди задач (напоминания, дайджесты, авто-топап)
- **`grammy`** — Telegram, как в single-mode
- **Собственный MAX-клиент** — `fetch` с `Authorization: <token>` header (SDK `@maxhub/max-bot-api` не используем — там забагованная auth схема)
- **`@aws-sdk/client-s3`** — Beget S3 (`s3.ru1.storage.beget.cloud`, bucket `64d9bd04fc15-betsy-ai`)
- **`pino`** — structured logging с автоматической маскировкой секретов
- **`zod`** — env validation + tool parameter schemas
- **`vitest`** — тесты

### LLM и AI
- **Gemini 2.5 Flash** — Personal tier (text, tool use, web search)
- **Gemini 2.5 Pro** — Pro tier (text, tool use, web search, длинный контекст)
- **Nano Banana 2** = `gemini-3.1-flash-image-preview` — селфи и reference-based image generation
- **Gemini Flash Preview TTS** = `gemini-2.5-flash-preview-tts` — голосовые ответы (default voice: **Aoede**)
- **Implicit prompt caching** включён автоматом (бесплатное storage, 90% скидка на reads)
- **Один `GEMINI_API_KEY`** покрывает всё: text, search, image, TTS
- **Web search**: нативный ADK `GOOGLE_SEARCH` tool (`import { GOOGLE_SEARCH } from "@google/adk/dist/esm/tools/google_search_tool.js"` — deep import из-за barrel-бага v0.6.1)
- **НЕ используем**: fal.ai для селфи, Grok Imagine, ElevenLabs, OpenAI TTS, OpenRouter
- **Используем fal.ai** только для видео-кружочков (как в single-mode)

### Frontend
- **React 19 + Vite + TypeScript + Tailwind 4** — как сейчас
- Существующий single-mode UI остаётся
- Новый код: `src/ui/cabinet/` — личный кабинет (mobile-first bottom tabs)
- Один билд работает как standalone сайт, Telegram MiniApp, MAX MiniApp

### Инфра
- VPS `193.42.124.214` (существующий)
- nginx + Let's Encrypt (сертификат `crew.betsyai.io` уже выпущен и хранится)
- systemd unit `betsy-multi.service` (новый, рядом с существующим `betsy.service`)
- Postgres 16 в Docker-контейнере на `127.0.0.1:5433`
- Backups: `pg_dump` ежедневно + WAL archiving на отдельный диск, retention 30 дней, шифрование GPG

## 4. Продуктовые решения

### 4.1 Каналы и связывание
- **Telegram и MAX** — long-polling, оба параллельно
- **Один человек = один workspace**. Связывается через команду `/link`:
  1. Юзер в первом канале пишет `/link` → бот выдаёт 6-значный код, TTL 10 минут, one-shot
  2. Юзер во втором канале пишет этот код → канал прицепляется к тому же workspace
  3. После — общая память, общая подписка, общий PAYG-кошелёк
- **Защита**: 5 кодов в час на workspace; попытка объединить два существующих workspace требует явного подтверждения
- **Реплай**: входящее в TG → ответ в TG. Входящее в MAX → ответ в MAX. Без кросс-канальной синхронизации сообщений.
- **Напоминания и проактивные сообщения**: каскад правил (§4.5)

### 4.2 Онбординг
Короткий 3-шаговый диалог в боте после `/start`:
1. «Привет! Я Betsy. Как тебя зовут?»
2. «Чем ты обычно занимаешься? Расскажи в двух словах — это поможет мне быть тебе полезной.»
3. «На «ты» или на «вы»?» (кнопки)

После — галерея персонажей (§4.3), выбор тарифа (§4.4), приветствие в вайбе Betsy.

### 4.3 Персонажи
**8 стартовых пресетов** в галерее:

| ID | Имя | Описание | Default голос |
|---|---|---|---|
| `betsy` | Betsy | Заботливая, знающая (оригинал) | Aoede |
| `alex` | Алекс | Деловой, сухой, для бизнеса | Charon |
| `lina` | Лина | Креативная, для контента | Puck |
| `doc` | Док | Медицинский ассистент, осторожный | Enceladus |
| `kesha` | Кеша | Мужской, юморной, друган | Puck |
| `sofi` | Софи | Мягкая, для ментального здоровья | Aoede |
| `max` | Макс | Спортивный коуч | Charon |
| `maria` | Мария | Мама-помощница, расписания/дети | Aoede |

Каждый пресет — YAML файл в `src/multi/personas/library/<id>.yaml`:
```yaml
id: betsy
name: Betsy
gender: female
voice_id: Aoede
personality_prompt: |
  Ты Betsy — заботливая помощница...
sample_phrases:
  - "Привет! Что у тебя сегодня?"
tags: [универсальная, дружелюбная]
```

**Три пути в онбординге**:
1. **Выбрать пресет** → дальше можно кастомизировать всё (имя, аватар, голос, биография, тон, характер)
2. **Создать с нуля** → пустой wizard (переиспользуем `src/ui/pages/Wizard.tsx`)
3. **Загрузить свой аватар** → подсказка загрузить фронтальное фото → Nano Banana 2 генерирует 3/4 и профиль ракурсы → три референса сохраняются

**Аватары в S3**:
```
workspaces/<ws_uuid>/persona/
  reference_front.png     # для Nano Banana 2 character consistency
  reference_three_q.png
  reference_profile.png
  avatar.png              # уменьшенная для UI
```

**Смена персонажа в кабинете**:
- Текущий персонаж сверху с кнопкой «Сменить»
- Кнопка «Сменить» → галерея заново
- Переключение **не сбрасывает память** по умолчанию (чекбокс «сбросить память при смене»)
- Кнопка «Тонкая настройка» — открывает wizard текущего персонажа
- Кнопка «Создать нового с нуля»

### 4.4 Тарифы и биллинг

| Тариф | Цена | Что входит |
|---|---|---|
| **Trial** | 7 дней бесплатно | Gemini 2.5 Flash, 100K токенов, базовая память, без селфи/видео |
| **Personal** | 990₽/мес | Gemini 2.5 Flash, 1M токенов/мес, голос TTS, web search, 10 скиллов, память без лимита |
| **Pro** | 2490₽/мес | Gemini 2.5 Pro, 3M токенов/мес, Pro TTS, приоритет в очереди, все скиллы, расширенная память |

**PAYG-кошелёк** (поверх подписки, через Точку Банк):
- **Селфи**: 10₽ (себестоимость Nano Banana 2 ≈ 5₽)
- **Видео-кружочки** (fal.ai lip-sync): 50₽ (себестоимость ≈ 30₽)
- **Голос и web search** — **не в PAYG**, входят в подписку
- **Быстрые суммы пополнения**: 200₽ / 500₽ / 1000₽ / 2000₽

**Сохранённая карта**:
- Показ маски (`VISA ••4444`), срок, статус
- Кнопки «Заменить карту» и «Удалить»

**Авто-пополнение кошелька**:
- Настройка «когда баланс падает ниже X — списать Y с карты»
- По умолчанию выключено
- Лимит безопасности: **не более 5000₽/мес** автосписаний на workspace

**Отписка**:
- Кнопка в кабинете → диалог подтверждения
- Доступ сохраняется до конца оплаченного периода
- Память хранится 6 месяцев после отмены на случай возврата
- Полное удаление аккаунта — отдельная кнопка «Удалить аккаунт» с более жёстким подтверждением

**Платёжный провайдер — абстракция**:
```ts
// src/multi/billing/types.ts
interface PaymentProvider {
  createPayment(input: CreatePaymentInput): Promise<{id: string; checkoutUrl: string}>
  chargeSaved(paymentMethodId: string, amount: number, meta: PaymentMeta): Promise<ChargeResult>
  cancelRecurrent(paymentMethodId: string): Promise<void>
  verifyWebhook(headers: Record<string,string>, rawBody: string): WebhookEvent
}

// src/multi/billing/providers/mock.ts — для разработки
// src/multi/billing/providers/tochka.ts — когда получим креды
```

Webhook URL: `https://crew.betsyai.io/webhook/billing`, защищён IP allowlist + HMAC/Basic auth (уточнится по доке Точки).

Webhook `metadata.kind` различает типы событий:
- `subscription` — активация/продление тарифа
- `topup` — пополнение кошелька

### 4.5 Напоминания и проактивные сообщения

**Правило 0 (главное)**: когда Betsy создаёт напоминание, она записывает `preferred_channel` = текущий канал разговора.

**Каскад при срабатывании**:
1. Если `workspace.notify_channel_pref` задан вручную через `/notify` → туда (override всего)
2. Иначе если `preferred_channel` (из правила 0) ещё доступен → туда
3. Иначе fallback на `last_active_channel`
4. Иначе любой доступный канал с пометкой «отправила сюда, потому что X недоступен»
5. Одно напоминание = один канал, без дублей

**Команда `/notify`**: три кнопки Telegram / MAX / Auto (default = Auto).

Напоминания сохраняются в `bc_reminders` таблице, срабатывают через pg-boss cron.

### 4.6 Поведение Betsy — настройки

В кабинете → Персонаж → «Стиль ответов»:

```
Голосовые ответы
○ Только текст
○ Голос если я прислал голосовое
○ Голос всегда когда уместно
● На усмотрение Betsy

Селфи
○ Никогда сама
● Только по моему запросу
○ В особых моментах (утренний привет, праздники)
○ На усмотрение Betsy

Видео-кружочки
○ Никогда сама
● Только по моему запросу
○ На усмотрение Betsy
```

**Правила**:
- «На усмотрение Betsy» — модель тратит PAYG **без подтверждения** (юзер уже дал согласие выбором этого режима)
- Фиксированный режим — следует буквально
- Дефолт для новых: голос «на усмотрение», селфи и видео «только по моему запросу»
- **Runaway protection**: не более 5 платных медиа в час даже в режиме «на усмотрение»

### 4.7 Скиллы (MCP + custom tools)

**v1.0 каталог** (30-40 скиллов, делаем сами):
- Наши custom: память (remember/recall/forget), напоминания, селфи (Nano Banana 2), видео-кружочки (fal.ai), голос (TTS), current_time, calculator, файловые операции в песочнице workspace
- Built-in ADK: Google Search, Code Execution (проверим наличие TS-обёртки)
- MCP-серверы: Gmail, Google Calendar, Notion, Fetch, Tavily (если Google Search не хватит)

**Установка скиллов**:
- **Автоматическая через Betsy**: юзер просит «подключи Gmail» → Betsy зовёт `connect_service` tool → OAuth relay (`auth.betsyai.io`) → после успеха MCP-сервер регистрируется для workspace динамически
- **Ручная через кабинет**: Ещё → Подключённые сервисы → Каталог → выбрать → OAuth → готово
- **OAuth подтверждение обязательно через кабинет** (не через чат), защита от prompt injection

**Несколько аккаунтов одного сервиса**: для Gmail/Calendar/Notion поддерживаем несколько аккаунтов, Betsy выбирает на основе контекста или спрашивает. Для GitHub/Slack — один на workspace в v1.0.

### 4.8 Селфи через Nano Banana 2

```ts
// src/multi/tools/selfie-tool.ts
export const selfieTool = new FunctionTool({
  name: "generate_selfie",
  description: "Создать селфи Betsy в указанной сцене. Списывает 10₽ с PAYG.",
  parameters: z.object({
    scene: z.string(),
    aspect: z.enum(["3:4", "1:1", "9:16"]).default("3:4"),
  }),
  execute: async ({scene, aspect}, ctx) => {
    const reservation = await walletService.reserve(ctx.workspaceId, 1000) // копейки
    if (!reservation.ok) return {error: "Недостаточно средств. /topup"}
    
    const refs = await s3.fetchPersonaReferences(ctx.workspaceId)
    const response = await genai.models.generateContent({
      model: "gemini-3.1-flash-image-preview",
      contents: [{
        role: "user",
        parts: [
          ...refs.map(r => ({inlineData: {mimeType: "image/png", data: r.base64}})),
          {text: `Это Betsy. Сохрани её лицо, волосы, стиль. Сгенерируй селфи: ${scene}`}
        ]
      }],
      config: {
        responseModalities: ["IMAGE"],
        imageConfig: {aspectRatio: aspect, imageSize: "1K"}
      }
    })
    
    const s3Key = await s3.uploadSelfie(ctx.workspaceId, extractImageData(response))
    const url = await s3.signedUrl(ctx.workspaceId, s3Key, 3600)
    await walletService.commit(reservation.id)
    return {success: true, imageUrl: url, cost: "10₽"}
  }
})
```

### 4.9 Голос через Gemini TTS

```ts
// src/multi/tools/voice-output.ts
export async function speak(workspaceId: string, text: string, voice: string = "Aoede"): Promise<Buffer> {
  const response = await genai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{parts: [{text}]}],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {voiceConfig: {prebuiltVoiceConfig: {voiceName: voice}}}
    }
  })
  
  const pcmData = extractAudioData(response)  // 24kHz PCM16
  return convertToOggOpus(pcmData)  // для Telegram voice message
}
```

Вызывается из bot-router'а когда модель вернула текстовый ответ и поведение персонажа говорит «озвучить».

## 5. Кабинет (UI)

### 5.1 Точки входа
- **Standalone web**: `https://cabinet.betsyai.io` (новый домен/поддомен)
- **Telegram MiniApp**: кнопка «⚙️ Кабинет» в боте → `Telegram.WebApp` открывает тот же сайт, авторизация через `initData`
- **MAX MiniApp**: аналогично через MAX API

### 5.2 Структура навигации — Mobile-first Bottom Tabs

| Таб | Содержимое |
|---|---|
| 🏠 Главная | Персонаж Betsy + статус тарифа, использование токенов, баланс PAYG, ближайшее напоминание, связанные каналы |
| 🧠 Память | Переключатель: Факты / Диалоги / Знания. Список с таймстемпами. Удаление отдельных. Кнопка «Забыть всё» |
| 💰 Тариф | Текущий план, сохранённая карта, PAYG-кошелёк, авто-пополнение, история платежей, отписка |
| ⚙️ Ещё | Персонаж Betsy (тонкая настройка), напоминания, каналы и `/link`, `/notify` preference, подключённые сервисы, использование, безопасность (экспорт, удалить аккаунт), помощь |

### 5.3 Авторизация
- **Внутри Telegram MiniApp**: `Telegram.WebApp.initData` → сервер проверяет HMAC-подпись → JWT session cookie
- **Внутри MAX MiniApp**: аналогично через MAX API (требует уточнения формата initData у MAX)
- **На standalone web**: QR-код (WhatsApp-Web style) → юзер сканит → бот просит подтвердить вход → сайт получает JWT. Fallback — Telegram Login Widget кнопкой.

### 5.4 Платежи в кабинете
- Кнопка «Перейти на Pro» / «+500₽ в кошелёк» → backend создаёт payment через `PaymentProvider` → редирект на checkout URL
- Webhook возвращает результат → кабинет показывает статус
- Внутри Telegram WebApp — открывается через `Telegram.WebApp.openLink()` (внешний браузер)

## 6. База данных

### 6.1 Postgres схема (новая, без legacy от BetsyCrew Inbox Assistant)

```sql
-- Расширения
create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

-- Tenants
create table workspaces (
  id              uuid primary key default gen_random_uuid(),
  owner_tg_id     bigint unique,
  owner_max_id    bigint unique,
  display_name    text,
  business_context text,
  address_form    text default 'ty',  -- 'ty' | 'vy'
  persona_id      text default 'betsy',
  plan            text default 'trial',  -- 'trial' | 'personal' | 'pro' | 'canceled' | 'past_due'
  status          text default 'onboarding',  -- 'onboarding' | 'active' | 'canceled' | 'past_due' | 'deleted'
  tokens_used_period bigint default 0,
  tokens_limit_period bigint default 100000,
  period_reset_at timestamptz,
  balance_kopecks bigint default 0,
  last_active_channel text,
  notify_channel_pref text default 'auto',
  tz              text default 'Europe/Moscow',
  created_at      timestamptz default now()
);

-- Персонажи (копия пресета + кастомизация)
create table bc_personas (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  preset_id       text,
  name            text not null,
  gender          text,
  voice_id        text default 'Aoede',
  personality_prompt text,
  biography       text,
  avatar_s3_key   text,
  reference_front_s3_key text,
  reference_three_q_s3_key text,
  reference_profile_s3_key text,
  behavior_config jsonb default '{}',  -- {voice:"auto", selfie:"on_request", video:"on_request"}
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
create index bc_personas_ws_idx on bc_personas(workspace_id);

-- Память: факты
create table bc_memory_facts (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  kind            text not null,  -- 'preference' | 'fact' | 'task' | 'relationship' | 'event'
  content         text not null,
  meta            jsonb default '{}',
  embedding       vector(768),  -- для semantic search через pgvector
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
create index bc_memory_facts_ws_kind_idx on bc_memory_facts(workspace_id, kind);
create index bc_memory_facts_ws_created_idx on bc_memory_facts(workspace_id, created_at desc);

-- История диалога (оптимизировано для implicit caching)
create table bc_conversation (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  channel         text not null,  -- 'telegram' | 'max' | 'cabinet'
  role            text not null,  -- 'user' | 'assistant' | 'tool'
  content         text not null,
  tool_calls      jsonb,
  tokens_used     int default 0,
  meta            jsonb default '{}',
  created_at      timestamptz default now()
);
create index bc_conversation_ws_idx on bc_conversation(workspace_id, created_at desc);

-- Напоминания
create table bc_reminders (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  fire_at         timestamptz not null,
  text            text not null,
  preferred_channel text not null,  -- канал создания = Правило 0
  status          text default 'pending',  -- 'pending' | 'fired' | 'cancelled' | 'failed'
  created_at      timestamptz default now(),
  decided_at      timestamptz
);
create index bc_reminders_pending_idx on bc_reminders(fire_at) where status='pending';
create index bc_reminders_ws_idx on bc_reminders(workspace_id);

-- Кошелёк: транзакции
create table bc_wallet_transactions (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  delta_kopecks   bigint not null,  -- +topup, -spend
  reason          text not null,  -- 'topup' | 'selfie' | 'video_circle' | 'refund'
  meta            jsonb default '{}',
  created_at      timestamptz default now()
);
create index bc_wallet_tx_ws_idx on bc_wallet_transactions(workspace_id, created_at desc);

-- Биллинг-события (подписка + топапы)
create table bc_billing_events (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  kind            text not null,  -- 'subscribe' | 'renew' | 'topup' | 'fail' | 'cancel' | 'refund'
  amount_kopecks  bigint,
  provider_payment_id text,
  meta            jsonb default '{}',
  created_at      timestamptz default now()
);
create unique index bc_billing_events_payment_uniq on bc_billing_events(provider_payment_id) where provider_payment_id is not null;

-- Сохранённые методы оплаты
create table bc_payment_methods (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  provider        text not null,  -- 'tochka' | 'mock'
  provider_method_id text not null,
  card_mask       text,
  card_type       text,
  expiry          text,
  is_active       boolean default true,
  created_at      timestamptz default now()
);
create index bc_payment_methods_ws_idx on bc_payment_methods(workspace_id);

-- Авто-пополнение
create table bc_auto_topup (
  workspace_id    uuid primary key references workspaces(id) on delete cascade,
  enabled         boolean default false,
  threshold_kopecks bigint default 10000,  -- 100₽
  amount_kopecks  bigint default 50000,  -- 500₽
  payment_method_id uuid references bc_payment_methods(id),
  monthly_cap_kopecks bigint default 500000,  -- 5000₽ safety
  month_used_kopecks bigint default 0,
  month_reset_at  timestamptz
);

-- Связывание каналов
create table bc_link_codes (
  code            text primary key,
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  expires_at      timestamptz not null,
  created_at      timestamptz default now()
);
create index bc_link_codes_expires_idx on bc_link_codes(expires_at);

-- Подключённые сервисы (MCP)
create table bc_workspace_services (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  service_id      text not null,  -- 'gmail' | 'google_calendar' | 'notion' | ...
  account_label   text,
  oauth_token_encrypted text,  -- AES-256-GCM
  oauth_refresh_token_encrypted text,
  expires_at      timestamptz,
  scopes          text[],
  meta            jsonb default '{}',
  created_at      timestamptz default now()
);
create index bc_workspace_services_ws_idx on bc_workspace_services(workspace_id);

-- Row-Level Security
alter table workspaces enable row level security;
alter table bc_personas enable row level security;
alter table bc_memory_facts enable row level security;
alter table bc_conversation enable row level security;
alter table bc_reminders enable row level security;
alter table bc_wallet_transactions enable row level security;
alter table bc_billing_events enable row level security;
alter table bc_payment_methods enable row level security;
alter table bc_auto_topup enable row level security;
alter table bc_workspace_services enable row level security;

-- Policies (все данные scoped по app.workspace_id)
create policy ws_isolation on bc_personas
  using (workspace_id = current_setting('app.workspace_id')::uuid);
-- ... аналогично для всех таблиц с workspace_id
```

### 6.2 RLS контракт

Каждый запрос к БД **обязан** установить переменную перед выполнением:
```ts
await client.query(`SET LOCAL app.workspace_id = $1`, [workspaceId])
```

Обёртка `withWorkspace(wsId, async (tx) => {...})` в `src/multi/db/rls.ts` гарантирует это. Функции репозиториев принимают `tx` и не могут обойти RLS.

## 7. Структура кода

```
src/
├─ core/                        # Single-mode Betsy, не меняем
│  ├─ engine.ts
│  ├─ tools/
│  ├─ llm/
│  ├─ memory/
│  ├─ skills/
│  ├─ personality.ts
│  └─ ...
├─ channels/                    # Single-mode каналы (telegram, browser)
├─ server.ts                    # Single-mode HTTP сервер
├─ index.ts                     # Entry: выбор single vs multi по BETSY_MODE
├─ mode.ts                      # pickEntry() функция
│
├─ multi/                       # NEW: Personal Betsy v2
│  ├─ server.ts                 # Multi-mode entry
│  ├─ env.ts                    # zod env validation + fail-fast
│  ├─ observability/
│  │  └─ logger.ts              # pino с маскировкой секретов
│  │
│  ├─ db/
│  │  ├─ pool.ts                # pg connection pool
│  │  ├─ rls.ts                 # withWorkspace helper
│  │  ├─ migrate.ts             # drizzle-kit runner
│  │  └─ migrations/
│  │     ├─ 001_init.sql
│  │     ├─ 002_rls.sql
│  │     └─ ...
│  │
│  ├─ workspaces/
│  │  ├─ types.ts
│  │  └─ repo.ts
│  │
│  ├─ personas/
│  │  ├─ types.ts
│  │  ├─ repo.ts
│  │  ├─ library/               # YAML пресеты + pre-shipped аватары
│  │  │  ├─ betsy.yaml
│  │  │  ├─ alex.yaml
│  │  │  └─ ...
│  │  └─ service.ts             # customize, change, reset-memory
│  │
│  ├─ memory/
│  │  ├─ facts-repo.ts          # bc_memory_facts CRUD
│  │  ├─ conversation-repo.ts
│  │  ├─ embeddings.ts          # pgvector semantic search
│  │  └─ service.ts
│  │
│  ├─ reminders/
│  │  ├─ repo.ts
│  │  ├─ service.ts
│  │  └─ worker.ts              # pg-boss scheduler
│  │
│  ├─ wallet/
│  │  ├─ repo.ts
│  │  ├─ ledger.ts              # atomic reserve/commit/refund
│  │  └─ service.ts
│  │
│  ├─ billing/
│  │  ├─ types.ts               # PaymentProvider interface
│  │  ├─ providers/
│  │  │  ├─ mock.ts
│  │  │  └─ tochka.ts           # TODO когда получим креды
│  │  ├─ repo.ts                # bc_billing_events
│  │  ├─ subscription-service.ts
│  │  └─ auto-topup-service.ts
│  │
│  ├─ http/
│  │  ├─ server.ts              # Fastify / raw node:http
│  │  ├─ webhook-billing.ts
│  │  ├─ cabinet-api.ts         # REST для личного кабинета
│  │  └─ miniapp-auth.ts        # TG initData, MAX initData, QR flow
│  │
│  ├─ channels/
│  │  ├─ base.ts                # ChannelAdapter interface
│  │  ├─ telegram.ts            # grammy
│  │  └─ max.ts                 # custom HTTP client с Authorization header
│  │
│  ├─ linking/
│  │  ├─ repo.ts                # bc_link_codes
│  │  └─ service.ts             # 6-digit codes, TTL, merge workspaces
│  │
│  ├─ notify/
│  │  └─ preferences.ts         # 5 правил каскада выбора канала
│  │
│  ├─ storage/
│  │  └─ s3.ts                  # Beget S3, presigned URLs
│  │
│  ├─ gemini/
│  │  ├─ client.ts              # @google/genai wrapper
│  │  ├─ selfie.ts              # Nano Banana 2 generate_selfie
│  │  ├─ tts.ts                 # gemini-2.5-flash-preview-tts + PCM→Opus
│  │  └─ live.ts                # v1.1 — Live API для "Позвонить Betsy"
│  │
│  ├─ agents/
│  │  ├─ betsy-factory.ts       # создаёт LlmAgent per workspace
│  │  ├─ tools/
│  │  │  ├─ memory-tools.ts     # remember, recall, forget
│  │  │  ├─ reminder-tools.ts   # set_reminder, list, cancel
│  │  │  ├─ selfie-tool.ts
│  │  │  ├─ video-circle-tool.ts # fal.ai обёртка
│  │  │  ├─ connect-service.ts  # MCP auto-install
│  │  │  └─ ...
│  │  └─ prompt-builder.ts      # system prompt из persona + context
│  │
│  └─ bot-router/
│     ├─ router.ts              # Главный dispatcher
│     ├─ onboarding-flow.ts     # 3-шаговый FSM
│     ├─ commands.ts            # /start /help /status /plan /notify /link /forget /cancel
│     └─ persona-selector.ts    # галерея пресетов
│
└─ ui/
   ├─ pages/                    # Single-mode страницы остаются
   └─ cabinet/                  # NEW
      ├─ App.tsx                # Bottom tabs shell
      ├─ auth/
      │  ├─ telegram-initdata.ts
      │  ├─ max-initdata.ts
      │  └─ qr-login.tsx
      ├─ tabs/
      │  ├─ home.tsx
      │  ├─ memory.tsx
      │  ├─ tariff.tsx
      │  └─ more.tsx
      ├─ persona/
      │  ├─ gallery.tsx         # выбор пресета
      │  ├─ customize.tsx       # wizard
      │  └─ behavior.tsx        # стиль ответов
      ├─ billing/
      │  ├─ plan-picker.tsx
      │  ├─ saved-card.tsx
      │  ├─ wallet.tsx
      │  └─ auto-topup.tsx
      └─ services/
         ├─ catalog.tsx
         └─ connected.tsx

docs/
├─ superpowers/
│  ├─ specs/
│  │  └─ 2026-04-07-personal-betsy-design.md  # этот файл
│  └─ plans/
│     └─ 2026-04-07-personal-betsy-mvp.md     # будет следующим шагом
└─ deploy/
   └─ personal-betsy-vps.md
```

## 8. Интеграция Google ADK

### 8.1 Создание агента Betsy per workspace

```ts
// src/multi/agents/betsy-factory.ts
import { LlmAgent } from "@google/adk"
import { GOOGLE_SEARCH } from "@google/adk/dist/esm/tools/google_search_tool.js"
import type { Workspace, Persona } from "../workspaces/types.js"
import { buildSystemPrompt } from "./prompt-builder.js"
import { memoryTools } from "./tools/memory-tools.js"
import { reminderTools } from "./tools/reminder-tools.js"
import { selfieTool } from "./tools/selfie-tool.js"
import { videoCircleTool } from "./tools/video-circle-tool.js"
import { connectServiceTool } from "./tools/connect-service.js"

export function createBetsyAgent(workspace: Workspace, persona: Persona): LlmAgent {
  const model = workspace.plan === "pro" ? "gemini-2.5-pro" : "gemini-2.5-flash"
  
  return new LlmAgent({
    name: `betsy_${workspace.id}`,
    model,
    instruction: buildSystemPrompt(persona, workspace),
    tools: [
      GOOGLE_SEARCH,              // нативный Google Search
      ...memoryTools,             // remember, recall, forget
      ...reminderTools,           // set_reminder, list, cancel
      selfieTool,                 // Nano Banana 2 через PAYG
      videoCircleTool,            // fal.ai через PAYG
      connectServiceTool,         // MCP auto-install
      // + динамически зарегистрированные MCP-серверы workspace
    ],
    // Per-request context передаётся через session
  })
}
```

### 8.2 Session management

ADK имеет sessions первого класса. Для multi-tenant:
- **Один процесс — много sessions**
- **Session ID = workspace.id** (у каждого workspace своя сессия)
- State sessions хранится в Postgres через кастомный `SessionService`
- При входящем сообщении: `session = sessionService.get(workspaceId)` → `agent.run(session, userMessage)` → ответ

### 8.3 Prompt caching

Implicit caching Gemini работает автоматом для Gemini 2.5+. Условия:
- Префикс запроса ≥1024 токена (Flash) или ≥4096 (Pro)
- System prompt + tools definitions + персона — всё это легко набирает 5-10K токенов, кеширование гарантированно
- Cache hits → 90% скидка на input tokens

Для максимальной эффективности:
- System prompt строится **одинаково** для всех запросов одного workspace (детерминированно)
- Динамический контент (имя юзера, только что полученное сообщение) идёт в **конец** запроса, не в начало

### 8.4 Tool execution context

Каждый вызов tool получает контекст:
```ts
interface ToolContext {
  workspaceId: string
  userId: string  // tg_id или max_id
  channel: 'telegram' | 'max' | 'cabinet'
  sessionId: string
}
```

Tools используют контекст для:
- RLS-scoped запросов к БД (`withWorkspace(ctx.workspaceId, ...)`)
- Списания с PAYG-кошелька
- Логирования с workspace_id
- Проверки прав и лимитов

## 9. Безопасность

### 9.1 Multi-tenant изоляция
- **Postgres RLS** на всех таблицах с `workspace_id`
- **Приложение обязано** устанавливать `app.workspace_id` перед любым запросом
- **RLS обёртка** `withWorkspace(wsId, fn)` в `src/multi/db/rls.ts` — единственный способ работы с данными
- **Тесты**: для каждого репозитория — тест «запрос без SET LOCAL возвращает пустой результат»

### 9.2 Secrets
- Env vars через `zod` валидацию, fail-fast при старте
- `GEMINI_API_KEY`, `FAL_API_KEY`, `TOCHKA_*`, `BC_S3_*`, `BC_DATABASE_URL` — в `.env.multi`, chmod 600
- **Никаких секретов в коде**, в git, в логах
- Logger автоматически маскирует ключи содержащие `token`, `secret`, `password`, `key`
- OAuth токены в `bc_workspace_services.oauth_token_encrypted` — AES-256-GCM, ключ в env

### 9.3 Webhook защита (Точка)
- IP allowlist (когда получим от Точки)
- HMAC/Basic auth (по доке Точки)
- Body size cap 64KB
- Timeout 5s
- Idempotency через `bc_billing_events.provider_payment_id UNIQUE`
- Generic error responses (не выдаём детали ошибок наружу)

### 9.4 Rate limiting
- Per-workspace token bucket: 1 запрос/сек, burst 5
- Per-source-chat: 10/минуту (защита от flood от одного собеседника)
- Runaway protection для медиа: ≤5 платных генераций/час даже в режиме «на усмотрение Betsy»
- Auto top-up monthly cap 5000₽

### 9.5 Prompt injection защита
- OAuth подтверждение сервисов **только через кабинет**, не через чат
- Tool `connect_service` не может быть вызван от имени модели если юзер не в кабинете
- Tools с денежным расходом (selfie, video_circle) — только если `behavior_config` разрешает
- Tools с удалением данных (`forget_all`) — требуют подтверждения через inline кнопку

### 9.6 Бэкапы
- `pg_dump` ежедневно в 04:00 UTC, шифрование GPG, загрузка в Beget S3 в `backups/` префикс
- WAL archiving каждые 5 минут
- Retention: 30 дней ежедневных, 12 месяцев ежемесячных
- Тестовый restore ежемесячно

## 10. Deployment

### 10.1 VPS setup
- Существующий VPS `193.42.124.214`, Ubuntu 24.04
- Node.js 24.13+ устанавливается через NodeSource
- Postgres 16 в Docker на `127.0.0.1:5433`
- nginx + Let's Encrypt (сертификат `crew.betsyai.io` сохранён)
- Single-mode `betsy.service` остаётся на порту 3777
- **Новый**: `betsy-multi.service` на порту 8080 (HTTP API, webhooks)
- **Новый**: `betsy-healthz.service` на порту 8081 (healthz + metrics)

### 10.2 nginx конфигурация
```nginx
server {
  server_name crew.betsyai.io cabinet.betsyai.io;
  listen 443 ssl http2;
  
  # Cabinet SPA
  location / {
    root /opt/betsy-multi/dist-ui/cabinet;
    try_files $uri /index.html;
  }
  
  # API
  location /api/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
  }
  
  # Webhooks
  location /webhook/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    client_max_body_size 64k;
  }
  
  # Healthz
  location = /healthz {
    proxy_pass http://127.0.0.1:8081/healthz;
    access_log off;
  }
  
  ssl_certificate     /etc/letsencrypt/live/crew.betsyai.io/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/crew.betsyai.io/privkey.pem;
}
```

### 10.3 systemd unit
```ini
[Unit]
Description=Personal Betsy multi-tenant SaaS
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/betsy-multi
EnvironmentFile=/opt/betsy-multi/.env.multi
ExecStart=/usr/bin/node dist/multi/server.js
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/betsy-multi.log
StandardError=append:/var/log/betsy-multi.log
User=root
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

### 10.4 Graceful shutdown
- SIGTERM handler: остановка ботов, закрытие pg-boss, слив in-flight tool-calls, закрытие pool, close HTTP servers
- Hard timeout 30s

### 10.5 Environment variables
```bash
# Mode
BETSY_MODE=multi

# Database
BC_DATABASE_URL=postgres://postgres:xxx@127.0.0.1:5433/betsy
BC_ENCRYPTION_KEY=xxx  # 32-byte base64 для AES-256-GCM OAuth токенов

# Google Gemini
GEMINI_API_KEY=xxx  # покрывает text, search, image, tts

# Channels
BC_TELEGRAM_BOT_TOKEN=xxx
BC_MAX_BOT_TOKEN=xxx

# Beget S3
BC_S3_ENDPOINT=https://s3.ru1.storage.beget.cloud
BC_S3_BUCKET=64d9bd04fc15-betsy-ai
BC_S3_ACCESS_KEY=xxx
BC_S3_SECRET_KEY=xxx

# Payments (mock на старте)
BC_PAYMENT_PROVIDER=mock  # или 'tochka'
BC_TOCHKA_CUSTOMER_CODE=
BC_TOCHKA_JWT=
BC_TOCHKA_WEBHOOK_USER=
BC_TOCHKA_WEBHOOK_PASS=
BC_TRUST_PROXY=1

# fal.ai (только для видео-кружочков)
FAL_API_KEY=xxx

# HTTP
BC_HTTP_PORT=8080
BC_HEALTHZ_PORT=8081
BC_WEBHOOK_BASE_URL=https://crew.betsyai.io

# Ops
BC_LOG_LEVEL=info
```

## 11. Тестирование

### 11.1 Unit tests (vitest)
- **Изолированная логика**: wallet ledger, preferred_channel rules, onboarding FSM, link code generation, prompt builder, cache strategy selector
- **Моки**: Gemini API, Точка, S3, Telegram API

### 11.2 Integration tests (vitest + testcontainers)
- **Против реального Postgres**: все репозитории + RLS обёртка
- **Против мок-S3** (localstack или in-memory): upload/download/presigned URLs
- **Full flow**: создать workspace → добавить факт → вызвать tool через агента → проверить что tool получил правильный контекст

### 11.3 E2E smoke (ручной чеклист)
- `/start` в Telegram → онбординг → выбор персонажа → тариф → оплата (mock) → первое сообщение Betsy
- Связывание через `/link` между TG и MAX, проверка общей памяти
- Напоминание: поставить через бота → дождаться → проверить что пришло в правильный канал
- Селфи: команда «сделай селфи в кафе» → проверить что PAYG списался и картинка пришла
- Голосовой ответ: прислать Betsy voice message → проверить что ответила голосом через TTS
- Web search: «что сегодня в новостях?» → проверить что ищет через Google Search grounding
- Кабинет: авторизация через QR, просмотр тарифа, изменение персонажа, топап кошелька
- Отписка: кнопка → подтверждение → проверка что доступ остался до конца периода

## 12. Миграция с откаченного BetsyCrew

Откачен `git reset --hard 237c3cf` + снос VPS артефактов. Этот документ — чистая новая спека, без наследия BetsyCrew Inbox Assistant.

Сохранённые от BetsyCrew ресурсы:
- TLS-сертификат `crew.betsyai.io` в `/etc/letsencrypt/live/` на VPS (переиспользуем)
- Опыт работы с multi-tenant Postgres (применяем архитектурные уроки)
- Опыт security hardening (IP allowlist, RLS, rate limiting) — переиспользуем паттерны

## 13. Версионирование и roadmap

### v1.0 (эта спека, реализация сейчас)
- Всё описанное в §1-11
- Целевой срок: 8-12 «вечеров агентов» через волны параллельного исполнения

### v1.1 (следующий цикл после v1.0 запуска)
- **Live API «Позвонить Betsy»** — bidirectional voice через `gemini-3.1-flash-live-preview` + WebRTC
- **Voice clone** — если Google добавит custom voice
- **Telegram Payments** через MiniApp (нативный инвойс)
- **Marketplace скиллов** (third-party submissions с модерацией)
- **BYOK через OpenRouter** для продвинутых юзеров
- **Team workspace** — несколько юзеров в одном workspace

### v1.2
- **Видео-кружочки через Veo** (если догонит качество fal.ai)
- **Мобильное приложение** (React Native / Expo поверх того же API)
- **Дополнительные каналы** (WhatsApp, VK) если будет спрос

## 14. Open questions

Эти вопросы не блокируют v1.0, решаются по ходу имплементации:

1. **Точка Банк API** — точные URL, формат webhook, rate limits. Решаем когда получим креды.
2. **MAX MiniApp initData формат** — надо проверить документацию MAX на формат `web_app_init_data`.
3. **Precise pricing web search** — если 1500 бесплатных/день недостаточно, включаем в PAYG или Pro-only.
4. **pgvector embeddings модель** — Gemini Embedding vs open-source (bge-small)? Решаем когда дойдём до semantic memory search.
5. **Cabinet domain** — `cabinet.betsyai.io` отдельно или `crew.betsyai.io/cabinet`? Склоняюсь к отдельному поддомену для чистоты.

## 15. Acceptance criteria v1.0

Personal Betsy v2 считается готовой к запуску когда:

1. ✅ Юзер может написать `/start` в Telegram, пройти онбординг из 3 шагов, выбрать пресет Betsy, получить приветственное сообщение в её вайбе
2. ✅ Юзер может связать MAX-канал через `/link` и получить общую память
3. ✅ Юзер может оплатить Personal тариф через mock-провайдер (позже — Точка)
4. ✅ Betsy умеет использовать tools: memory, reminders, web search, selfie (Nano Banana 2), voice (Gemini TTS), video-circles (fal.ai)
5. ✅ Селфи списываются с PAYG-кошелька, голос и web search — из подписки
6. ✅ Напоминание приходит в правильный канал согласно Rule 0-5
7. ✅ Режим «на усмотрение Betsy» работает: она сама решает озвучить/прислать селфи
8. ✅ Кабинет открывается как standalone web, Telegram MiniApp, MAX MiniApp; все страницы работают
9. ✅ Авторизация через Telegram QR + initData
10. ✅ Отписка работает: подтверждение → сохранение доступа до конца периода → статус canceled
11. ✅ Все тесты (unit + integration) зелёные
12. ✅ Задеплоено на VPS под systemd, TLS работает, healthz возвращает 200
13. ✅ Postgres RLS защита работает: запрос без `SET LOCAL app.workspace_id` возвращает пусто
14. ✅ Бэкапы настроены и проверены тестовым restore
15. ✅ Single-mode `betsy.service` продолжает работать параллельно на `:3777`
