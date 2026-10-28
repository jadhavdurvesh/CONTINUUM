-- Run against a database that has all migrations applied (see supabase/tests/run.sh).
-- Each expect_* helper raises if the behaviour is wrong; the script stops at the first failure.
\set ON_ERROR_STOP on
set client_min_messages = warning;

create or replace function pg_temp.as_user(u uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), false);
  perform set_config('request.jwt.claim.role', case when u is null then 'service_role' else 'authenticated' end, false);
end $$;

create or replace function pg_temp.expect_error(q text, pattern text, label text) returns void language plpgsql as $$
begin
  begin
    execute q;
  exception when others then
    if sqlerrm ilike '%' || pattern || '%' then return; end if;
    raise exception 'TEST FAILED [%]: wrong error "%" (wanted "%")', label, sqlerrm, pattern;
  end;
  raise exception 'TEST FAILED [%]: expected an error containing "%", got success', label, pattern;
end $$;

create or replace function pg_temp.expect_true(cond boolean, label text) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'TEST FAILED [%]', label; end if; end $$;

-- ---------- fixtures (as superuser: no JWT) ----------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'olivia@example.com'),
  ('00000000-0000-0000-0000-0000000000b2', 'sam@example.com'),
  ('00000000-0000-0000-0000-0000000000c3', 'eve@example.com');

select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
insert into public.projects (id, name, owner_id) values ('10000000-0000-0000-0000-000000000001', 'Robot Vision', '00000000-0000-0000-0000-0000000000a1');
reset role;
insert into public.project_members (project_id, user_id, role)
  values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b2', 'collaborator');
-- Eve owns a different project
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
set role authenticated;
insert into public.projects (id, name, owner_id) values ('10000000-0000-0000-0000-000000000002', 'Other Project', '00000000-0000-0000-0000-0000000000c3');
reset role;

-- ---------- Olivia (owner) sets up requirement, task, test case ----------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
insert into public.requirements (id, project_id, title) values ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Detect the object');
insert into public.tasks (id, project_id, title, requirement_id, assigned_to, status)
  values ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Implement detector',
          '20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b2', 'in_progress');
insert into public.test_cases (id, project_id, requirement_id, task_id, name)
  values ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
          '30000000-0000-0000-0000-000000000001', 'detects a cup');

-- A new task cannot be born "done"
select pg_temp.expect_error($q$insert into public.tasks (project_id,title,status) values ('10000000-0000-0000-0000-000000000001','sneaky','done')$q$,
  'cannot start as done', 'insert as done blocked');

-- ---------- Sam (collaborator, assignee) tries to cheat ----------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
select pg_temp.expect_error($q$update public.tasks set status='done' where id='30000000-0000-0000-0000-000000000001'$q$,
  'required test case', 'no tests -> cannot complete');
select pg_temp.expect_error($q$update public.tasks set requires_evidence=false where id='30000000-0000-0000-0000-000000000001'$q$,
  'Only project owners', 'collaborator cannot disable evidence');
select pg_temp.expect_error($q$update public.tasks set completion_waiver='trust me, it works', status='done' where id='30000000-0000-0000-0000-000000000001'$q$,
  'Only project owners', 'collaborator cannot self-waive');
select pg_temp.expect_error($q$insert into public.test_runs (project_id,test_case_id,task_id,result,executed_by,actor_type)
  values ('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','passed',null,'human')$q$,
  'row-level security', 'cannot record anonymous test run');
select pg_temp.expect_error($q$insert into public.test_runs (project_id,test_case_id,task_id,result,executed_by,actor_type)
  values ('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','passed','00000000-0000-0000-0000-0000000000b2','system')$q$,
  'row-level security', 'cannot impersonate system automation');
select pg_temp.expect_error($q$insert into public.test_runs (project_id,test_case_id,task_id,result,executed_by,actor_type)
  values ('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','passed','00000000-0000-0000-0000-0000000000c3','human')$q$,
  'row-level security', 'cannot record a run as someone else');

-- Sam records a FAILING run, then a passing one
set role authenticated;
insert into public.test_runs (project_id,test_case_id,task_id,result,executed_by,created_at)
  values ('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','failed','00000000-0000-0000-0000-0000000000b2', now() - interval '2 hour');
select pg_temp.expect_true(((public.task_completion_status('30000000-0000-0000-0000-000000000001'))->>'ready')::boolean = false, 'failing test blocks readiness');
insert into public.test_runs (project_id,test_case_id,task_id,result,executed_by,created_at)
  values ('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','passed','00000000-0000-0000-0000-0000000000b2', now() - interval '1 hour');
-- Tests pass but there is no review yet
select pg_temp.expect_error($q$update public.tasks set status='done' where id='30000000-0000-0000-0000-000000000001'$q$,
  'no human review', 'passing tests alone are not enough');
-- Assignee cannot approve their own work (project has 2 members)
insert into public.task_reviews (project_id,task_id,decision,notes)
  values ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','approved','looks good to me');
