-- 002_force_rls.sql — enforce Row-Level Security even for table owners
--
-- Postgres by default bypasses RLS for table owner / superuser unless
-- FORCE ROW LEVEL SECURITY is set. Without this, application connections
-- running as the owner role see all rows across workspaces — breaking
-- multi-tenant isolation.

alter table workspaces          force row level security;
alter table bc_personas         force row level security;
alter table bc_memory_facts     force row level security;
alter table bc_conversation     force row level security;
