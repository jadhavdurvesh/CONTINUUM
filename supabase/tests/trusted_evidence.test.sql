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


-- ---------- fixtures: owner Ola, collaborator Kim, outsider Max ----------
insert into auth.users (id, email) values
  ('0000001a-0000-0000-0000-00000000001a', 'ola@example.com'),
  ('0000001b-0000-0000-0000-00000000001b', 'kim@example.com'),
  ('0000001c-0000-0000-0000-00000000001c', 'max@example.com');
select pg_temp.as_user('0000001a-0000-0000-0000-00000000001a');
set role authenticated;
insert into public.projects (id, name, owner_id) values ('e0000000-0000-0000-0000-000000000001', 'CI Project', '0000001a-0000-0000-0000-00000000001a');
reset role;
insert into public.project_members (project_id, user_id, role) values ('e0000000-0000-0000-0000-000000000001', '0000001b-0000-0000-0000-00000000001b', 'collaborator');
select pg_temp.as_user('0000001a-0000-0000-0000-00000000001a');
set role authenticated;
insert into public.repositories (project_id, name, provider, remote_url, created_by) values
  ('e0000000-0000-0000-0000-000000000001', 'robot', 'github', 'https://github.com/Acme/Robot-Vision.git', '0000001a-0000-0000-0000-00000000001a');
