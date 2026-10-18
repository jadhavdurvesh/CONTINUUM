-- Durable project-scoped agent sessions and shared conversation history.
-- The source prompt, handoffs, plans, model summaries, and tool outcomes live in the cloud.
-- Provider credentials and filesystem access remain on the authorized local worker.

create table public.agent_sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  title text not null check (length(trim(title)) between 2 and 160),
  goal text not null check (length(trim(goal)) between 1 and 20000),
  current_agent text not null default 'planner'
    check (current_agent in ('planner','coder','reviewer','qa')),
  status text not null default 'queued'
    check (status in ('queued','running','needs_review','completed','failed','cancelled')),
  focus_paths text[] not null default '{}'::text[],
  context jsonb not null default '{}'::jsonb,
  checkpoint jsonb not null default '{}'::jsonb,
  last_error text,
  requested_by uuid not null default auth.uid() references auth.users(id),
  claimed_by uuid references auth.users(id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  session_id uuid not null references public.agent_sessions(id) on delete cascade,
  run_id uuid references public.agent_runs(id) on delete set null,
  role text not null check (role in ('user','assistant','system','tool')),
  actor_type public.actor_kind not null default 'human',
  actor_id uuid references auth.users(id) on delete set null,
  content text not null check (length(content) <= 500000),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.agent_runs
  add column session_id uuid references public.agent_sessions(id) on delete set null;

create index agent_sessions_project_status_idx
  on public.agent_sessions(project_id,status,updated_at desc);
create index agent_sessions_task_idx on public.agent_sessions(project_id,task_id,created_at desc);
create index agent_messages_session_created_idx
  on public.agent_messages(session_id,created_at desc);
create index agent_messages_project_created_idx
  on public.agent_messages(project_id,created_at desc);
create index agent_runs_session_created_idx
  on public.agent_runs(session_id,created_at desc);

alter table public.agent_sessions enable row level security;
alter table public.agent_messages enable row level security;

grant select,insert,update,delete on public.agent_sessions to authenticated;
grant select,insert on public.agent_messages to authenticated;
grant update on public.agent_runs to authenticated;

create policy "Project members read agent sessions"
  on public.agent_sessions for select to authenticated
  using (private.is_project_member(project_id));
create policy "Project members create agent sessions"
  on public.agent_sessions for insert to authenticated
  with check (private.is_project_member(project_id) and requested_by=(select auth.uid()));
create policy "Project members update agent sessions"
  on public.agent_sessions for update to authenticated
  using (private.is_project_member(project_id))
  with check (private.is_project_member(project_id));
create policy "Project owners delete agent sessions"
  on public.agent_sessions for delete to authenticated
  using (private.is_project_owner(project_id));

create policy "Project members read agent messages"
  on public.agent_messages for select to authenticated
  using (private.is_project_member(project_id));
create policy "Project members append agent messages"
  on public.agent_messages for insert to authenticated
  with check (
    private.is_project_member(project_id)
    and actor_id=(select auth.uid())
    and exists (
      select 1 from public.agent_sessions s
      where s.id=session_id and s.project_id=agent_messages.project_id
    )
  );

create policy "Members update their own agent runs"
  on public.agent_runs for update to authenticated
  using (private.is_project_member(project_id) and requested_by=(select auth.uid()))
  with check (private.is_project_member(project_id) and requested_by=(select auth.uid()));

create or replace function private.audit_agent_session()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  item public.agent_sessions%rowtype;
  operation_name text;
begin
  if tg_op='DELETE' then item:=old; else item:=new; end if;
  operation_name := case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end;
  if tg_op='UPDATE' and old.status is not distinct from new.status
      and old.current_agent is not distinct from new.current_agent
      and old.title is not distinct from new.title
      and old.task_id is not distinct from new.task_id then
    return new;
  end if;
  insert into public.activity_events(project_id,actor_id,actor_type,action,entity_type,entity_id,details)
  values (
    item.project_id,(select auth.uid()),'human','agent_session.'||operation_name,
    'agent_session',item.id,
    jsonb_build_object('title',item.title,'status',item.status,'current_agent',item.current_agent,'task_id',item.task_id)
  );
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function private.audit_agent_message()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.activity_events(project_id,actor_id,actor_type,action,entity_type,entity_id,details)
  values (
    new.project_id,new.actor_id,new.actor_type,'agent_message.appended',
    'agent_session',new.session_id,
    jsonb_build_object('role',new.role,'message_id',new.id,'run_id',new.run_id,'characters',length(new.content))
  );
  return new;
end;
$$;

create trigger audit_agent_sessions
after insert or update or delete on public.agent_sessions
for each row execute procedure private.audit_agent_session();
create trigger audit_agent_messages
after insert on public.agent_messages
for each row execute procedure private.audit_agent_message();

create trigger touch_agent_sessions before update on public.agent_sessions
for each row execute procedure private.touch_updated_at();

do $$
begin
  alter publication supabase_realtime add table public.agent_sessions;
  alter publication supabase_realtime add table public.agent_messages;
exception when duplicate_object then null;
end;
$$;
