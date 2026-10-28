-- CONTINUUM Engineering OS, milestone 1: evidence-gated completion and traceability.
--
-- Goal: a task is not "done" because someone clicked a button. It is done when required tests
-- have passed, a human reviewer approved the result after those tests ran, and the project can show
-- the trail from requirement -> task -> tests -> review -> completion.

-- ---------------------------------------------------------------------------------------------
-- 1. Traceability + completion columns
-- ---------------------------------------------------------------------------------------------
alter table public.tasks
  add column if not exists requirement_id uuid references public.requirements(id) on delete set null,
  add column if not exists requires_evidence boolean not null default true,
  add column if not exists completion_waiver text check (completion_waiver is null or length(trim(completion_waiver)) between 5 and 1000),
  add column if not exists completed_at timestamptz,
  add column if not exists completed_by uuid references auth.users(id) on delete set null;

create index if not exists tasks_requirement_idx on public.tasks(requirement_id);
create index if not exists test_runs_task_created_idx on public.test_runs(task_id, created_at desc);
create index if not exists test_runs_case_created_idx on public.test_runs(test_case_id, created_at desc);
create index if not exists test_cases_requirement_idx on public.test_cases(requirement_id);
create index if not exists test_cases_task_idx on public.test_cases(task_id);

-- Tasks that were already "done" before this migration keep working: they were completed without evidence.
update public.tasks set requires_evidence = false, completed_at = coalesce(completed_at, updated_at) where status = 'done';

-- ---------------------------------------------------------------------------------------------
-- 2. Review decisions (immutable evidence)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.task_reviews (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  reviewer_id uuid not null default auth.uid() references auth.users(id),
  reviewer_type public.actor_kind not null default 'human',
  decision text not null check (decision in ('approved','changes_requested')),
  notes text check (notes is null or length(notes) <= 8000),
  commit_sha text check (commit_sha is null or length(commit_sha) <= 64),
  created_at timestamptz not null default now()
);
create index if not exists task_reviews_task_created_idx on public.task_reviews(task_id, created_at desc);
alter table public.task_reviews enable row level security;

create policy "Members read task reviews" on public.task_reviews for select to authenticated
  using (private.is_project_member(project_id));
-- Reviews are recorded as yourself, as a human. Agents may *comment* in agent_messages but cannot approve work.
create policy "Members record own human reviews" on public.task_reviews for insert to authenticated
  with check (private.is_project_member(project_id) and reviewer_id = (select auth.uid()) and reviewer_type = 'human');
grant select, insert on public.task_reviews to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Cross-project integrity: evidence must point at rows of the SAME project.
--    Without this, a member of project A could attach passing runs to a task in project B.
-- ---------------------------------------------------------------------------------------------
create or replace function private.enforce_evidence_project()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.task_id is not null
     and not exists (select 1 from public.tasks t where t.id = new.task_id and t.project_id = new.project_id) then
    raise exception 'task % does not belong to project %', new.task_id, new.project_id using errcode = '23514';
  end if;
  -- to_jsonb keeps this trigger usable on tables (task_reviews) that have no test_case_id column.
  if nullif(to_jsonb(new)->>'test_case_id', '') is not null
     and not exists (select 1 from public.test_cases c
                     where c.id = (to_jsonb(new)->>'test_case_id')::uuid and c.project_id = new.project_id) then
    raise exception 'test case % does not belong to project %', to_jsonb(new)->>'test_case_id', new.project_id using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_test_run_project on public.test_runs;
create trigger enforce_test_run_project before insert on public.test_runs
  for each row execute procedure private.enforce_evidence_project();
drop trigger if exists enforce_task_review_project on public.task_reviews;
create trigger enforce_task_review_project before insert on public.task_reviews
  for each row execute procedure private.enforce_evidence_project();

create or replace function private.enforce_task_links()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.requirement_id is not null
     and not exists (select 1 from public.requirements r where r.id = new.requirement_id and r.project_id = new.project_id) then
    raise exception 'requirement % does not belong to project %', new.requirement_id, new.project_id using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists enforce_task_links on public.tasks;
