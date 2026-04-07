-- 008_workspace_skills.sql — per-workspace executable skills (Wave 1C).

create table if not exists bc_workspace_skills (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references workspaces(id) on delete cascade,
  name                 text not null,
  description          text,
  yaml                 text not null,
  trigger_type         text not null check (trigger_type in ('manual','cron','keyword','event')),
  trigger_config       jsonb not null default '{}'::jsonb,
  enabled              boolean not null default true,
  created_by           text,
  last_run_at          timestamptz,
  last_run_status      text,
  last_run_error       text,
  run_count            int not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (workspace_id, name)
);

create index if not exists bc_workspace_skills_ws_idx
  on bc_workspace_skills(workspace_id);
create index if not exists bc_workspace_skills_enabled_cron_idx
  on bc_workspace_skills(enabled, trigger_type)
  where enabled = true and trigger_type = 'cron';

alter table bc_workspace_skills enable row level security;
alter table bc_workspace_skills force row level security;

drop policy if exists ws_scoped on bc_workspace_skills;
create policy ws_scoped on bc_workspace_skills
  using (workspace_id = current_setting('app.workspace_id', true)::uuid);

grant select, insert, update, delete on bc_workspace_skills to bc_app;
