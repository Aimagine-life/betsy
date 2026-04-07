-- 004_reminders.sql — reminder storage for Personal Betsy agent tools.

create table if not exists bc_reminders (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references workspaces(id) on delete cascade,
  fire_at              timestamptz not null,
  text                 text not null,
  preferred_channel    text not null,
  status               text not null default 'pending',
  created_at           timestamptz not null default now(),
  decided_at           timestamptz
);

create index if not exists bc_reminders_pending_idx on bc_reminders(fire_at) where status = 'pending';
create index if not exists bc_reminders_ws_idx on bc_reminders(workspace_id, created_at desc);

alter table bc_reminders enable row level security;
alter table bc_reminders force row level security;

drop policy if exists ws_scoped on bc_reminders;
create policy ws_scoped on bc_reminders
  using (workspace_id = current_setting('app.workspace_id', true)::uuid);

grant select, insert, update, delete on bc_reminders to bc_app;
