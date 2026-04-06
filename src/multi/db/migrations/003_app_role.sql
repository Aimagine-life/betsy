-- 003_app_role.sql — create a non-superuser application role that is subject to RLS.
--
-- Postgres superusers (and roles with BYPASSRLS) always bypass row security,
-- even when tables have FORCE ROW LEVEL SECURITY. Application connections
-- typically run as the database owner which is often a superuser in local/test
-- setups (e.g., the default `postgres` user). To make RLS effective in those
-- environments, we create a dedicated `bc_app` role without superuser/BYPASSRLS
-- and switch to it per transaction via `SET LOCAL ROLE bc_app` inside
-- `withWorkspace`. `asAdmin` stays on the original role (superuser/owner) so
-- it can bypass RLS for system operations.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'bc_app') then
    create role bc_app nologin noinherit;
  end if;
end$$;

-- bc_app must not bypass RLS
alter role bc_app nobypassrls;

-- Allow bc_app to use the current schema and operate on the tables.
grant usage on schema public to bc_app;
grant select, insert, update, delete on
  workspaces, bc_personas, bc_memory_facts, bc_conversation
  to bc_app;
grant usage, select on all sequences in schema public to bc_app;

-- Allow the current (owner) role to SET ROLE bc_app.
-- current_user here is whoever runs the migration — typically the db owner.
do $$
begin
  execute format('grant bc_app to %I', current_user);
end$$;
