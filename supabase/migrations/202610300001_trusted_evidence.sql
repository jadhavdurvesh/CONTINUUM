-- CONTINUUM Engineering OS, milestone 3: trusted evidence.
-- Manual test results rely on the recorder's honesty. This migration adds evidence that people cannot type in:
--   * CI results (GitHub Actions) recorded by the server as actor_type = 'system';
--   * a per-project policy, "ci_only", under which only that trusted evidence counts toward completion;
--   * agent proposals marked as server-generated, so a teammate cannot plant a proposal for you to apply.

-- 1. Evidence policy and provenance columns
alter table public.projects
  add column if not exists evidence_policy text not null default 'any' check (evidence_policy in ('any', 'ci_only'));

alter table public.test_runs
  add column if not exists source text not null default 'manual' check (source in ('manual', 'local-worker', 'github-actions')),
  add column if not exists external_id text check (external_id is null or length(external_id) <= 200),
  add column if not exists url text check (url is null or length(url) <= 500);
create unique index if not exists test_runs_external_idx on public.test_runs(project_id, source, external_id) where external_id is not null;

alter table public.test_cases
  add column if not exists ci_check text check (ci_check is null or length(ci_check) between 1 and 100);
create index if not exists test_cases_ci_check_idx on public.test_cases(project_id, ci_check) where ci_check is not null;

-- Members can still record their own manual / local-worker results, but can no longer claim to be CI.
drop policy if exists "Members record own test runs" on public.test_runs;
create policy "Members record own test runs" on public.test_runs for insert to authenticated
  with check (private.is_project_member(project_id) and executed_by = (select auth.uid()) and actor_type = 'human'
              and source in ('manual', 'local-worker'));

-- Agent proposals: only the server may mark a message as server-generated.
alter table public.agent_messages
  add column if not exists provenance text not null default 'client' check (provenance in ('client', 'server'));
drop policy if exists "Project members append agent messages" on public.agent_messages;
create policy "Project members append agent messages" on public.agent_messages for insert to authenticated
  with check (private.is_project_member(project_id) and actor_id = (select auth.uid()) and provenance = 'client'
              and exists (select 1 from public.agent_sessions s where s.id = agent_messages.session_id and s.project_id = agent_messages.project_id));

-- 2. Which runs count: everything, or only trusted (system) runs when the project says ci_only.
create or replace function private.counted_runs(p_project_id uuid)
returns setof public.test_runs language sql stable security invoker set search_path = ''
as $$
  select r.* from public.test_runs r
  where r.project_id = p_project_id
    and (r.actor_type = 'system' or (select p.evidence_policy from public.projects p where p.id = p_project_id) = 'any');
$$;

