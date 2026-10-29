-- CONTINUUM Engineering OS, milestone 2: full project-management model.
-- Plan (milestones, workstreams, dependencies, subtasks), knowledge (versioned documents, ADR-style decisions,
-- a typed link graph), quality (defects) and releases (scoped, evidence-gated). Every rule is enforced in the
-- database so the dashboard, the IDE and agents all play by the same rules.

-- =============================================================================================
-- 0. Bug fix: creating a project with INSERT ... RETURNING (what the dashboard does) failed with
--    "new row violates row-level security policy". The owner's membership row is created by an AFTER trigger,
--    so it does not exist yet when PostgreSQL checks the SELECT policy on the returned row.
--    Owners can always read their own project.
-- =============================================================================================
drop policy if exists "Members read projects" on public.projects;
create policy "Members and owners read projects" on public.projects for select to authenticated
  using (owner_id = (select auth.uid()) or private.is_project_member(id));

-- =============================================================================================
-- 1. Integrity: references must stay inside one project; assignees must be members.
-- =============================================================================================
create or replace function private.enforce_same_project_refs()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  spec text; col text; tbl text; val text; ok boolean;
begin
  foreach spec in array tg_argv loop
    col := split_part(spec, ':', 1);
    tbl := split_part(spec, ':', 2);
    val := to_jsonb(new)->>col;
    if val is not null then
      execute format('select exists (select 1 from public.%I where id = $1 and project_id = $2)', tbl)
        into ok using val::uuid, new.project_id;
      if not ok then
        raise exception '% % does not belong to project %', col, val, new.project_id using errcode = '23514';
      end if;
    end if;
  end loop;
  return new;
end;
$$;

create or replace function private.enforce_assignee_member()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.assigned_to is not null and not exists (
    select 1 from public.project_members m where m.project_id = new.project_id and m.user_id = new.assigned_to) then
    raise exception 'The assignee must be a member of this project.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_task_links on public.tasks;  -- superseded by the generic trigger below
drop trigger if exists enforce_task_refs on public.tasks;
create trigger enforce_task_refs before insert or update of project_id, workstream_id, milestone_id, parent_task_id, requirement_id on public.tasks
  for each row execute procedure private.enforce_same_project_refs('workstream_id:workstreams','milestone_id:milestones','parent_task_id:tasks','requirement_id:requirements');
drop trigger if exists enforce_requirement_refs on public.requirements;
create trigger enforce_requirement_refs before insert or update of project_id, workstream_id on public.requirements
  for each row execute procedure private.enforce_same_project_refs('workstream_id:workstreams');
drop trigger if exists enforce_document_refs on public.documents;
create trigger enforce_document_refs before insert or update of project_id, workstream_id on public.documents
  for each row execute procedure private.enforce_same_project_refs('workstream_id:workstreams');
drop trigger if exists enforce_issue_refs on public.issues;
create trigger enforce_issue_refs before insert or update of project_id, task_id on public.issues
  for each row execute procedure private.enforce_same_project_refs('task_id:tasks');
drop trigger if exists enforce_test_case_refs on public.test_cases;
create trigger enforce_test_case_refs before insert or update of project_id, requirement_id, task_id on public.test_cases
  for each row execute procedure private.enforce_same_project_refs('requirement_id:requirements','task_id:tasks');

drop trigger if exists enforce_task_assignee on public.tasks;
create trigger enforce_task_assignee before insert or update of assigned_to on public.tasks
  for each row execute procedure private.enforce_assignee_member();
drop trigger if exists enforce_issue_assignee on public.issues;
create trigger enforce_issue_assignee before insert or update of assigned_to on public.issues
  for each row execute procedure private.enforce_assignee_member();

-- Subtask hierarchy and dependency graph must stay acyclic.
create or replace function private.prevent_task_parent_cycle()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.parent_task_id is null then return new; end if;
  if new.parent_task_id = new.id then
    raise exception 'A task cannot be its own parent.' using errcode = '23514';
  end if;
  if exists (
    with recursive up as (
      select id, parent_task_id from public.tasks where id = new.parent_task_id
      union
      select t.id, t.parent_task_id from public.tasks t join up on t.id = up.parent_task_id)
    select 1 from up where id = new.id) then
    raise exception 'That parent would create a loop in the task hierarchy.' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists prevent_task_parent_cycle on public.tasks;
