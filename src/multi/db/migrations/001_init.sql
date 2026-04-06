-- 001_init.sql — foundation schema for Personal Betsy v2

create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

-- Tenants
create table if not exists workspaces (
  id                   uuid primary key default gen_random_uuid(),
  owner_tg_id          bigint unique,
  owner_max_id         bigint unique,
  display_name         text,
  business_context     text,
  address_form         text not null default 'ty',
  persona_id           text not null default 'betsy',
  plan                 text not null default 'trial',
  status               text not null default 'onboarding',
  tokens_used_period   bigint not null default 0,
  tokens_limit_period  bigint not null default 100000,
  period_reset_at      timestamptz,
  balance_kopecks      bigint not null default 0,
  last_active_channel  text,
  notify_channel_pref  text not null default 'auto',
  tz                   text not null default 'Europe/Moscow',
  created_at           timestamptz not null default now()
);

create index if not exists workspaces_status_idx on workspaces(status);

-- Personas (user-customized instances of presets)
create table if not exists bc_personas (
  id                          uuid primary key default gen_random_uuid(),
  workspace_id                uuid not null references workspaces(id) on delete cascade,
  preset_id                   text,
  name                        text not null,
  gender                      text,
  voice_id                    text not null default 'Aoede',
  personality_prompt          text,
  biography                   text,
  avatar_s3_key               text,
  reference_front_s3_key      text,
  reference_three_q_s3_key    text,
  reference_profile_s3_key    text,
  behavior_config             jsonb not null default '{}',
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists bc_personas_ws_idx on bc_personas(workspace_id);

-- Memory: long-term facts
create table if not exists bc_memory_facts (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  kind          text not null,
  content       text not null,
  meta          jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists bc_memory_facts_ws_kind_idx on bc_memory_facts(workspace_id, kind);
create index if not exists bc_memory_facts_ws_created_idx on bc_memory_facts(workspace_id, created_at desc);

-- Conversation history
create table if not exists bc_conversation (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  channel       text not null,
  role          text not null,
  content       text not null,
  tool_calls    jsonb,
  tokens_used   int not null default 0,
  meta          jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

create index if not exists bc_conversation_ws_idx on bc_conversation(workspace_id, created_at desc);

-- Schema migrations tracker
create table if not exists schema_migrations (
  id          serial primary key,
  name        text unique not null,
  applied_at  timestamptz not null default now()
);

-- Row-Level Security
alter table workspaces enable row level security;
alter table bc_personas enable row level security;
alter table bc_memory_facts enable row level security;
alter table bc_conversation enable row level security;

-- RLS Policies: every query must set app.workspace_id
-- For workspaces table, we check id directly
drop policy if exists ws_self on workspaces;
create policy ws_self on workspaces
  using (id = current_setting('app.workspace_id', true)::uuid);

drop policy if exists ws_scoped on bc_personas;
create policy ws_scoped on bc_personas
  using (workspace_id = current_setting('app.workspace_id', true)::uuid);

drop policy if exists ws_scoped on bc_memory_facts;
create policy ws_scoped on bc_memory_facts
  using (workspace_id = current_setting('app.workspace_id', true)::uuid);

drop policy if exists ws_scoped on bc_conversation;
create policy ws_scoped on bc_conversation
  using (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- Admin bypass role for service operations (e.g., creating new workspaces)
-- The application will use SESSION_USER or a specific role to bypass RLS when needed
-- For now, we add BYPASSRLS to the owner role; actual role setup is in deploy