create trigger enforce_task_links before insert or update of requirement_id, project_id on public.tasks
  for each row execute procedure private.enforce_task_links();

-- ---------------------------------------------------------------------------------------------
-- 4. Test runs are recorded as yourself. 'system'/'agent' evidence will come from a leased worker path later,
--    so members can no longer claim to be automation or to be someone else.
-- ---------------------------------------------------------------------------------------------
drop policy if exists "Members record test runs" on public.test_runs;
create policy "Members record own test runs" on public.test_runs for insert to authenticated
  with check (private.is_project_member(project_id) and executed_by = (select auth.uid()) and actor_type = 'human');

-- ---------------------------------------------------------------------------------------------
-- 5. Completion status: one function used by the database gate, the dashboard, the IDE panel and agents.
--    SECURITY INVOKER, so row-level security still applies to whoever asks.
-- ---------------------------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------------------------
-- 6. The gate itself
-- ---------------------------------------------------------------------------------------------
create or replace function private.enforce_task_completion()
returns trigger language plpgsql security invoker set search_path = ''
as $$
declare
  status_json jsonb;
  actor uuid := (select auth.uid());
begin
  -- Only owners can switch evidence off or grant a waiver. Direct SQL/service-role maintenance (no JWT user) is exempt.
  if actor is not null then
    if tg_op = 'UPDATE' and (new.requires_evidence is distinct from old.requires_evidence
        or new.completion_waiver is distinct from old.completion_waiver)
       and not private.is_project_owner(new.project_id) then
      raise exception 'Only project owners can change evidence requirements or waive them.' using errcode = '42501';
    end if;
    if tg_op = 'INSERT' and (new.requires_evidence is false or new.completion_waiver is not null)
       and not private.is_project_owner(new.project_id) then
      raise exception 'Only project owners can create tasks that skip evidence.' using errcode = '42501';
    end if;
  end if;

  if new.status = 'done' and (tg_op = 'INSERT' or old.status is distinct from 'done') then
    if actor is not null and new.requires_evidence then
      if new.completion_waiver is not null then
        if not private.is_project_owner(new.project_id) then
          raise exception 'Only project owners can complete a task with a waiver.' using errcode = '42501';
        end if;
      elsif tg_op = 'INSERT' then
        raise exception 'A new task cannot start as done: it has no evidence.' using errcode = '23514';
      else
        status_json := public.task_completion_status(new.id);
        if status_json is null or not (status_json->>'ready')::boolean then
          raise exception 'Task cannot be completed: %',
            coalesce(array_to_string(array(select jsonb_array_elements_text(status_json->'blockers')), '; '), 'no evidence')
            using errcode = '23514';
        end if;
      end if;
    end if;
    new.completed_at := now();
    new.completed_by := actor;
  elsif tg_op = 'UPDATE' and old.status = 'done' and new.status is distinct from 'done' then
    -- Reopened work loses its completion stamp and any waiver; it must earn completion again.
    new.completed_at := null;
    new.completed_by := null;
    if new.completion_waiver is not distinct from old.completion_waiver then new.completion_waiver := null; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists enforce_task_completion on public.tasks;
create trigger enforce_task_completion before insert or update on public.tasks
  for each row execute procedure private.enforce_task_completion();

