-- CONTINUUM project-creation RLS repair
-- Use only after the main CONTINUUM schema has been applied.
-- Safe to re-run: the specific insert policy is replaced deterministically.

begin;

alter table public.projects enable row level security;
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.projects to authenticated;

drop policy if exists "Create owned projects" on public.projects;
create policy "Create owned projects"
  on public.projects
  for insert
  to authenticated
  with check (
    (select auth.uid()) is not null
    and owner_id = (select auth.uid())
  );

-- Ensure the REST API sees the current schema and policies.
notify pgrst, 'reload schema';

commit;