create trigger prevent_task_parent_cycle before insert or update of parent_task_id on public.tasks
  for each row execute procedure private.prevent_task_parent_cycle();

create or replace function private.prevent_dependency_cycle()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.tasks a join public.tasks b on b.project_id = a.project_id
                 where a.id = new.task_id and b.id = new.depends_on_task_id) then
    raise exception 'Dependencies must connect tasks of the same project.' using errcode = '23514';
  end if;
  if exists (
    with recursive downstream as (
      select depends_on_task_id as id from public.task_dependencies where task_id = new.depends_on_task_id
      union
      select d.depends_on_task_id from public.task_dependencies d join downstream x on d.task_id = x.id)
    select 1 from downstream where id = new.task_id) then
    raise exception 'That dependency would create a circular dependency.' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists prevent_dependency_cycle on public.task_dependencies;
create trigger prevent_dependency_cycle before insert on public.task_dependencies
  for each row execute procedure private.prevent_dependency_cycle();

-- =============================================================================================
-- 2. Completion gate now also respects the plan: dependencies, subtasks, open high-severity defects.
-- =============================================================================================
create or replace function public.task_completion_status(p_task_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = ''
as $$
declare
  t public.tasks%rowtype;
  blockers text[] := '{}';
  cases jsonb := '[]'::jsonb;
  latest_test_at timestamptz;
  latest_run_result text;
  rev public.task_reviews%rowtype;
  case_count int;
  members int;
  n int;
begin
  select * into t from public.tasks where id = p_task_id;
  if not found then return null; end if;

  -- Required cases: linked to the task directly, or to its requirement when not tied to another task.
  with required as (
    select c.id, c.name from public.test_cases c
    where c.project_id = t.project_id and c.is_required
      and (c.task_id = t.id or (t.requirement_id is not null and c.requirement_id = t.requirement_id and c.task_id is null))
  ), latest as (
    select r.id, r.name,
           (select tr.result from public.test_runs tr where tr.test_case_id = r.id and tr.project_id = t.project_id
              order by tr.created_at desc, tr.id desc limit 1) as result,
           (select tr.created_at from public.test_runs tr where tr.test_case_id = r.id and tr.project_id = t.project_id
              order by tr.created_at desc, tr.id desc limit 1) as ran_at
    from required r
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'latest_result', coalesce(result, 'not_run'), 'ran_at', ran_at) order by name), '[]'::jsonb),
         count(*)
    into cases, case_count from latest;

  if case_count > 0 then
    select count(*) filter (where (e->>'latest_result') <> 'passed') into case_count from jsonb_array_elements(cases) e;
    if case_count > 0 then
      blockers := blockers || (case_count::text || ' required test case(s) have not passed');
    end if;
    select max((e->>'ran_at')::timestamptz) into latest_test_at from jsonb_array_elements(cases) e;
  else
    -- No cases defined: the most recent run recorded against the task itself must have passed.
    select tr.result, tr.created_at into latest_run_result, latest_test_at
      from public.test_runs tr where tr.task_id = t.id and tr.project_id = t.project_id
      order by tr.created_at desc, tr.id desc limit 1;
    if latest_run_result is null then
      blockers := blockers || 'no test run has been recorded for this task'::text;
    elsif latest_run_result <> 'passed' then
      blockers := blockers || ('the latest test run is "' || latest_run_result || '"');
    end if;
  end if;

  -- A later test run supersedes an older failing one only through the "latest" rule above; a failure after the
  -- review makes the review stale (checked below via latest_test_at).
  select * into rev from public.task_reviews
    where task_id = t.id and project_id = t.project_id order by created_at desc, id desc limit 1;
  select count(*) into members from public.project_members where project_id = t.project_id;

  if rev.id is null then
    blockers := blockers || 'no human review has been recorded'::text;
  elsif rev.decision <> 'approved' then
    blockers := blockers || 'the latest review requested changes'::text;
  elsif latest_test_at is not null and rev.created_at < latest_test_at then
    blockers := blockers || 'tests ran after the last approval; a fresh review is required'::text;
  elsif members > 1 and t.assigned_to is not null and rev.reviewer_id = t.assigned_to then
    blockers := blockers || 'the assignee cannot approve their own work'::text;
  end if;

  -- Project-management rules: the plan must also be satisfied, not only the tests.
  select count(*) into n from public.task_dependencies d
    join public.tasks dt on dt.id = d.depends_on_task_id where d.task_id = t.id and dt.status <> 'done';
  if n > 0 then blockers := blockers || (n::text || ' dependency task(s) are not done'); end if;
  select count(*) into n from public.tasks c where c.parent_task_id = t.id and c.status <> 'done';
  if n > 0 then blockers := blockers || (n::text || ' subtask(s) are not done'); end if;
  select count(*) into n from public.issues i
    where i.task_id = t.id and i.status in ('open','in_progress') and i.severity in ('high','critical') and i.issue_type in ('bug','blocker');
  if n > 0 then blockers := blockers || (n::text || ' open high-severity defect(s) are linked to this task'); end if;

  return jsonb_build_object(
    'task_id', t.id,
    'status', t.status,
    'requires_evidence', t.requires_evidence,
    'ready', coalesce(array_length(blockers, 1), 0) = 0,
    'blockers', to_jsonb(blockers),
    'required_cases', cases,
    'last_test_at', latest_test_at,
    'latest_review', case when rev.id is null then null else jsonb_build_object(
      'decision', rev.decision, 'reviewer_id', rev.reviewer_id, 'created_at', rev.created_at, 'notes', rev.notes) end
  );