insert into public.requirements (id, project_id, title) values ('e1000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'Detect');
insert into public.tasks (id, project_id, title, requirement_id, assigned_to) values
  ('e2000001-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'Detector', 'e1000000-0000-0000-0000-000000000001', '0000001b-0000-0000-0000-00000000001b'),
  ('e2000002-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001', 'Docs', null, null);
insert into public.test_cases (id, project_id, requirement_id, task_id, name, ci_check) values
  ('e3000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e2000001-0000-0000-0000-000000000001', 'unit tests in CI', 'unit-tests');

-- ---------- integration secret: write-only, owner-only ----------
select pg_temp.as_user('0000001b-0000-0000-0000-00000000001b');
select pg_temp.expect_error($q$select public.set_integration_secret('e0000000-0000-0000-0000-000000000001','github', repeat('k', 40))$q$, 'Only project owners', 'collaborator cannot set the secret');
select pg_temp.as_user('0000001a-0000-0000-0000-00000000001a');
select pg_temp.expect_error($q$select public.set_integration_secret('e0000000-0000-0000-0000-000000000001','github','short')$q$, 'at least 24', 'short secret rejected');
select public.set_integration_secret('e0000000-0000-0000-0000-000000000001', 'github', 'whsec_' || repeat('a', 40));
select pg_temp.expect_error($q$select * from public.integration_secrets$q$, 'permission denied', 'clients can never read secrets');
select pg_temp.expect_true((public.integration_status('e0000000-0000-0000-0000-000000000001')->'github'->>'configured')::boolean, 'status reports configured');
select pg_temp.expect_true(position('whsec_' in public.integration_status('e0000000-0000-0000-0000-000000000001')::text) = 0, 'status never leaks the secret');
select pg_temp.as_user('0000001c-0000-0000-0000-00000000001c');
select pg_temp.expect_true(public.integration_status('e0000000-0000-0000-0000-000000000001') is null, 'outsider gets no integration status');

-- ---------- repository name matching ----------
select pg_temp.expect_true(private.github_full_name('https://github.com/Acme/Robot-Vision.git') = 'acme/robot-vision', 'https .git');
select pg_temp.expect_true(private.github_full_name('git@github.com:Acme/Robot-Vision') = 'acme/robot-vision', 'scp-style ssh');
select pg_temp.expect_true(private.github_full_name('ssh://git@github.com/Acme/Robot-Vision.git/') = 'acme/robot-vision', 'ssh url with trailing slash');
select pg_temp.expect_true(private.github_full_name('https://token@github.com/Acme/Robot-Vision') = 'acme/robot-vision', 'credentials stripped');

-- ---------- server-only RPCs ----------
select pg_temp.as_user('0000001a-0000-0000-0000-00000000001a');
select pg_temp.expect_error($q$select public.ci_lookup('github','acme/robot-vision')$q$, 'permission denied', 'members cannot call ci_lookup');
select pg_temp.expect_error($q$select public.record_ci_run('e0000000-0000-0000-0000-000000000001','unit-tests','success','abc','run-1',null,array['e2000001'],now(),now(),'x')$q$, 'permission denied', 'members cannot record CI evidence');
select pg_temp.as_user(null);
set role service_role;
select pg_temp.expect_true((public.ci_lookup('github', 'ACME/Robot-Vision')->>'project_id') = 'e0000000-0000-0000-0000-000000000001', 'lookup is case-insensitive and returns the project');
select pg_temp.expect_true(length(public.ci_lookup('github', 'acme/robot-vision')->>'secret') > 24, 'lookup returns the secret for HMAC verification');
select pg_temp.expect_true(public.ci_lookup('github', 'someone/else') is null, 'unknown repository returns null');

-- successful check for a task with a matching ci_check case -> run recorded against the case
select pg_temp.expect_true((public.record_ci_run('e0000000-0000-0000-0000-000000000001', 'unit-tests', 'success', 'abc123abc123abc123abc123abc123abc123abcd', '9001-1',
  'https://github.com/Acme/Robot-Vision/actions/runs/9001', array['e2000001'], now() - interval '30 seconds', now(), 'CI passed')->>'recorded')::int = 1, 'one run recorded against the case');
reset role;
select pg_temp.expect_true((select count(*) = 1 and bool_and(actor_type = 'system' and executed_by is null and source = 'github-actions' and test_case_id = 'e3000000-0000-0000-0000-000000000001' and result = 'passed')
                              from public.test_runs where external_id like '9001-1%'), 'CI run is system evidence tied to the case');
set role service_role;
select pg_temp.expect_true((public.record_ci_run('e0000000-0000-0000-0000-000000000001', 'unit-tests', 'success', 'abc', '9001-1', null, array['e2000001'], now(), now(), 'redelivery')->>'recorded')::int = 0, 'webhook redelivery is deduplicated');
select pg_temp.expect_true((public.record_ci_run('e0000000-0000-0000-0000-000000000001', 'lint', 'failure', 'abc', '9002-1', null, array['e2000001'], now(), now(), 'lint failed')->>'recorded')::int = 1, 'check without a matching case records a task-level run');
select pg_temp.expect_true((public.record_ci_run('e0000000-0000-0000-0000-000000000001', 'unit-tests', 'cancelled', 'abc', '9003-1', null, array['e2000001'], now(), now(), 'cancelled')->>'result') = 'skipped', 'cancelled maps to skipped');
select pg_temp.expect_true((public.record_ci_run('e0000000-0000-0000-0000-000000000001', 'unit-tests', 'timed_out', 'abc', '9004-1', null, array['e2000001'], now(), now(), 't')->>'result') = 'failed', 'timed_out maps to failed');
select pg_temp.expect_true((public.record_ci_run('e0000000-0000-0000-0000-000000000001', 'unit-tests', 'success', 'abc', '9005-1', null, array['deadbeef','e2000001'], now(), now(), 'x')->>'unresolved_refs')::int = 1, 'unknown task reference is counted, never guessed');
select pg_temp.expect_true((public.record_ci_run('e0000000-0000-0000-0000-000000000001', 'unit-tests', 'success', 'abc', '9006-1', null, array[]::text[], now(), now(), 'no refs')->>'recorded')::int = 1, 'run without task reference is kept as unlinked history');
reset role;
select pg_temp.expect_true((select count(*) = 1 and bool_and(task_id is null and test_case_id is null) from public.test_runs where external_id = '9006-1:unlinked'), 'unlinked run is not attached to any task');

-- members cannot pose as CI
select pg_temp.as_user('0000001b-0000-0000-0000-00000000001b');
set role authenticated;
select pg_temp.expect_error($q$insert into public.test_runs (project_id, task_id, result, executed_by, actor_type, source) values ('e0000000-0000-0000-0000-000000000001','e2000002-0000-0000-0000-000000000002','passed','0000001b-0000-0000-0000-00000000001b','human','github-actions')$q$, 'row-level security', 'cannot claim the github-actions source');
select pg_temp.expect_error($q$insert into public.test_runs (project_id, task_id, result, executed_by, actor_type) values ('e0000000-0000-0000-0000-000000000001','e2000002-0000-0000-0000-000000000002','passed','0000001b-0000-0000-0000-00000000001b','system')$q$, 'row-level security', 'cannot claim actor_type system');
reset role;

-- ---------- ci_only policy ----------
-- Task 2 ("Docs", no cases): a manual pass + approval counts under the default policy.
select pg_temp.as_user('0000001a-0000-0000-0000-00000000001a');
set role authenticated;
insert into public.test_runs (project_id, task_id, result, executed_by) values ('e0000000-0000-0000-0000-000000000001', 'e2000002-0000-0000-0000-000000000002', 'passed', '0000001a-0000-0000-0000-00000000001a');
select pg_temp.as_user('0000001b-0000-0000-0000-00000000001b');
insert into public.task_reviews (project_id, task_id, decision) values ('e0000000-0000-0000-0000-000000000001', 'e2000002-0000-0000-0000-000000000002', 'approved');
select pg_temp.expect_true((public.task_completion_status('e2000002-0000-0000-0000-000000000002')->>'ready')::boolean, 'manual evidence counts under the default policy');
-- A collaborator cannot change the policy
update public.projects set evidence_policy = 'ci_only' where id = 'e0000000-0000-0000-0000-000000000001';
select pg_temp.expect_true((select evidence_policy = 'any' from public.projects where id = 'e0000000-0000-0000-0000-000000000001'), 'collaborator cannot switch the policy');
-- The owner can
select pg_temp.as_user('0000001a-0000-0000-0000-00000000001a');
update public.projects set evidence_policy = 'ci_only' where id = 'e0000000-0000-0000-0000-000000000001';
select pg_temp.expect_true((select evidence_policy = 'ci_only' from public.projects where id = 'e0000000-0000-0000-0000-000000000001'), 'owner switches to ci_only');
select pg_temp.expect_true(((public.task_completion_status('e2000002-0000-0000-0000-000000000002')->>'ready')::boolean) is not true, 'manual evidence no longer counts under ci_only');
select pg_temp.expect_true((public.task_completion_status('e2000002-0000-0000-0000-000000000002')->'blockers')::text like '%no test run%', 'blocker explains the missing trusted evidence');
select pg_temp.expect_true((public.project_health('e0000000-0000-0000-0000-000000000001')->>'evidence_policy') = 'ci_only', 'health reports the policy');
-- Task 1 has a CI pass for its required case (run 9001-1 was later followed by cancelled/timed_out, which are newer): latest decides.
select pg_temp.expect_true(((public.task_completion_status('e2000001-0000-0000-0000-000000000001')->>'ready')::boolean) is not true, 'latest CI run (failed/skipped) blocks completion');
select pg_temp.as_user(null);
set role service_role;
select public.record_ci_run('e0000000-0000-0000-0000-000000000001', 'unit-tests', 'success', 'def', '9100-1', null, array['e2000001'], now(), now(), 'green again');
reset role;
select pg_temp.as_user('0000001a-0000-0000-0000-00000000001a');
set role authenticated;
select pg_temp.expect_true((public.task_completion_status('e2000001-0000-0000-0000-000000000001')->'blockers')::text like '%fresh review%' or (public.task_completion_status('e2000001-0000-0000-0000-000000000001')->'blockers')::text like '%no human review%', 'CI green: only the human review is missing');
insert into public.task_reviews (project_id, task_id, decision) values ('e0000000-0000-0000-0000-000000000001', 'e2000001-0000-0000-0000-000000000001', 'approved');
select pg_temp.expect_true((public.task_completion_status('e2000001-0000-0000-0000-000000000001')->>'ready')::boolean, 'CI evidence + human approval completes the task under ci_only');
update public.tasks set status = 'done' where id = 'e2000001-0000-0000-0000-000000000001';

-- ---------- forged agent proposals ----------
insert into public.agent_sessions (id, project_id, title, goal, current_agent, status, requested_by) values
  ('e4000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'Session one', 'goal goal goal goal', 'coder', 'queued', '0000001a-0000-0000-0000-00000000001a');
insert into public.agent_messages (project_id, session_id, role, actor_type, actor_id, content) values
  ('e0000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000001', 'user', 'human', '0000001a-0000-0000-0000-00000000001a', 'please do it');
select pg_temp.expect_true((select provenance = 'client' from public.agent_messages limit 1), 'client messages default to provenance client');
select pg_temp.expect_error($q$insert into public.agent_messages (project_id, session_id, role, actor_type, actor_id, content, provenance) values
  ('e0000000-0000-0000-0000-000000000001','e4000000-0000-0000-0000-000000000001','assistant','agent','0000001a-0000-0000-0000-00000000001a','{}','server')$q$,
  'row-level security', 'clients cannot mark a message as server-generated');

-- ---------- ambiguity is never guessed ----------
reset role;
select pg_temp.as_user(null);
insert into public.tasks (id, project_id, title, created_by) values ('e2000001-ffff-0000-0000-000000000009', 'e0000000-0000-0000-0000-000000000001', 'Collider', '0000001a-0000-0000-0000-00000000001a');
set role service_role;
select pg_temp.expect_true((public.record_ci_run('e0000000-0000-0000-0000-000000000001', 'unit-tests', 'success', 'abc', '9200-1', null, array['e2000001'], now(), now(), 'ambiguous')->>'unresolved_refs')::int = 1, 'two tasks share the prefix: the reference is refused, not guessed');
reset role;
select pg_temp.expect_true(not exists (select 1 from public.test_runs where external_id like '9200-1%' and task_id is not null), 'ambiguous reference attached to no task');

\echo ALL TRUSTED EVIDENCE TESTS PASSED