-- The functions below were defined in earlier migrations; they now read runs through counted_runs().
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
           (select tr.result from private.counted_runs(t.project_id) tr where tr.test_case_id = r.id and tr.project_id = t.project_id
              order by tr.created_at desc, tr.id desc limit 1) as result,
           (select tr.created_at from private.counted_runs(t.project_id) tr where tr.test_case_id = r.id and tr.project_id = t.project_id
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
      from private.counted_runs(t.project_id) tr where tr.task_id = t.id and tr.project_id = t.project_id
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
      select tr.result from private.counted_runs(r.project_id) tr where tr.test_case_id = c.id and tr.project_id = r.project_id
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

create or replace function public.project_health(p_project_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  with m as (select private.is_project_member(p_project_id) as ok),
  t as (select status, requires_evidence, completion_waiver from public.tasks where project_id = p_project_id),
  c as (
    select c.id, coalesce((select tr.result from private.counted_runs(p_project_id) tr where tr.test_case_id = c.id and tr.project_id = p_project_id
                           order by tr.created_at desc, tr.id desc limit 1), 'not_run') as result
    from public.test_cases c where c.project_id = p_project_id and c.is_required
  )
  select case when not (select ok from m) then null else jsonb_build_object(
    'project_id', p_project_id,
    'evidence_policy', (select evidence_policy from public.projects where id = p_project_id),
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

create or replace function public.my_work(p_project_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = ''
as $$
declare me uuid := (select auth.uid());
begin
  if me is null or not private.is_project_member(p_project_id) then return null; end if;
  return jsonb_build_object(
    'assigned', coalesce((select jsonb_agg(to_jsonb(x) order by x.due_date nulls last, x.updated_at desc) from (
        select t.id, t.title, t.status, t.priority, t.due_date, t.updated_at,
               (t.due_date is not null and t.due_date < current_date) as overdue,
               exists (select 1 from public.task_dependencies d join public.tasks dt on dt.id = d.depends_on_task_id
                       where d.task_id = t.id and dt.status <> 'done') as waiting_on_dependency
          from public.tasks t
         where t.project_id = p_project_id and t.assigned_to = me and t.status <> 'done'
         order by t.due_date nulls last, t.updated_at desc limit 50) x), '[]'::jsonb),
    -- Work waiting for a reviewer: someone else's open task whose latest test run passed and that I have not reviewed since that run.
    -- (Based on evidence, not on the task's status field, which people do not always keep current.)
    'to_review', coalesce((select jsonb_agg(to_jsonb(x) order by x.updated_at desc) from (
        select t.id, t.title, t.status, t.updated_at
          from public.tasks t
         where t.project_id = p_project_id and t.status <> 'done'
           and t.assigned_to is distinct from me
           and (select r.result from private.counted_runs(p_project_id) r where r.task_id = t.id and r.project_id = p_project_id order by r.created_at desc, r.id desc limit 1) = 'passed'
           and not exists (select 1 from public.task_reviews v where v.task_id = t.id and v.reviewer_id = me
                           and v.created_at >= coalesce((select max(r2.created_at) from private.counted_runs(p_project_id) r2 where r2.task_id = t.id), 'epoch'::timestamptz))
         order by t.updated_at desc limit 50) x), '[]'::jsonb),
    'defects', coalesce((select jsonb_agg(to_jsonb(x) order by x.severity_rank, x.created_at desc) from (
        select i.id, i.title, i.severity, i.issue_type, i.status, i.created_at,
               case i.severity when 'critical' then 0 when 'high' then 1 when 'normal' then 2 else 3 end as severity_rank
          from public.issues i
         where i.project_id = p_project_id and i.assigned_to = me and i.status in ('open', 'in_progress')
         order by severity_rank, i.created_at desc limit 50) x), '[]'::jsonb),
    'decisions_to_decide', case when private.is_project_owner(p_project_id) then coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from (
        select d.id, d.title, d.created_at from public.decisions d
         where d.project_id = p_project_id and d.status = 'proposed' order by d.created_at limit 50) x), '[]'::jsonb) else '[]'::jsonb end,
    'counts', jsonb_build_object(
        'overdue', (select count(*) from public.tasks t where t.project_id = p_project_id and t.assigned_to = me and t.status <> 'done' and t.due_date < current_date)));
end;
$$;
grant execute on function public.my_work(uuid) to authenticated;

-- 3. Integration secrets (write-only for owners) and the server-only RPCs used by the CI webhook.
create table if not exists public.integration_secrets (
  project_id uuid not null references public.projects(id) on delete cascade,
  provider text not null check (provider in ('github')),
  secret text not null check (length(secret) >= 24),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (project_id, provider)
);
alter table public.integration_secrets enable row level security;   -- no policies: clients can never read or write it directly
revoke all on public.integration_secrets from anon, authenticated;

create or replace function public.set_integration_secret(p_project_id uuid, p_provider text, p_secret text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not private.is_project_owner(p_project_id) then
    raise exception 'Only project owners can configure integrations.' using errcode = '42501';
  end if;
  if length(coalesce(p_secret, '')) < 24 then raise exception 'The secret must be at least 24 characters.' using errcode = '22023'; end if;
  insert into public.integration_secrets (project_id, provider, secret, updated_by, updated_at)
  values (p_project_id, p_provider, p_secret, (select auth.uid()), now())
  on conflict (project_id, provider) do update set secret = excluded.secret, updated_by = excluded.updated_by, updated_at = now();
end;
$$;
revoke all on function public.set_integration_secret(uuid, text, text) from public, anon;
grant execute on function public.set_integration_secret(uuid, text, text) to authenticated;

create or replace function public.integration_status(p_project_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select case when not private.is_project_member(p_project_id) then null else jsonb_build_object(
    'github', (select jsonb_build_object('configured', true, 'updated_at', s.updated_at)
                 from public.integration_secrets s where s.project_id = p_project_id and s.provider = 'github'),
    'repositories', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'remote_url', r.remote_url) order by r.name)
                               from public.repositories r where r.project_id = p_project_id), '[]'::jsonb)) end;
$$;
revoke all on function public.integration_status(uuid) from public, anon;
grant execute on function public.integration_status(uuid) to authenticated;

-- "owner/repo" (lower-case) from https://github.com/Owner/Repo.git, git@github.com:Owner/Repo or ssh://git@github.com/Owner/Repo
create or replace function private.github_full_name(p_remote text)
returns text language sql immutable set search_path = ''
as $$
  select lower(regexp_replace(regexp_replace(trim(coalesce(p_remote, '')), '^(https?://([^/@]+@)?|git@|ssh://git@)github\.com[:/]', ''), '(\.git)?/?$', ''));
$$;

-- Server-only: find the project (and its webhook secret) for a repository named in a webhook payload.
create or replace function public.ci_lookup(p_provider text, p_repo text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare hit record;
begin
  select r.project_id, s.secret into hit
    from public.repositories r join public.integration_secrets s on s.project_id = r.project_id and s.provider = p_provider
   where r.provider = 'github' and private.github_full_name(r.remote_url) = lower(trim(p_repo))
   order by r.created_at limit 1;
  if hit.project_id is null then return null; end if;
  return jsonb_build_object('project_id', hit.project_id, 'secret', hit.secret);
end;
$$;
revoke all on function public.ci_lookup(text, text) from public, anon, authenticated;
grant execute on function public.ci_lookup(text, text) to service_role;

-- Server-only: record one finished CI check as trusted evidence.
create or replace function public.record_ci_run(
  p_project_id uuid, p_check_name text, p_conclusion text, p_commit_sha text, p_external_id text,
  p_url text, p_refs text[], p_started_at timestamptz, p_finished_at timestamptz, p_summary text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  result text;
  ref text; matches uuid[]; task_row public.tasks%rowtype;
  recorded int := 0; skipped int := 0; linked uuid[] := '{}';
  case_row record; had_case boolean; inserted int;
  started timestamptz := coalesce(p_started_at, now()); finished timestamptz := coalesce(p_finished_at, now());
  duration int := greatest(0, (extract(epoch from (finished - started)) * 1000)::int);
begin
  if not exists (select 1 from public.projects where id = p_project_id) then raise exception 'Unknown project.' using errcode = '23503'; end if;
  result := case lower(coalesce(p_conclusion, ''))
    when 'success' then 'passed' when 'failure' then 'failed' when 'timed_out' then 'failed'
    when 'cancelled' then 'skipped' when 'skipped' then 'skipped' when 'neutral' then 'skipped' else 'error' end;

  for ref in select distinct lower(x) from unnest(coalesce(p_refs, '{}')) x where x ~* '^[0-9a-f]{8}$' loop
    select array_agg(t.id) into matches from public.tasks t where t.project_id = p_project_id and t.id::text like ref || '%';
    if matches is null or array_length(matches, 1) <> 1 then skipped := skipped + 1; continue; end if;   -- unknown or ambiguous: never guess
    select * into task_row from public.tasks where id = matches[1];
    linked := linked || task_row.id; had_case := false;
    for case_row in select c.id from public.test_cases c
        where c.project_id = p_project_id and c.ci_check = p_check_name
          and (c.task_id = task_row.id or (c.task_id is null and task_row.requirement_id is not null and c.requirement_id = task_row.requirement_id)) loop
      had_case := true;
      insert into public.test_runs (project_id, test_case_id, task_id, commit_sha, environment, result, duration_ms, summary, executed_by, actor_type,
                                    started_at, finished_at, source, external_id, url)
      values (p_project_id, case_row.id, task_row.id, left(p_commit_sha, 64), 'github-actions', result, duration, left(p_summary, 500), null, 'system',
              started, finished, 'github-actions', left(p_external_id, 150) || ':' || case_row.id::text, left(p_url, 500))
      on conflict (project_id, source, external_id) where external_id is not null do nothing;
      get diagnostics inserted = row_count; recorded := recorded + inserted;
    end loop;
    if not had_case then
      insert into public.test_runs (project_id, task_id, commit_sha, environment, result, duration_ms, summary, executed_by, actor_type,
                                    started_at, finished_at, source, external_id, url)
      values (p_project_id, task_row.id, left(p_commit_sha, 64), 'github-actions', result, duration, left(p_summary, 500), null, 'system',
              started, finished, 'github-actions', left(p_external_id, 150) || ':' || task_row.id::text, left(p_url, 500))
      on conflict (project_id, source, external_id) where external_id is not null do nothing;
      get diagnostics inserted = row_count; recorded := recorded + inserted;
    end if;
  end loop;

  if array_length(linked, 1) is null then   -- no task reference: keep it as visible, non-gating history
    insert into public.test_runs (project_id, commit_sha, environment, result, duration_ms, summary, executed_by, actor_type, started_at, finished_at, source, external_id, url)
    values (p_project_id, left(p_commit_sha, 64), 'github-actions', result, duration, left(p_summary, 500), null, 'system', started, finished,
            'github-actions', left(p_external_id, 150) || ':unlinked', left(p_url, 500))
    on conflict (project_id, source, external_id) where external_id is not null do nothing;
    get diagnostics inserted = row_count; recorded := recorded + inserted;
  end if;
  return jsonb_build_object('recorded', recorded, 'linked_tasks', to_jsonb(linked), 'unresolved_refs', skipped, 'result', result);
end;
$$;
revoke all on function public.record_ci_run(uuid, text, text, text, text, text, text[], timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function public.record_ci_run(uuid, text, text, text, text, text, text[], timestamptz, timestamptz, text) to service_role;

notify pgrst, 'reload schema';