end;
$$;
grant execute on function public.task_completion_status(uuid) to authenticated;

-- =============================================================================================
-- 3. Milestones: "completed" must be true.
-- =============================================================================================
create or replace function private.enforce_milestone_completion()
returns trigger language plpgsql security invoker set search_path = ''
as $$
declare open_tasks int;
begin
  if new.status = 'completed' and (tg_op = 'INSERT' or old.status is distinct from 'completed')
     and (select auth.uid()) is not null then
    select count(*) into open_tasks from public.tasks where milestone_id = new.id and status <> 'done';
    if open_tasks > 0 then
      raise exception 'Milestone cannot be completed: % task(s) are not done.', open_tasks using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists enforce_milestone_completion on public.milestones;
create trigger enforce_milestone_completion before insert or update of status on public.milestones
  for each row execute procedure private.enforce_milestone_completion();

-- One-call plan summary for the Plan page and the command center.
create or replace function public.project_plan(p_project_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  with ok as (select private.is_project_member(p_project_id) as member),
  ms as (
    select m.id, m.title, m.status, m.due_date, m.position,
           count(t.id) as total,
           count(t.id) filter (where t.status = 'done') as done,
           count(t.id) filter (where t.status = 'blocked') as blocked,
           count(t.id) filter (where t.status <> 'done' and t.due_date < current_date) as overdue
    from public.milestones m left join public.tasks t on t.milestone_id = m.id
    where m.project_id = p_project_id group by m.id),
  ws as (
    select w.id, w.name, w.status, w.position,
           count(t.id) as total, count(t.id) filter (where t.status = 'done') as done
    from public.workstreams w left join public.tasks t on t.workstream_id = w.id
    where w.project_id = p_project_id group by w.id)
  select case when not (select member from ok) then null else jsonb_build_object(
    'milestones', coalesce((select jsonb_agg(to_jsonb(ms) || jsonb_build_object(
        'percent', case when total = 0 then 0 else round(100.0 * done / total) end)
        order by position, due_date nulls last) from ms), '[]'::jsonb),
    'workstreams', coalesce((select jsonb_agg(to_jsonb(ws) || jsonb_build_object(
        'percent', case when total = 0 then 0 else round(100.0 * done / total) end)
        order by position, name) from ws), '[]'::jsonb),
    'summary', jsonb_build_object(
      'open_tasks', (select count(*) from public.tasks where project_id = p_project_id and status <> 'done'),
      'unassigned', (select count(*) from public.tasks where project_id = p_project_id and status <> 'done' and assigned_to is null),
      'overdue', (select count(*) from public.tasks where project_id = p_project_id and status <> 'done' and due_date < current_date),
      'blocked_by_dependency', (select count(distinct t.id) from public.tasks t
          join public.task_dependencies d on d.task_id = t.id join public.tasks dt on dt.id = d.depends_on_task_id
          where t.project_id = p_project_id and t.status <> 'done' and dt.status <> 'done'))) end;
$$;
grant execute on function public.project_plan(uuid) to authenticated;

-- =============================================================================================
-- 4. Knowledge: versioned documents with optimistic concurrency, governed decisions, a typed link graph.
-- =============================================================================================
create table if not exists public.document_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  version integer not null,
  title text not null,
  document_type text not null,
  content_markdown text not null,
  edited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (document_id, version)
);
alter table public.document_versions enable row level security;
create policy "Members read document versions" on public.document_versions for select to authenticated
  using (private.is_project_member(project_id));
