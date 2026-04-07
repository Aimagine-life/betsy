-- 010_skill_candidates.sql — Wave 2A: LearnerAgent candidate skills.
-- Candidates are generated nightly by the Learner and require explicit user
-- approval before they are promoted into bc_workspace_skills.

create table if not exists bc_skill_candidates (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  name            text not null,
  description     text not null,
  yaml            text not null,
  rationale       text,
  source_pattern  jsonb,
  status          text not null default 'pending'
                    check (status in ('pending','approved','rejected','expired')),
  created_at      timestamptz not null default now(),
  decided_at      timestamptz,
  expires_at      timestamptz not null default (now() + interval '14 days'),
  unique (workspace_id, name)
);

create index if not exists bc_skill_candidates_ws_status_idx
  on bc_skill_candidates(workspace_id, status);
create index if not exists bc_skill_candidates_expires_idx
  on bc_skill_candidates(expires_at)
  where status = 'pending';

alter table bc_skill_candidates enable row level security;
alter table bc_skill_candidates force row level security;

drop policy if exists ws_scoped on bc_skill_candidates;
create policy ws_scoped on bc_skill_candidates
  using (workspace_id = current_setting('app.workspace_id', true)::uuid);

grant select, insert, update, delete on bc_skill_candidates to bc_app;
