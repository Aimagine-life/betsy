-- 008_mcp_servers.sql — per-workspace MCP server registry.
--
-- Stores Model Context Protocol server configurations attached to a workspace.
-- Secrets (env values, OAuth tokens) are stored as-is — never log them.

create table if not exists bc_workspace_mcp_servers (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  transport     text not null check (transport in ('stdio', 'sse', 'http')),
  command       text,
  args          jsonb not null default '[]'::jsonb,
  env           jsonb not null default '{}'::jsonb,
  url           text,
  enabled       boolean not null default true,
  config        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, name)
);

create index if not exists bc_workspace_mcp_servers_ws_idx
  on bc_workspace_mcp_servers(workspace_id);

alter table bc_workspace_mcp_servers enable row level security;
alter table bc_workspace_mcp_servers force row level security;

drop policy if exists ws_scoped on bc_workspace_mcp_servers;
create policy ws_scoped on bc_workspace_mcp_servers
  using (workspace_id = current_setting('app.workspace_id', true)::uuid);

grant select, insert, update, delete on bc_workspace_mcp_servers to bc_app;
