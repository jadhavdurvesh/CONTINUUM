-- Cloud-backed locks for paths in each collaborator's local checkout.
create table public.repository_path_locks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  path text not null check (
    length(trim(path)) between 1 and 240
    and left(path,1) <> '/'
    and path not like '%//%'
    and path !~ '(^|/)(\\.|\\.\\.)(/|$)'
    and path !~ '^[A-Za-z]:'
  ),
  reason text not null default 'Protected by project owner',
  locked_by uuid not null references auth.users(id),
  is_locked boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id,path)
);

create index repository_path_locks_active_idx
  on public.repository_path_locks(project_id,path) where is_locked;

alter table public.repository_path_locks enable row level security;
grant select,insert,update,delete on public.repository_path_locks to authenticated;

create policy "Members read repository path locks"
  on public.repository_path_locks for select to authenticated
  using (private.is_project_member(project_id));
create policy "Owners create repository path locks"
  on public.repository_path_locks for insert to authenticated
  with check (private.is_project_owner(project_id) and locked_by=(select auth.uid()));
create policy "Owners update repository path locks"
  on public.repository_path_locks for update to authenticated
  using (private.is_project_owner(project_id))
  with check (private.is_project_owner(project_id));
create policy "Owners delete repository path locks"
  on public.repository_path_locks for delete to authenticated
  using (private.is_project_owner(project_id));

create or replace function private.audit_repository_path_lock()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  item public.repository_path_locks%rowtype;
  operation_name text;
begin
  if tg_op='DELETE' then item:=old; else item:=new; end if;
  operation_name := case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end;
  if tg_op='UPDATE' and old.is_locked is not distinct from new.is_locked
      and old.reason is not distinct from new.reason
      and old.path is not distinct from new.path then
    return new;
  end if;
  insert into public.activity_events(project_id,actor_id,actor_type,action,entity_type,entity_id,details)
  values (
    item.project_id,(select auth.uid()),'human','repository_path_lock.'||operation_name,
    'repository_path_lock',item.id,
    jsonb_build_object('title',item.path,'path',item.path,'is_locked',item.is_locked,'reason',item.reason)
  );
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger audit_repository_path_locks
after insert or update or delete on public.repository_path_locks
for each row execute procedure private.audit_repository_path_lock();

create trigger touch_repository_path_locks before update on public.repository_path_locks
for each row execute procedure private.touch_updated_at();

do $$
begin
  alter publication supabase_realtime add table public.repository_path_locks;
exception when duplicate_object then null;
end;
$$;