select pg_temp.expect_error($q$update public.tasks set status='done' where id='30000000-0000-0000-0000-000000000001'$q$,
  'assignee cannot approve', 'self-approval blocked');
select pg_temp.expect_error($q$insert into public.task_reviews (project_id,task_id,reviewer_id,decision) values
  ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','approved')$q$,
  'row-level security', 'cannot record a review as someone else');
select pg_temp.expect_error($q$insert into public.task_reviews (project_id,task_id,reviewer_type,decision) values
  ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','agent','approved')$q$,
  'row-level security', 'agents cannot approve');

-- ---------- Eve (another project) cannot plant evidence ----------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
select pg_temp.expect_error($q$insert into public.test_runs (project_id,task_id,result,executed_by)
  values ('10000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001','passed','00000000-0000-0000-0000-0000000000c3')$q$,
  'does not belong to project', 'cross-project evidence blocked (task)');
select pg_temp.expect_error($q$insert into public.test_runs (project_id,test_case_id,result,executed_by)
  values ('10000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000001','passed','00000000-0000-0000-0000-0000000000c3')$q$,
  'does not belong to project', 'cross-project evidence blocked (case)');
select pg_temp.expect_error($q$insert into public.task_reviews (project_id,task_id,decision) values
  ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','approved')$q$,
  'row-level security', 'non-member cannot review');
select pg_temp.expect_true(public.task_completion_status('30000000-0000-0000-0000-000000000001') is null, 'non-member sees no status (RLS)');
select pg_temp.expect_true(public.project_health('10000000-0000-0000-0000-000000000001') is null, 'non-member sees no health');
select pg_temp.expect_error($q$insert into public.tasks (project_id,title,requirement_id) values
  ('10000000-0000-0000-0000-000000000002','x','20000000-0000-0000-0000-000000000001')$q$,
  'does not belong to project', 'cannot link a task to another project''s requirement');

-- ---------- Olivia (not the assignee) approves -> task can complete ----------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
insert into public.task_reviews (project_id,task_id,decision,notes)
  values ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','approved','diff reviewed, tests green');
select pg_temp.expect_true(((public.task_completion_status('30000000-0000-0000-0000-000000000001'))->>'ready')::boolean, 'ready after pass + independent approval');

-- Requirement cannot be verified while its task is open
select pg_temp.expect_error($q$update public.requirements set status='verified' where id='20000000-0000-0000-0000-000000000001'$q$,
  'not done', 'requirement blocked while task open');

update public.tasks set status='done' where id='30000000-0000-0000-0000-000000000001';
select pg_temp.expect_true((select completed_at is not null and completed_by='00000000-0000-0000-0000-0000000000a1' from public.tasks where id='30000000-0000-0000-0000-000000000001'), 'completion stamped');

-- Now the requirement can be verified
update public.requirements set status='verified' where id='20000000-0000-0000-0000-000000000001';

-- A newer FAILING run makes the approval stale and blocks a re-completion after reopening
update public.tasks set status='in_progress' where id='30000000-0000-0000-0000-000000000001';
select pg_temp.expect_true((select completed_at is null from public.tasks where id='30000000-0000-0000-0000-000000000001'), 'reopen clears completion stamp');
insert into public.test_runs (project_id,test_case_id,task_id,result,executed_by)
  values ('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','failed','00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect_error($q$update public.tasks set status='done' where id='30000000-0000-0000-0000-000000000001'$q$,
  'have not passed', 'regression blocks completion');
insert into public.test_runs (project_id,test_case_id,task_id,result,executed_by)
  values ('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','passed','00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect_error($q$update public.tasks set status='done' where id='30000000-0000-0000-0000-000000000001'$q$,
  'fresh review', 'old approval is stale after newer tests');

-- Owner waiver works, is recorded, and shows in project health
insert into public.tasks (id, project_id, title, status) values ('30000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','Write README','todo');
update public.tasks set status='done', completion_waiver='Docs only; reviewed in PR' where id='30000000-0000-0000-0000-000000000002';
select pg_temp.expect_true((public.project_health('10000000-0000-0000-0000-000000000001')->'tasks'->>'done_waived')::int = 1, 'waiver visible in health');
select pg_temp.expect_true(exists (select 1 from public.activity_events where entity_type='tasks' and details->'after'->>'completion_waiver' is not null), 'waiver is audited');

-- Evidence rows are immutable for members
update public.test_runs set result='passed';
select pg_temp.expect_true(not exists (select 1 from public.test_runs where result='passed' and created_at > now() - interval '5 seconds' and task_id is null), 'no silent edits');
select pg_temp.expect_true((select count(*) from public.test_runs where result='failed') >= 2, 'failed runs still recorded (update affects 0 rows)');

select pg_temp.expect_true((select count(*) from public.project_task_completion('10000000-0000-0000-0000-000000000001')) >= 1, 'bulk completion status works');
\echo ALL EVIDENCE GATING TESTS PASSED
