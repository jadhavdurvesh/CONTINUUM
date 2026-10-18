-- Shared cloud code workbench.
-- Files are workspace records stored in PostgreSQL, not arbitrary paths on a PC.
-- Local repository/worktree and terminal execution belong to the later worker service.

create table public.code_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  path text not null check (
    length(trim(path)) between 1 and 240
    and left(path,1) <> '/'
    and path not like '../%'
    and path not like '%/../%'
    and path not like '%/..'
  ),
  language text not null default 'plaintext',
  content text not null default '' check (octet_length(content) <= 1500000),
  version integer not null default 1 check (version > 0),
  created_by uuid not null default auth.uid() references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id,path)
);

create table public.code_file_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  code_file_id uuid references public.code_files(id) on delete set null,
  path text not null,
  language text not null,
  version integer not null,
  content text not null,
  saved_by uuid references auth.users(id) on delete set null,
  saved_at timestamptz not null default now()
);
create index code_files_project_path_idx on public.code_files(project_id,path);
create index code_file_versions_history_idx on public.code_file_versions(project_id,code_file_id,version desc);

create or replace function private.enforce_code_file_lock()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1 from public.resource_locks rl
      where rl.project_id=old.project_id and rl.resource_type='code_file'
        and rl.resource_id=old.id and rl.is_locked
    ) and not private.is_project_owner(old.project_id)
      and not private.has_resource_grant(old.project_id,'code_file',old.id,'delete') then
      raise exception 'This code file is protected. Request permission or ask the owner to unlock it.'
        using errcode='42501';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if (to_jsonb(old)-array['updated_at','updated_by','version']::text[]) is distinct from
       (to_jsonb(new)-array['updated_at','updated_by','version']::text[]) then
      if exists (
        select 1 from public.resource_locks rl
        where rl.project_id=old.project_id and rl.resource_type='code_file'
          and rl.resource_id=old.id and rl.is_locked
      ) and not private.is_project_owner(old.project_id)
        and not private.has_resource_grant(old.project_id,'code_file',old.id,'edit') then
        raise exception 'This code file is protected. Request permission or ask the owner to unlock it.'
          using errcode='42501';
      end if;
      if new.project_id <> old.project_id or new.id <> old.id then
        raise exception 'A code file cannot be moved to another project or identity.' using errcode='42501';
      end if;
      new.version := old.version + 1;
      new.updated_by := (select auth.uid());
      new.updated_at := now();
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.archive_code_file_version()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.code_file_versions(project_id,code_file_id,path,language,version,content,saved_by)
  values (old.project_id,old.id,old.path,old.language,old.version,old.content,(select auth.uid()));
  return new;
end;
$$;

create or replace function private.audit_code_file()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  item public.code_files%rowtype;
  operation_name text;
begin
  if tg_op='DELETE' then item:=old; else item:=new; end if;
  operation_name := case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'saved' else 'deleted' end;
  if tg_op='UPDATE' and old.path is not distinct from new.path
     and old.language is not distinct from new.language
     and old.content is not distinct from new.content then
    return new;
  end if;

  insert into public.activity_events(project_id,actor_id,actor_type,action,entity_type,entity_id,details)
  values (
    item.project_id,(select auth.uid()),'human','code_file.'||operation_name,'code_file',item.id,
    jsonb_build_object('path',item.path,'language',item.language,'version',item.version,'operation',tg_op)
  );
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create trigger protect_code_file before update or delete on public.code_files
for each row execute procedure private.enforce_code_file_lock();
create trigger archive_code_file_version after update on public.code_files
for each row when (old.content is distinct from new.content or old.path is distinct from new.path or old.language is distinct from new.language)
execute procedure private.archive_code_file_version();
create trigger audit_code_file_changes after insert or update or delete on public.code_files
for each row execute procedure private.audit_code_file();

alter table public.code_files enable row level security;
alter table public.code_file_versions enable row level security;
grant select,insert,update,delete on public.code_files to authenticated;
grant select on public.code_file_versions to authenticated;

create policy "Project members read code files" on public.code_files
for select to authenticated using (private.is_project_member(project_id));
create policy "Project members create code files" on public.code_files
for insert to authenticated with check (private.is_project_member(project_id) and created_by=(select auth.uid()));
create policy "Project members update code files" on public.code_files
for update to authenticated using (private.is_project_member(project_id)) with check (private.is_project_member(project_id));
create policy "Owners delete code files" on public.code_files
for delete to authenticated using (private.is_project_owner(project_id));
create policy "Members read code history" on public.code_file_versions
for select to authenticated using (private.is_project_member(project_id));

create trigger touch_code_file before update on public.code_files
for each row execute procedure private.touch_updated_at();

do $$
begin
  alter publication supabase_realtime add table public.code_files;
exception when duplicate_object then null;
end;
$$;