grant select on public.document_versions to authenticated;

create or replace function private.version_document()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    new.updated_by := (select auth.uid());
    return new;
  end if;
  -- Clients send the version they loaded. A mismatch means someone saved first.
  if new.version is distinct from old.version then
    -- PT409 = HTTP 409 Conflict in PostgREST. Do NOT use SQLSTATE 40001 here: PostgREST's driver treats it as a
    -- serialization failure and retries the transaction forever.
    raise exception 'Version conflict: this document was changed by someone else. Reload and merge your edits.' using errcode = 'PT409';
  end if;
  if new.title is distinct from old.title or new.content_markdown is distinct from old.content_markdown
     or new.document_type is distinct from old.document_type then
    insert into public.document_versions (project_id, document_id, version, title, document_type, content_markdown, edited_by)
    values (old.project_id, old.id, old.version, old.title, old.document_type, old.content_markdown, coalesce(old.updated_by, old.created_by));
    new.version := old.version + 1;
    new.updated_by := (select auth.uid());
  end if;
  return new;
end;
$$;
drop trigger if exists a_version_document on public.documents;
create trigger a_version_document before insert or update on public.documents
  for each row execute procedure private.version_document();

create or replace function private.govern_decision()
returns trigger language plpgsql security invoker set search_path = ''
as $$
declare actor uuid := (select auth.uid());
begin
  if actor is null then return new; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'proposed' then
      raise exception 'Decisions are created as proposed; an owner accepts or rejects them.' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.status is distinct from old.status then
    if not private.is_project_owner(new.project_id) then
      raise exception 'Only project owners can accept, reject, or supersede a decision.' using errcode = '42501';
    end if;
    if new.status in ('accepted','rejected') then new.decided_by := actor; end if;
  end if;
  if old.status = 'accepted' and (new.title is distinct from old.title or new.context is distinct from old.context
      or new.decision is distinct from old.decision or new.rationale is distinct from old.rationale) then
    raise exception 'Accepted decisions are immutable. Propose a new decision and supersede this one.' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists govern_decision on public.decisions;
create trigger govern_decision before insert or update on public.decisions
  for each row execute procedure private.govern_decision();

create table if not exists public.project_links (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  source_type text not null check (source_type in ('task','requirement','document','decision','issue','milestone','release','test_case')),
  source_id uuid not null,
  target_type text not null check (target_type in ('task','requirement','document','decision','issue','milestone','release','test_case')),
  target_id uuid not null,
  relation text not null default 'relates_to' check (relation in ('relates_to','explains','implements','depends_on','blocks','tests','decides','supersedes')),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  unique (source_type, source_id, target_type, target_id, relation),
  check (not (source_type = target_type and source_id = target_id))
);
create index if not exists project_links_source_idx on public.project_links(project_id, source_type, source_id);
create index if not exists project_links_target_idx on public.project_links(project_id, target_type, target_id);
alter table public.project_links enable row level security;
create policy "Members read links" on public.project_links for select to authenticated using (private.is_project_member(project_id));
create policy "Members create links" on public.project_links for insert to authenticated
  with check (private.is_project_member(project_id) and created_by = (select auth.uid()));
