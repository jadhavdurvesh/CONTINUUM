\set ON_ERROR_STOP on
set client_min_messages = warning;
create or replace function pg_temp.as_user(u uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), false);
  perform set_config('request.jwt.claim.role', case when u is null then 'service_role' else 'authenticated' end, false);
end $$;
create or replace function pg_temp.expect_true(cond boolean, label text) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'TEST FAILED [%]', label; end if; end $$;

insert into auth.users (id, email) values
  ('0000000a-0000-0000-0000-0000000000a0', 'ana@example.com'), ('0000000b-0000-0000-0000-0000000000b0', 'ben@example.com'), ('0000000c-0000-0000-0000-0000000000c0', 'cy@example.com');
select pg_temp.as_user('0000000a-0000-0000-0000-0000000000a0');
set role authenticated;
insert into public.projects (id, name, owner_id) values ('a0000000-0000-0000-0000-0000000000a1', 'Hub', '0000000a-0000-0000-0000-0000000000a0');
reset role;
insert into public.project_members (project_id, user_id, role) values ('a0000000-0000-0000-0000-0000000000a1', '0000000b-0000-0000-0000-0000000000b0', 'collaborator');
select pg_temp.as_user('0000000c-0000-0000-0000-0000000000c0');
set role authenticated;
insert into public.projects (id, name, owner_id) values ('a0000000-0000-0000-0000-0000000000a2', 'Other', '0000000c-0000-0000-0000-0000000000c0');
insert into public.tasks (id, project_id, title) values ('a3000000-0000-0000-0000-0000000000c9', 'a0000000-0000-0000-0000-0000000000a2', 'Secret kalman plan');
reset role;

select pg_temp.as_user('0000000a-0000-0000-0000-0000000000a0');
set role authenticated;
insert into public.tasks (id, project_id, title, description, assigned_to, due_date) values
  ('a3000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000a1', 'Tune Kalman filter', 'covariance 100% matrix_size', '0000000b-0000-0000-0000-0000000000b0', current_date - 2),
  ('a3000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-0000000000a1', 'Write docs', null, '0000000a-0000-0000-0000-0000000000a0', current_date + 5);
insert into public.documents (project_id, title, content_markdown) values ('a0000000-0000-0000-0000-0000000000a1', 'Nav notes', 'The extended KALMAN filter fuses imu and gps readings at 100 Hz.');
insert into public.decisions (project_id, title, decision) values ('a0000000-0000-0000-0000-0000000000a1', 'Use EKF', 'extended kalman filter');
insert into public.requirements (project_id, title, key) values ('a0000000-0000-0000-0000-0000000000a1', 'Estimate pose', 'REQ-7');
insert into public.issues (project_id, title, severity, issue_type, assigned_to) values ('a0000000-0000-0000-0000-0000000000a1', 'Filter diverges', 'critical', 'bug', '0000000b-0000-0000-0000-0000000000b0');

