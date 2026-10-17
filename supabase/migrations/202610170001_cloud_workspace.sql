-- CONTINUUM shared cloud workspace.
-- Apply with the Supabase CLI after linking the hosted project.
create extension if not exists pgcrypto;
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create type public.project_status as enum ('active','paused','completed');
create type public.task_status as enum ('backlog','todo','in_progress','in_review','done','blocked');
create type public.task_priority as enum ('low','normal','high','critical');
create type public.workspace_role as enum ('owner','collaborator');
create type public.actor_kind as enum ('human','agent','system');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 100),
  description text,
  status public.project_status not null default 'active',
  owner_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.workspace_role not null default 'collaborator',
  invited_by uuid references auth.users(id),
  joined_at timestamptz not null default now(),
  primary key (project_id,user_id)
);
create table public.workstreams (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 120),
  description text,
  status text not null default 'active' check (status in ('active','paused','completed')),
  position integer not null default 0,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.requirements (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  workstream_id uuid references public.workstreams(id) on delete set null,
  key text,
  title text not null check (length(trim(title)) between 2 and 180),
  description text,
  acceptance_criteria jsonb not null default '[]'::jsonb,
  status text not null default 'proposed' check (status in ('proposed','approved','in_progress','verified','rejected')),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.milestones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null check (length(trim(title)) between 2 and 180),
  description text,
  due_date date,
  status text not null default 'planned' check (status in ('planned','in_progress','at_risk','completed','cancelled')),
  position integer not null default 0,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  workstream_id uuid references public.workstreams(id) on delete set null,
  milestone_id uuid references public.milestones(id) on delete set null,
  parent_task_id uuid references public.tasks(id) on delete set null,
  title text not null check (length(trim(title)) between 2 and 180),
  description text,
  status public.task_status not null default 'todo',
  priority public.task_priority not null default 'normal',
  due_date date,
  assigned_to uuid references auth.users(id) on delete set null,
  created_by uuid not null default auth.uid() references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.task_dependencies (
  task_id uuid not null references public.tasks(id) on delete cascade,
  depends_on_task_id uuid not null references public.tasks(id) on delete cascade,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (task_id,depends_on_task_id),
  check (task_id <> depends_on_task_id)
);
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  workstream_id uuid references public.workstreams(id) on delete set null,
  title text not null check (length(trim(title)) between 2 and 180),
  document_type text not null default 'note',
  content_markdown text not null default '',
  version integer not null default 1 check (version > 0),
  created_by uuid not null default auth.uid() references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null check (length(trim(title)) between 2 and 180),
  context text not null default '',
  decision text not null default '',
  rationale text not null default '',
  status text not null default 'proposed' check (status in ('proposed','accepted','superseded','rejected')),
  decided_by uuid references auth.users(id),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.issues (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  title text not null check (length(trim(title)) between 2 and 180),
  description text,
  issue_type text not null default 'bug' check (issue_type in ('bug','risk','blocker','question','change')),
  severity text not null default 'normal' check (severity in ('low','normal','high','critical')),
  status text not null default 'open' check (status in ('open','in_progress','resolved','closed','accepted_risk')),
  assigned_to uuid references auth.users(id) on delete set null,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.test_cases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  requirement_id uuid references public.requirements(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null,
  name text not null check (length(trim(name)) between 2 and 180),
  description text,
  test_kind text not null default 'automated' check (test_kind in ('automated','manual','integration','acceptance','security','performance')),
  expected_result text,
  is_required boolean not null default true,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.test_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  test_case_id uuid references public.test_cases(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null,
  commit_sha text,
  build_id text,
  environment text not null default 'local',
  result text not null check (result in ('passed','failed','skipped','error','not_run')),
  duration_ms bigint check (duration_ms is null or duration_ms >= 0),
  summary text,
  log_text text,
  artifact_uri text,
  executed_by uuid references auth.users(id),
  actor_type public.actor_kind not null default 'human',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.repositories (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  provider text not null default 'github',
  remote_url text not null,
  default_branch text not null default 'main',
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  unique(project_id,remote_url)
);
create table public.releases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  version_label text not null,
  title text not null,
  status text not null default 'planned' check (status in ('planned','building','verification','ready','released','rolled_back','failed')),
  release_notes text,
  commit_sha text,
  released_at timestamptz,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id,version_label)
);
create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  agent_name text not null,
  runtime text not null,
  model_provider text,
  model_id text,
  status text not null default 'queued' check (status in ('queued','running','checkpointed','needs_review','completed','failed','cancelled','needs_permission')),
  requested_by uuid not null references auth.users(id),
  worker_id uuid,
  checkpoint jsonb not null default '{}'::jsonb,
  usage jsonb not null default '{}'::jsonb,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.worker_nodes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  display_name text not null,
  platform text not null,
  capabilities jsonb not null default '[]'::jsonb,
  status text not null default 'offline' check (status in ('online','busy','offline','disabled')),
  last_heartbeat_at timestamptz,
  registered_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create table public.resource_locks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  resource_type text not null,
  resource_id uuid not null,
  reason text not null default 'Protected by project owner',
  locked_by uuid not null references auth.users(id),
  is_locked boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id,resource_type,resource_id)
);
create table public.permission_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  resource_type text not null,
  resource_id uuid not null,
  requested_action text not null default 'edit',
  reason text not null,
  requested_by uuid not null default auth.uid() references auth.users(id),
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.permission_grants (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  resource_type text not null,
  resource_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  permitted_action text not null default 'edit',
  reason text not null,
  granted_by uuid not null references auth.users(id),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.activity_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  actor_type public.actor_kind not null default 'human',
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index projects_owner_idx on public.projects(owner_id);
create index project_members_user_idx on public.project_members(user_id,project_id);
create index tasks_project_status_idx on public.tasks(project_id,status);
create index tasks_project_created_idx on public.tasks(project_id,created_at desc);
create index events_project_created_idx on public.activity_events(project_id,created_at desc);
create index runs_project_status_idx on public.agent_runs(project_id,status);
create index tests_project_created_idx on public.test_runs(project_id,created_at desc);
create index locks_lookup_idx on public.resource_locks(project_id,resource_type,resource_id) where is_locked;
create index grants_lookup_idx on public.permission_grants(project_id,resource_type,resource_id,user_id) where revoked_at is null;

create or replace function private.is_project_member(target_project uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.project_members pm
    where pm.project_id=target_project and pm.user_id=(select auth.uid()));
$$;
create or replace function private.is_project_owner(target_project uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.project_members pm
    where pm.project_id=target_project and pm.user_id=(select auth.uid()) and pm.role='owner');
$$;
create or replace function private.has_resource_grant(target_project uuid,target_type text,target_id uuid,target_action text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.permission_grants pg
    where pg.project_id=target_project and pg.resource_type=target_type and pg.resource_id=target_id
      and pg.user_id=(select auth.uid()) and pg.permitted_action=target_action
      and pg.revoked_at is null and (pg.expires_at is null or pg.expires_at>now()));
$$;
revoke all on function private.is_project_member(uuid) from public,anon;
revoke all on function private.is_project_owner(uuid) from public,anon;
revoke all on function private.has_resource_grant(uuid,text,uuid,text) from public,anon;
grant execute on function private.is_project_member(uuid) to authenticated;
grant execute on function private.is_project_owner(uuid) to authenticated;
grant execute on function private.has_resource_grant(uuid,text,uuid,text) to authenticated;

create or replace function private.bootstrap_auth_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles(id,display_name)
  values (new.id,coalesce(new.raw_user_meta_data->>'display_name',split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end; $$;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure private.bootstrap_auth_user();

create or replace function private.add_project_owner_membership()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.project_members(project_id,user_id,role,invited_by)
  values (new.id,new.owner_id,'owner',new.owner_id)
  on conflict (project_id,user_id) do nothing;
  return new;
end; $$;
create trigger on_project_created after insert on public.projects
for each row execute procedure private.add_project_owner_membership();

create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = ''
as $$ begin new.updated_at=now(); return new; end; $$;

create or replace function private.enforce_resource_lock()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  old_data jsonb;
  new_data jsonb;
  target_project uuid;
  target_id uuid;
  target_type text;
begin
  old_data := to_jsonb(old);
  target_project := (old_data->>'project_id')::uuid;
  target_id := (old_data->>'id')::uuid;
  target_type := case tg_table_name
    when 'tasks' then 'task' when 'workstreams' then 'workstream'
    when 'requirements' then 'requirement' when 'milestones' then 'milestone'
    when 'documents' then 'document' when 'decisions' then 'decision'
    when 'issues' then 'issue' when 'test_cases' then 'test_case'
    when 'repositories' then 'repository' when 'releases' then 'release'
    else tg_table_name end;

  if tg_op='UPDATE' then
    new_data := to_jsonb(new);
    if (old_data-array['updated_at','updated_by']::text[]) is not distinct from
       (new_data-array['updated_at','updated_by']::text[]) then
      new.updated_at=now();
      return new;
    end if;
  end if;

  if exists (select 1 from public.resource_locks rl where rl.project_id=target_project
    and rl.resource_type=target_type and rl.resource_id=target_id and rl.is_locked)
    and not private.has_resource_grant(target_project,target_type,target_id,'edit') then
    raise exception 'This resource is protected. Request permission or ask the owner to unlock it.'
      using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  if tg_table_name='tasks' then new.updated_by=(select auth.uid()); end if;
  new.updated_at=now();
  return new;
end; $$;

create trigger protect_tasks before update or delete on public.tasks for each row execute procedure private.enforce_resource_lock();
create trigger protect_workstreams before update or delete on public.workstreams for each row execute procedure private.enforce_resource_lock();
create trigger protect_requirements before update or delete on public.requirements for each row execute procedure private.enforce_resource_lock();
create trigger protect_milestones before update or delete on public.milestones for each row execute procedure private.enforce_resource_lock();
create trigger protect_documents before update or delete on public.documents for each row execute procedure private.enforce_resource_lock();
create trigger protect_decisions before update or delete on public.decisions for each row execute procedure private.enforce_resource_lock();
create trigger protect_issues before update or delete on public.issues for each row execute procedure private.enforce_resource_lock();
create trigger protect_test_cases before update or delete on public.test_cases for each row execute procedure private.enforce_resource_lock();
create trigger protect_repositories before update or delete on public.repositories for each row execute procedure private.enforce_resource_lock();
create trigger protect_releases before update or delete on public.releases for each row execute procedure private.enforce_resource_lock();

create or replace function private.capture_activity()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  row_data jsonb;
  before_data jsonb;
  target_project uuid;
  target_id uuid;
  event_details jsonb;
begin
  if tg_op='DELETE' then row_data=to_jsonb(old); else row_data=to_jsonb(new); end if;
  if tg_table_name='projects' then target_project=(row_data->>'id')::uuid;
  else target_project=nullif(row_data->>'project_id','')::uuid; end if;
  target_id=nullif(row_data->>'id','')::uuid;
  event_details=jsonb_build_object(
    'title',coalesce(row_data->>'title',row_data->>'name',tg_table_name),
    'status',row_data->>'status',
    'operation',tg_op,
    'after',row_data-array['content_markdown','log_text','created_at','updated_at','password','secret']::text[]);
  if tg_op='UPDATE' then
    before_data=to_jsonb(old);
    event_details=event_details||jsonb_build_object('before',before_data-array['content_markdown','log_text','created_at','updated_at','password','secret']::text[]);
  end if;
  insert into public.activity_events(project_id,actor_id,actor_type,action,entity_type,entity_id,details)
  values (target_project,(select auth.uid()),'human',lower(tg_table_name)||'.'||lower(tg_op),tg_table_name,target_id,event_details);
  if tg_op='DELETE' then return old; end if;
  return new;
end; $$;

create trigger audit_projects after insert or update or delete on public.projects for each row execute procedure private.capture_activity();
create trigger audit_workstreams after insert or update or delete on public.workstreams for each row execute procedure private.capture_activity();
create trigger audit_requirements after insert or update or delete on public.requirements for each row execute procedure private.capture_activity();
create trigger audit_milestones after insert or update or delete on public.milestones for each row execute procedure private.capture_activity();
create trigger audit_tasks after insert or update or delete on public.tasks for each row execute procedure private.capture_activity();
create trigger audit_documents after insert or update or delete on public.documents for each row execute procedure private.capture_activity();
create trigger audit_decisions after insert or update or delete on public.decisions for each row execute procedure private.capture_activity();
create trigger audit_issues after insert or update or delete on public.issues for each row execute procedure private.capture_activity();
create trigger audit_test_cases after insert or update or delete on public.test_cases for each row execute procedure private.capture_activity();
create trigger audit_test_runs after insert or update or delete on public.test_runs for each row execute procedure private.capture_activity();
create trigger audit_repositories after insert or update or delete on public.repositories for each row execute procedure private.capture_activity();
create trigger audit_releases after insert or update or delete on public.releases for each row execute procedure private.capture_activity();
create trigger audit_locks after insert or update or delete on public.resource_locks for each row execute procedure private.capture_activity();
create trigger audit_permission_requests after insert or update or delete on public.permission_requests for each row execute procedure private.capture_activity();
create trigger audit_permission_grants after insert or update or delete on public.permission_grants for each row execute procedure private.capture_activity();
create trigger audit_agent_runs after insert or update or delete on public.agent_runs for each row execute procedure private.capture_activity();
create trigger audit_worker_nodes after insert or update or delete on public.worker_nodes for each row execute procedure private.capture_activity();

create or replace function public.review_permission_request(p_request_id uuid,p_approve boolean,p_grant_hours integer default 24)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  request_row public.permission_requests%rowtype;
  hours_value integer;
begin
  if (select auth.uid()) is null then raise exception 'Authentication is required.' using errcode='42501'; end if;
  select * into request_row from public.permission_requests where id=p_request_id for update;
  if not found then raise exception 'Permission request was not found.' using errcode='P0002'; end if;
  if not private.is_project_owner(request_row.project_id) then raise exception 'Only the project owner can review permission requests.' using errcode='42501'; end if;
  if request_row.status<>'pending' then raise exception 'This permission request has already been reviewed.' using errcode='55000'; end if;
  if p_approve then
    hours_value=greatest(1,least(coalesce(p_grant_hours,24),720));
    insert into public.permission_grants(project_id,resource_type,resource_id,user_id,permitted_action,reason,granted_by,expires_at)
    values(request_row.project_id,request_row.resource_type,request_row.resource_id,request_row.requested_by,
      request_row.requested_action,'Approved permission request '||request_row.id::text,
      (select auth.uid()),now()+make_interval(hours=>hours_value));
    update public.permission_requests set status='approved',reviewed_by=(select auth.uid()),reviewed_at=now() where id=p_request_id;
  else
    update public.permission_requests set status='rejected',reviewed_by=(select auth.uid()),reviewed_at=now() where id=p_request_id;
  end if;
end; $$;
revoke all on function public.review_permission_request(uuid,boolean,integer) from public,anon;
grant execute on function public.review_permission_request(uuid,boolean,integer) to authenticated;

create or replace function private.prevent_owner_membership_removal()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if old.role='owner' then raise exception 'Owner membership cannot be removed through this operation.' using errcode='42501'; end if;
  return old;
end; $$;
create trigger protect_owner_membership before delete on public.project_members
for each row execute procedure private.prevent_owner_membership_removal();

create trigger touch_profiles before update on public.profiles for each row execute procedure private.touch_updated_at();
create trigger touch_projects before update on public.projects for each row execute procedure private.touch_updated_at();
create trigger touch_workstreams before update on public.workstreams for each row execute procedure private.touch_updated_at();
create trigger touch_requirements before update on public.requirements for each row execute procedure private.touch_updated_at();
create trigger touch_milestones before update on public.milestones for each row execute procedure private.touch_updated_at();
create trigger touch_tasks before update on public.tasks for each row execute procedure private.touch_updated_at();
create trigger touch_documents before update on public.documents for each row execute procedure private.touch_updated_at();
create trigger touch_decisions before update on public.decisions for each row execute procedure private.touch_updated_at();
create trigger touch_issues before update on public.issues for each row execute procedure private.touch_updated_at();
create trigger touch_test_cases before update on public.test_cases for each row execute procedure private.touch_updated_at();
create trigger touch_releases before update on public.releases for each row execute procedure private.touch_updated_at();
create trigger touch_agent_runs before update on public.agent_runs for each row execute procedure private.touch_updated_at();
create trigger touch_locks before update on public.resource_locks for each row execute procedure private.touch_updated_at();

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.workstreams enable row level security;
alter table public.requirements enable row level security;
alter table public.milestones enable row level security;
alter table public.tasks enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.documents enable row level security;
alter table public.decisions enable row level security;
alter table public.issues enable row level security;
alter table public.test_cases enable row level security;
alter table public.test_runs enable row level security;
alter table public.repositories enable row level security;
alter table public.releases enable row level security;
alter table public.agent_runs enable row level security;
alter table public.worker_nodes enable row level security;
alter table public.resource_locks enable row level security;
alter table public.permission_requests enable row level security;
alter table public.permission_grants enable row level security;
alter table public.activity_events enable row level security;

revoke all on all tables in schema public from anon;
grant select,update on public.profiles to authenticated;
grant select,insert,update,delete on public.projects,public.project_members,public.workstreams,public.requirements,
  public.milestones,public.tasks,public.task_dependencies,public.documents,public.decisions,public.issues,
  public.test_cases,public.test_runs,public.repositories,public.releases,public.agent_runs,public.worker_nodes,
  public.resource_locks,public.permission_requests,public.permission_grants to authenticated;
grant select on public.activity_events to authenticated;

create policy "Read own profile" on public.profiles for select to authenticated using (id=(select auth.uid()));
create policy "Read project teammate profiles" on public.profiles for select to authenticated using (
  exists (select 1 from public.project_members mine join public.project_members theirs on theirs.project_id=mine.project_id
    where mine.user_id=(select auth.uid()) and theirs.user_id=id)
);
create policy "Update own profile" on public.profiles for update to authenticated using (id=(select auth.uid())) with check (id=(select auth.uid()));

create policy "Members read projects" on public.projects for select to authenticated using (private.is_project_member(id));
create policy "Create owned projects" on public.projects for insert to authenticated with check (owner_id=(select auth.uid()));
create policy "Owners update projects" on public.projects for update to authenticated using (private.is_project_owner(id)) with check (private.is_project_owner(id));

create policy "Members read memberships" on public.project_members for select to authenticated using (private.is_project_member(project_id));
create policy "Owners manage memberships" on public.project_members for all to authenticated using (private.is_project_owner(project_id)) with check (private.is_project_owner(project_id));

create policy "Members read workstreams" on public.workstreams for select to authenticated using (private.is_project_member(project_id));
create policy "Members create workstreams" on public.workstreams for insert to authenticated with check (private.is_project_member(project_id) and created_by=(select auth.uid()));
create policy "Members update workstreams" on public.workstreams for update to authenticated using (private.is_project_member(project_id)) with check (private.is_project_member(project_id));
create policy "Owners delete workstreams" on public.workstreams for delete to authenticated using (private.is_project_owner(project_id));

create policy "Members read requirements" on public.requirements for select to authenticated using (private.is_project_member(project_id));
create policy "Members create requirements" on public.requirements for insert to authenticated with check (private.is_project_member(project_id) and created_by=(select auth.uid()));
create policy "Members update requirements" on public.requirements for update to authenticated using (private.is_project_member(project_id)) with check (private.is_project_member(project_id));
create policy "Owners delete requirements" on public.requirements for delete to authenticated using (private.is_project_owner(project_id));

create policy "Members read milestones" on public.milestones for select to authenticated using (private.is_project_member(project_id));
create policy "Members create milestones" on public.milestones for insert to authenticated with check (private.is_project_member(project_id) and created_by=(select auth.uid()));
create policy "Members update milestones" on public.milestones for update to authenticated using (private.is_project_member(project_id)) with check (private.is_project_member(project_id));
create policy "Owners delete milestones" on public.milestones for delete to authenticated using (private.is_project_owner(project_id));

create policy "Members read tasks" on public.tasks for select to authenticated using (private.is_project_member(project_id));
create policy "Members create tasks" on public.tasks for insert to authenticated with check (private.is_project_member(project_id) and created_by=(select auth.uid()));
create policy "Members update tasks" on public.tasks for update to authenticated using (private.is_project_member(project_id)) with check (private.is_project_member(project_id));
create policy "Owners delete tasks" on public.tasks for delete to authenticated using (private.is_project_owner(project_id));

create policy "Members read dependencies" on public.task_dependencies for select to authenticated using (
  exists (select 1 from public.tasks t where t.id=task_id and private.is_project_member(t.project_id)));
create policy "Members manage dependencies" on public.task_dependencies for all to authenticated
using (exists (select 1 from public.tasks t where t.id=task_id and private.is_project_member(t.project_id)))
with check (exists (select 1 from public.tasks t join public.tasks parent on parent.id=depends_on_task_id
  where t.id=task_id and t.project_id=parent.project_id and private.is_project_member(t.project_id)));

create policy "Members read documents" on public.documents for select to authenticated using (private.is_project_member(project_id));
create policy "Members create documents" on public.documents for insert to authenticated with check (private.is_project_member(project_id) and created_by=(select auth.uid()));
create policy "Members update documents" on public.documents for update to authenticated using (private.is_project_member(project_id)) with check (private.is_project_member(project_id));
create policy "Owners delete documents" on public.documents for delete to authenticated using (private.is_project_owner(project_id));

create policy "Members read decisions" on public.decisions for select to authenticated using (private.is_project_member(project_id));
create policy "Members create decisions" on public.decisions for insert to authenticated with check (private.is_project_member(project_id) and created_by=(select auth.uid()));
create policy "Members update decisions" on public.decisions for update to authenticated using (private.is_project_member(project_id)) with check (private.is_project_member(project_id));
create policy "Owners delete decisions" on public.decisions for delete to authenticated using (private.is_project_owner(project_id));

create policy "Members read issues" on public.issues for select to authenticated using (private.is_project_member(project_id));
create policy "Members create issues" on public.issues for insert to authenticated with check (private.is_project_member(project_id) and created_by=(select auth.uid()));
create policy "Members update issues" on public.issues for update to authenticated using (private.is_project_member(project_id)) with check (private.is_project_member(project_id));
create policy "Owners delete issues" on public.issues for delete to authenticated using (private.is_project_owner(project_id));

create policy "Members read test cases" on public.test_cases for select to authenticated using (private.is_project_member(project_id));
create policy "Members create test cases" on public.test_cases for insert to authenticated with check (private.is_project_member(project_id) and created_by=(select auth.uid()));
create policy "Members update test cases" on public.test_cases for update to authenticated using (private.is_project_member(project_id)) with check (private.is_project_member(project_id));
create policy "Owners delete test cases" on public.test_cases for delete to authenticated using (private.is_project_owner(project_id));

create policy "Members read test runs" on public.test_runs for select to authenticated using (private.is_project_member(project_id));
create policy "Members record test runs" on public.test_runs for insert to authenticated with check (private.is_project_member(project_id) and (executed_by is null or executed_by=(select auth.uid())));
create policy "Owners delete test runs" on public.test_runs for delete to authenticated using (private.is_project_owner(project_id));

create policy "Members read repositories" on public.repositories for select to authenticated using (private.is_project_member(project_id));
create policy "Members create repositories" on public.repositories for insert to authenticated with check (private.is_project_member(project_id) and created_by=(select auth.uid()));
create policy "Owners update repositories" on public.repositories for update to authenticated using (private.is_project_owner(project_id)) with check (private.is_project_owner(project_id));
create policy "Owners delete repositories" on public.repositories for delete to authenticated using (private.is_project_owner(project_id));

create policy "Members read releases" on public.releases for select to authenticated using (private.is_project_member(project_id));
create policy "Members create releases" on public.releases for insert to authenticated with check (private.is_project_member(project_id) and created_by=(select auth.uid()));
create policy "Members update releases" on public.releases for update to authenticated using (private.is_project_member(project_id)) with check (private.is_project_member(project_id));
create policy "Owners delete releases" on public.releases for delete to authenticated using (private.is_project_owner(project_id));

create policy "Members read agent runs" on public.agent_runs for select to authenticated using (private.is_project_member(project_id));
create policy "Members queue agent runs" on public.agent_runs for insert to authenticated with check (private.is_project_member(project_id) and requested_by=(select auth.uid()));
create policy "Owners manage agent runs" on public.agent_runs for update to authenticated using (private.is_project_owner(project_id)) with check (private.is_project_owner(project_id));
create policy "Members read workers" on public.worker_nodes for select to authenticated using (private.is_project_member(project_id));
create policy "Owners register workers" on public.worker_nodes for insert to authenticated with check (private.is_project_owner(project_id) and registered_by=(select auth.uid()));
create policy "Owners manage workers" on public.worker_nodes for update to authenticated using (private.is_project_owner(project_id)) with check (private.is_project_owner(project_id));

create policy "Members read locks" on public.resource_locks for select to authenticated using (private.is_project_member(project_id));
create policy "Owners insert locks" on public.resource_locks for insert to authenticated with check (private.is_project_owner(project_id) and locked_by=(select auth.uid()));
create policy "Owners update locks" on public.resource_locks for update to authenticated using (private.is_project_owner(project_id)) with check (private.is_project_owner(project_id));
create policy "Owners delete locks" on public.resource_locks for delete to authenticated using (private.is_project_owner(project_id));

create policy "Members read permission requests" on public.permission_requests for select to authenticated using (private.is_project_member(project_id));
create policy "Members create permission requests" on public.permission_requests for insert to authenticated with check (private.is_project_member(project_id) and requested_by=(select auth.uid()));
create policy "Owners review requests" on public.permission_requests for update to authenticated using (private.is_project_owner(project_id)) with check (private.is_project_owner(project_id));

create policy "Owners read grants" on public.permission_grants for select to authenticated using (private.is_project_owner(project_id));
create policy "Recipients read own grants" on public.permission_grants for select to authenticated using (user_id=(select auth.uid()));
create policy "Owners insert grants" on public.permission_grants for insert to authenticated with check (private.is_project_owner(project_id) and granted_by=(select auth.uid()));
create policy "Owners update grants" on public.permission_grants for update to authenticated using (private.is_project_owner(project_id)) with check (private.is_project_owner(project_id));
create policy "Owners delete grants" on public.permission_grants for delete to authenticated using (private.is_project_owner(project_id));

create policy "Members read activity" on public.activity_events for select to authenticated using (private.is_project_member(project_id));

do $$
begin
  alter publication supabase_realtime add table public.tasks;
  alter publication supabase_realtime add table public.activity_events;
  alter publication supabase_realtime add table public.resource_locks;
  alter publication supabase_realtime add table public.permission_requests;
  alter publication supabase_realtime add table public.permission_grants;
  alter publication supabase_realtime add table public.agent_runs;
  alter publication supabase_realtime add table public.worker_nodes;
exception when duplicate_object then null;
end;
$$;