create policy "Creators or owners delete links" on public.project_links for delete to authenticated
  using (private.is_project_member(project_id) and (created_by = (select auth.uid()) or private.is_project_owner(project_id)));
grant select, insert, delete on public.project_links to authenticated;

create or replace function private.link_table(entity_type text)
returns text language sql immutable set search_path = ''
as $$ select case entity_type
  when 'task' then 'tasks' when 'requirement' then 'requirements' when 'document' then 'documents'
  when 'decision' then 'decisions' when 'issue' then 'issues' when 'milestone' then 'milestones'
  when 'release' then 'releases' when 'test_case' then 'test_cases' end $$;

create or replace function private.enforce_link_integrity()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare ok boolean;
begin
  -- BEFORE triggers run ahead of CHECK constraints, so reject unknown types here with a clear message.
  if private.link_table(new.source_type) is null or private.link_table(new.target_type) is null then
    raise exception 'Unknown entity type in link (%, %).', new.source_type, new.target_type using errcode = '23514';
  end if;
  execute format('select exists (select 1 from public.%I where id = $1 and project_id = $2)', private.link_table(new.source_type))
    into ok using new.source_id, new.project_id;
  if not ok then raise exception 'The source % does not belong to this project.', new.source_type using errcode = '23514'; end if;
  execute format('select exists (select 1 from public.%I where id = $1 and project_id = $2)', private.link_table(new.target_type))
    into ok using new.target_id, new.project_id;
  if not ok then raise exception 'The target % does not belong to this project.', new.target_type using errcode = '23514'; end if;
  return new;
end;
$$;
drop trigger if exists enforce_link_integrity on public.project_links;
create trigger enforce_link_integrity before insert on public.project_links
  for each row execute procedure private.enforce_link_integrity();

-- Deleting an entity removes its links so the graph never points at nothing.
create or replace function private.cleanup_links()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.project_links
   where (source_type = tg_argv[0] and source_id = old.id) or (target_type = tg_argv[0] and target_id = old.id);
  return old;
end;
$$;
do $$
declare spec text[]; pair text[];
begin
  foreach pair slice 1 in array array[['tasks','task'],['requirements','requirement'],['documents','document'],['decisions','decision'],
                                       ['issues','issue'],['milestones','milestone'],['releases','release'],['test_cases','test_case']] loop
    execute format('drop trigger if exists cleanup_links on public.%I', pair[1]);
    execute format('create trigger cleanup_links after delete on public.%I for each row execute procedure private.cleanup_links(%L)', pair[1], pair[2]);
  end loop;
end $$;

-- =============================================================================================
-- 5. Quality: only owners can accept a risk.
-- =============================================================================================
create or replace function private.govern_issue()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and new.status = 'accepted_risk'
     and (tg_op = 'INSERT' or old.status is distinct from 'accepted_risk')
     and not private.is_project_owner(new.project_id) then
    raise exception 'Only project owners can accept a risk.' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists govern_issue on public.issues;
create trigger govern_issue before insert or update of status on public.issues
  for each row execute procedure private.govern_issue();

-- =============================================================================================
-- 6. Releases: scoped to requirements, ready only when the evidence says so.
-- =============================================================================================
create table if not exists public.release_requirements (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  release_id uuid not null references public.releases(id) on delete cascade,
  requirement_id uuid not null references public.requirements(id) on delete cascade,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  unique (release_id, requirement_id)
);
alter table public.release_requirements enable row level security;
create policy "Members read release scope" on public.release_requirements for select to authenticated using (private.is_project_member(project_id));
create policy "Members add release scope" on public.release_requirements for insert to authenticated
  with check (private.is_project_member(project_id) and created_by = (select auth.uid()));
create policy "Members remove release scope" on public.release_requirements for delete to authenticated using (private.is_project_member(project_id));
grant select, insert, delete on public.release_requirements to authenticated;

