create table if not exists bc_link_codes (
  code            text primary key,
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now()
);

create index if not exists bc_link_codes_expires_idx on bc_link_codes(expires_at);
create index if not exists bc_link_codes_ws_idx on bc_link_codes(workspace_id);

alter table bc_link_codes enable row level security;
alter table bc_link_codes force row level security;

-- Link codes bypass per-workspace RLS because the target user doesn't know their
-- workspace_id yet. Reads happen via asAdmin.
-- But we still need a policy so withWorkspace (for cleanup inside a tenant) works:
drop policy if exists ws_scoped on bc_link_codes;
create policy ws_scoped on bc_link_codes
  using (workspace_id = current_setting('app.workspace_id', true)::uuid);

grant select, insert, update, delete on bc_link_codes to bc_app;