-- ---------- search ----------
select pg_temp.expect_true(jsonb_array_length(public.search_project('a0000000-0000-0000-0000-0000000000a1', 'kalman')) = 3, 'finds task, document and decision, but not the other project''s task');
select pg_temp.expect_true((public.search_project('a0000000-0000-0000-0000-0000000000a1', 'kalman')->0->>'type') in ('task','decision'), 'title matches rank before body matches');
select pg_temp.expect_true((select bool_or(e->>'snippet' ilike '%KALMAN filter fuses%') from jsonb_array_elements(public.search_project('a0000000-0000-0000-0000-0000000000a1', 'kalman')) e where e->>'type' = 'document'), 'document hit carries a snippet around the match');
select pg_temp.expect_true(jsonb_array_length(public.search_project('a0000000-0000-0000-0000-0000000000a1', 'REQ-7')) = 1, 'requirement key is searchable');
select pg_temp.expect_true(jsonb_array_length(public.search_project('a0000000-0000-0000-0000-0000000000a1', '100%')) = 1, 'percent sign is literal, not a wildcard');
select pg_temp.expect_true(jsonb_array_length(public.search_project('a0000000-0000-0000-0000-0000000000a1', 'matrix_size')) = 1, 'underscore is literal');
select pg_temp.expect_true(jsonb_array_length(public.search_project('a0000000-0000-0000-0000-0000000000a1', 'matrixXsize')) = 0, 'underscore does not match any character');
select pg_temp.expect_true(jsonb_array_length(public.search_project('a0000000-0000-0000-0000-0000000000a1', 'k')) = 0, 'one-character queries return nothing');
select pg_temp.expect_true(jsonb_array_length(public.search_project('a0000000-0000-0000-0000-0000000000a1', '''; drop table tasks; --')) = 0, 'quotes are inert');
select pg_temp.expect_true(jsonb_array_length(public.search_project('a0000000-0000-0000-0000-0000000000a1', 'kalman', 1)) = 1, 'limit respected');

-- ---------- my work ----------
select pg_temp.as_user('0000000b-0000-0000-0000-0000000000b0');
select pg_temp.expect_true(jsonb_array_length(public.my_work('a0000000-0000-0000-0000-0000000000a1')->'assigned') = 1, 'Ben sees only his own task');
select pg_temp.expect_true((public.my_work('a0000000-0000-0000-0000-0000000000a1')->'assigned'->0->>'overdue')::boolean, 'overdue flagged');
select pg_temp.expect_true(jsonb_array_length(public.my_work('a0000000-0000-0000-0000-0000000000a1')->'defects') = 1, 'his critical defect is listed');
select pg_temp.expect_true(jsonb_array_length(public.my_work('a0000000-0000-0000-0000-0000000000a1')->'decisions_to_decide') = 0, 'non-owner has no decisions to decide');
select pg_temp.expect_true((public.my_work('a0000000-0000-0000-0000-0000000000a1')->'counts'->>'overdue')::int = 1, 'overdue count');
-- Ana's task "Write docs" has a passing run -> Ben (not assignee) should be asked to review it, once
select pg_temp.as_user('0000000a-0000-0000-0000-0000000000a0');
insert into public.test_runs (project_id, task_id, result, executed_by) values ('a0000000-0000-0000-0000-0000000000a1', 'a3000000-0000-0000-0000-000000000002', 'passed', '0000000a-0000-0000-0000-0000000000a0');
select pg_temp.as_user('0000000b-0000-0000-0000-0000000000b0');
select pg_temp.expect_true(jsonb_array_length(public.my_work('a0000000-0000-0000-0000-0000000000a1')->'to_review') = 1, 'Ben is asked to review a tested task');
insert into public.task_reviews (project_id, task_id, decision) values ('a0000000-0000-0000-0000-0000000000a1', 'a3000000-0000-0000-0000-000000000002', 'approved');
select pg_temp.expect_true(jsonb_array_length(public.my_work('a0000000-0000-0000-0000-0000000000a1')->'to_review') = 0, 'review request clears once he reviews');
-- Ana is the owner: she sees decisions to decide
select pg_temp.as_user('0000000a-0000-0000-0000-0000000000a0');
select pg_temp.expect_true(jsonb_array_length(public.my_work('a0000000-0000-0000-0000-0000000000a1')->'decisions_to_decide') = 1, 'owner sees proposed decisions');
select pg_temp.expect_true(jsonb_array_length(public.my_work('a0000000-0000-0000-0000-0000000000a1')->'to_review') = 0, 'own tasks are never in her review queue');

-- ---------- outsiders ----------
select pg_temp.as_user('0000000c-0000-0000-0000-0000000000c0');
select pg_temp.expect_true(public.search_project('a0000000-0000-0000-0000-0000000000a1', 'kalman') is null, 'outsider cannot search another project');
select pg_temp.expect_true(public.my_work('a0000000-0000-0000-0000-0000000000a1') is null, 'outsider gets no work hub');
select pg_temp.expect_true(jsonb_array_length(public.search_project('a0000000-0000-0000-0000-0000000000a2', 'kalman')) = 1, 'outsider can search their own project');
\echo ALL WORKSPACE HUB TESTS PASSED