create or replace function private.guard_release_scope()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare rel_status text; rel_id uuid;
begin
  rel_id := case when tg_op = 'DELETE' then old.release_id else new.release_id end;
  select status into rel_status from public.releases where id = rel_id;
  if rel_status in ('released','rolled_back') and (select auth.uid()) is not null then
    raise exception 'The scope of a released version is frozen.' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists guard_release_scope on public.release_requirements;
create trigger guard_release_scope before insert or delete on public.release_requirements
  for each row execute procedure private.guard_release_scope();
drop trigger if exists enforce_release_scope_refs on public.release_requirements;
create trigger enforce_release_scope_refs before insert on public.release_requirements
  for each row execute procedure private.enforce_same_project_refs('release_id:releases','requirement_id:requirements');

create or replace function public.release_readiness(p_release_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = ''
as $$
declare
  r public.releases%rowtype;
  blockers text[] := '{}';
  scope_total int; scope_open int; defects int; reqs jsonb;
begin
  select * into r from public.releases where id = p_release_id;
  if not found then return null; end if;
  select count(*), count(*) filter (where q.status <> 'verified'),
         coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'title', q.title, 'status', q.status) order by q.title), '[]'::jsonb)
    into scope_total, scope_open, reqs
    from public.release_requirements rr join public.requirements q on q.id = rr.requirement_id
    where rr.release_id = r.id;
  if scope_total = 0 then blockers := blockers || 'no requirements are in scope for this release'::text;
  elsif scope_open > 0 then blockers := blockers || (scope_open::text || ' requirement(s) are not verified'); end if;
  select count(*) into defects from public.issues
    where project_id = r.project_id and status in ('open','in_progress') and severity in ('high','critical') and issue_type in ('bug','blocker');
  if defects > 0 then blockers := blockers || (defects::text || ' open high-severity defect(s) in the project'); end if;
  return jsonb_build_object('release_id', r.id, 'status', r.status, 'ready', coalesce(array_length(blockers, 1), 0) = 0,
                            'blockers', to_jsonb(blockers), 'requirements', reqs);
end;
$$;
grant execute on function public.release_readiness(uuid) to authenticated;

create or replace function private.govern_release()
returns trigger language plpgsql security invoker set search_path = ''
as $$
declare actor uuid := (select auth.uid()); s jsonb;
begin
  if actor is null then return new; end if;
  if tg_op = 'INSERT' and new.status not in ('planned','building') then
    raise exception 'A release starts as planned or building.' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status in ('released','rolled_back') and not private.is_project_owner(new.project_id) then
      raise exception 'Only project owners can release or roll back a version.' using errcode = '42501';
    end if;
    if new.status in ('ready','released') then
      s := public.release_readiness(new.id);
      if not (s->>'ready')::boolean then
        raise exception 'Release is not ready: %', array_to_string(array(select jsonb_array_elements_text(s->'blockers')), '; ') using errcode = '23514';
      end if;
    end if;
    if new.status = 'released' then
      if coalesce(trim(new.commit_sha), '') = '' then
        raise exception 'Record the commit SHA before marking a release as released.' using errcode = '23514';
      end if;
      new.released_at := now();
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists govern_release on public.releases;
create trigger govern_release before insert or update on public.releases
  for each row execute procedure private.govern_release();

-- =============================================================================================
-- 7. Audit + realtime for the new tables.
-- =============================================================================================
drop trigger if exists audit_project_links on public.project_links;
create trigger audit_project_links after insert or delete on public.project_links
  for each row execute procedure private.capture_activity();
drop trigger if exists audit_release_requirements on public.release_requirements;
create trigger audit_release_requirements after insert or delete on public.release_requirements
  for each row execute procedure private.capture_activity();

do $$
declare t text;
begin
  foreach t in array array['milestones','workstreams','requirements','documents','decisions','issues','releases','release_requirements','project_links','task_reviews','test_runs','test_cases','task_dependencies'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object or undefined_object then null;
    end;
  end loop;
end $$;

notify pgrst, 'reload schema';
