-- CONTINUUM targeted repair for project creation RLS.
-- Run in Supabase SQL Editor after the core CONTINUUM tables exist.
-- This does NOT disable RLS or allow users to create projects for other users.

begin;

do $$
begin
  if to_regclass('public.projects') is null then
    raise exception 'public.projects does not exist. Run supabase/setup_all.sql first.';
  end if;
  if to_regclass('public.project_members') is null then
    raise exception 'public.project_members does not exist. Run supabase/setup_all.sql first.';
  end if;
end;
$$;

create schema if not exists private;

grant usage on schema private to authenticated;

create or replace function private.is_project_member(target_project uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.project_members pm
    where pm.project_id = target_project
      and pm.user_id = (select auth.uid())
  );
$$;

create or replace function private.is_project_owner(target_project uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.project_members pm
    where pm.project_id = target_project
      and pm.user_id = (select auth.uid())
      and pm.role = 'owner'
  );
$$;

revoke all on function private.is_project_member(uuid) from public, anon;
revoke all on function private.is_project_owner(uuid) from public, anon;
grant execute on function private.is_project_member(uuid) to authenticated;
grant execute on function private.is_project_owner(uuid) to authenticated;

-- Re-establish owner membership automatically when a project is created.
create or replace function private.add_project_owner_membership()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.project_members(project_id, user_id, role, invited_by)
  values (new.id, new.owner_id, 'owner', new.owner_id)
  on conflict (project_id, user_id) do nothing;
  return new;
end;
$$;

-- Supabase SQL Editor normally runs as postgres. Explicit function ownership
-- ensures this SECURITY DEFINER trigger can establish the initial membership.
alter function private.add_project_owner_membership() owner to postgres;

drop trigger if exists on_project_created on public.projects;
create trigger on_project_created
after insert on public.projects
for each row execute procedure private.add_project_owner_membership();

alter table public.projects enable row level security;

-- Remove conflicting/obsolete project policies, then restore the intended
-- least-privilege rules. INSERTs are allowed only when owner_id is auth.uid().
do $$
declare
  existing_policy record;
begin
  for existing_policy in
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'projects'
  loop
    execute format('drop policy %I on public.projects', existing_policy.policyname);
  end loop;
end;
$$;

create policy "Members read projects"
on public.projects for select to authenticated
using (private.is_project_member(id));

create policy "Create owned projects"
on public.projects for insert to authenticated
with check (owner_id = (select auth.uid()));

create policy "Owners update projects"
on public.projects for update to authenticated
using (private.is_project_owner(id))
with check (private.is_project_owner(id));

grant select, insert, update on public.projects to authenticated;
grant select, insert, update, delete on public.project_members to authenticated;

notify pgrst, 'reload schema';

commit;