-- ---------------------------------------------------------------------------------------------
-- 7. A requirement is "verified" only when its tasks are done and its required tests pass.
-- ---------------------------------------------------------------------------------------------
create or replace function public.requirement_verification_status(p_requirement_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = ''
as $$
declare
  r public.requirements%rowtype;
  blockers text[] := '{}';
  task_total int; task_open int; case_total int; case_bad int;
begin
  select * into r from public.requirements where id = p_requirement_id;
  if not found then return null; end if;
  select count(*), count(*) filter (where status <> 'done') into task_total, task_open
    from public.tasks where requirement_id = r.id and project_id = r.project_id;
  if task_total = 0 then blockers := blockers || 'no task implements this requirement'::text;
  elsif task_open > 0 then blockers := blockers || (task_open::text || ' linked task(s) are not done'); end if;

  select count(*), count(*) filter (where coalesce((
      select tr.result from public.test_runs tr where tr.test_case_id = c.id and tr.project_id = r.project_id
      order by tr.created_at desc, tr.id desc limit 1), 'not_run') <> 'passed')
    into case_total, case_bad
    from public.test_cases c where c.requirement_id = r.id and c.project_id = r.project_id and c.is_required;
  if case_total = 0 then blockers := blockers || 'no required test case verifies this requirement'::text;
  elsif case_bad > 0 then blockers := blockers || (case_bad::text || ' required test case(s) have not passed'); end if;

  return jsonb_build_object('requirement_id', r.id, 'ready', coalesce(array_length(blockers, 1), 0) = 0,
                            'blockers', to_jsonb(blockers), 'tasks', task_total, 'required_cases', case_total);
end;
$$;
grant execute on function public.requirement_verification_status(uuid) to authenticated;

create or replace function private.enforce_requirement_verification()
returns trigger language plpgsql security invoker set search_path = ''
as $$
declare s jsonb;
begin
  if new.status = 'verified' and (tg_op = 'INSERT' or old.status is distinct from 'verified')
     and (select auth.uid()) is not null then
    if tg_op = 'INSERT' then
      raise exception 'A new requirement cannot start as verified.' using errcode = '23514';
    end if;
    s := public.requirement_verification_status(new.id);
    if not (s->>'ready')::boolean then
      raise exception 'Requirement cannot be verified: %',
        array_to_string(array(select jsonb_array_elements_text(s->'blockers')), '; ') using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists enforce_requirement_verification on public.requirements;
create trigger enforce_requirement_verification before insert or update of status on public.requirements
  for each row execute procedure private.enforce_requirement_verification();

-- ---------------------------------------------------------------------------------------------
-- 8. Command-center summary: evidence-based progress instead of "% of tasks clicked done".
-- ---------------------------------------------------------------------------------------------
create or replace function public.project_health(p_project_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  with m as (select private.is_project_member(p_project_id) as ok),
  t as (select status, requires_evidence, completion_waiver from public.tasks where project_id = p_project_id),
  c as (
    select c.id, coalesce((select tr.result from public.test_runs tr where tr.test_case_id = c.id and tr.project_id = p_project_id
                           order by tr.created_at desc, tr.id desc limit 1), 'not_run') as result
    from public.test_cases c where c.project_id = p_project_id and c.is_required
  )
  select case when not (select ok from m) then null else jsonb_build_object(
    'project_id', p_project_id,
    'tasks', jsonb_build_object(
      'total', (select count(*) from t),
      'done', (select count(*) from t where status = 'done'),
      'done_with_evidence', (select count(*) from t where status = 'done' and requires_evidence and completion_waiver is null),
      'done_waived', (select count(*) from t where status = 'done' and completion_waiver is not null),
      'done_without_requirement', (select count(*) from t where status = 'done' and not requires_evidence and completion_waiver is null),
      'blocked', (select count(*) from t where status = 'blocked'),
      'in_review', (select count(*) from t where status = 'in_review')),
    'requirements', jsonb_build_object(
      'total', (select count(*) from public.requirements where project_id = p_project_id),
      'verified', (select count(*) from public.requirements where project_id = p_project_id and status = 'verified')),
    'required_tests', jsonb_build_object(
      'total', (select count(*) from c),
      'passing', (select count(*) from c where result = 'passed'),
      'failing', (select count(*) from c where result in ('failed','error')),
      'not_run', (select count(*) from c where result in ('not_run','skipped'))))
  end;
$$;
grant execute on function public.project_health(uuid) to authenticated;

create or replace function public.project_task_completion(p_project_id uuid)
returns setof jsonb language sql stable security invoker set search_path = ''
as $$
  select public.task_completion_status(t.id)
  from public.tasks t
  where t.project_id = p_project_id and t.status <> 'done'
  order by t.updated_at desc
  limit 200;
$$;
grant execute on function public.project_task_completion(uuid) to authenticated;

drop trigger if exists audit_task_reviews on public.task_reviews;
create trigger audit_task_reviews after insert on public.task_reviews
  for each row execute procedure private.capture_activity();

notify pgrst, 'reload schema';
