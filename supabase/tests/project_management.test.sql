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


-- ---------- fixtures: two projects, owner Dana, collaborator Raj, outsider Zed ----------
insert into auth.users (id, email) values
  ('0000000d-0000-0000-0000-00000000000d', 'dana@example.com'),
  ('0000000e-0000-0000-0000-00000000000e', 'raj@example.com'),
  ('0000000f-0000-0000-0000-00000000000f', 'zed@example.com');
select pg_temp.as_user('0000000d-0000-0000-0000-00000000000d');
set role authenticated;
insert into public.projects (id, name, owner_id) values ('d0000000-0000-0000-0000-000000000001', 'Drone Nav', '0000000d-0000-0000-0000-00000000000d');
reset role;
insert into public.project_members (project_id, user_id, role) values ('d0000000-0000-0000-0000-000000000001', '0000000e-0000-0000-0000-00000000000e', 'collaborator');
select pg_temp.as_user('0000000f-0000-0000-0000-00000000000f');
set role authenticated;
insert into public.projects (id, name, owner_id) values ('d0000000-0000-0000-0000-000000000002', 'Zed Project', '0000000f-0000-0000-0000-00000000000f');
insert into public.workstreams (id, project_id, name) values ('d1000000-0000-0000-0000-000000000009', 'd0000000-0000-0000-0000-000000000002', 'Zed stream');
reset role;

-- ---------- Regression: INSERT ... RETURNING on projects (the dashboard's create-project call) ----------
select pg_temp.as_user('0000000f-0000-0000-0000-00000000000f');
set role authenticated;
do $$ declare new_id uuid; begin
  insert into public.projects (name, owner_id) values ('Returning works', '0000000f-0000-0000-0000-00000000000f') returning id into new_id;
  if new_id is null then raise exception 'TEST FAILED [create project returning]'; end if;
end $$;
reset role;

-- ---------- Plan: structure and integrity ----------
select pg_temp.as_user('0000000d-0000-0000-0000-00000000000d');
set role authenticated;
insert into public.workstreams (id, project_id, name) values ('d1000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'Perception');
insert into public.milestones (id, project_id, title, due_date) values ('d2000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'Alpha flight', current_date + 30);
insert into public.tasks (id, project_id, title, workstream_id, milestone_id, assigned_to, status) values
  ('d3000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'Build map', 'd1000000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000001', '0000000e-0000-0000-0000-00000000000e', 'in_progress'),
  ('d3000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001', 'Plan route', null, 'd2000000-0000-0000-0000-000000000001', null, 'todo'),
  ('d3000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000001', 'Subtask: calibrate', null, null, null, 'todo');

select pg_temp.expect_error($q$insert into public.tasks (project_id,title,workstream_id) values ('d0000000-0000-0000-0000-000000000001','x','d1000000-0000-0000-0000-000000000009')$q$,
  'does not belong to project', 'workstream from another project rejected');
select pg_temp.expect_error($q$update public.tasks set assigned_to='0000000f-0000-0000-0000-00000000000f' where id='d3000000-0000-0000-0000-000000000001'$q$,
  'must be a member', 'non-member cannot be assigned');
select pg_temp.expect_error($q$update public.tasks set parent_task_id=id where id='d3000000-0000-0000-0000-000000000003'$q$,
  'own parent', 'self-parent rejected');
update public.tasks set parent_task_id='d3000000-0000-0000-0000-000000000001' where id='d3000000-0000-0000-0000-000000000003';
select pg_temp.expect_error($q$update public.tasks set parent_task_id='d3000000-0000-0000-0000-000000000003' where id='d3000000-0000-0000-0000-000000000001'$q$,
  'loop in the task hierarchy', 'hierarchy cycle rejected');

insert into public.task_dependencies (task_id, depends_on_task_id) values ('d3000000-0000-0000-0000-000000000001', 'd3000000-0000-0000-0000-000000000002');
select pg_temp.expect_error($q$insert into public.task_dependencies (task_id, depends_on_task_id) values ('d3000000-0000-0000-0000-000000000002', 'd3000000-0000-0000-0000-000000000001')$q$,
  'circular dependency', 'direct dependency cycle rejected');
insert into public.task_dependencies (task_id, depends_on_task_id) values ('d3000000-0000-0000-0000-000000000002', 'd3000000-0000-0000-0000-000000000003');
select pg_temp.expect_error($q$insert into public.task_dependencies (task_id, depends_on_task_id) values ('d3000000-0000-0000-0000-000000000003', 'd3000000-0000-0000-0000-000000000001')$q$,
  'circular dependency', 'transitive dependency cycle rejected');

-- plan summary
select pg_temp.expect_true((public.project_plan('d0000000-0000-0000-0000-000000000001')->'summary'->>'blocked_by_dependency')::int = 2, 'two tasks blocked by open dependencies');
select pg_temp.expect_true((public.project_plan('d0000000-0000-0000-0000-000000000001')->'summary'->>'unassigned')::int = 2, 'unassigned counted');
select pg_temp.expect_true((public.project_plan('d0000000-0000-0000-0000-000000000001')->'milestones'->0->>'total')::int = 2, 'milestone task count');

-- ---------- Plan rules feed the completion gate ----------
-- Give task 1 a passing test and an independent approval, then show the plan still blocks it.
insert into public.test_runs (project_id, task_id, result, executed_by) values ('d0000000-0000-0000-0000-000000000001', 'd3000000-0000-0000-0000-000000000001', 'passed', '0000000d-0000-0000-0000-00000000000d');
insert into public.task_reviews (project_id, task_id, decision) values ('d0000000-0000-0000-0000-000000000001', 'd3000000-0000-0000-0000-000000000001', 'approved');
select pg_temp.expect_error($q$update public.tasks set status='done' where id='d3000000-0000-0000-0000-000000000001'$q$,
  'dependency task(s) are not done', 'open dependency blocks completion');
select pg_temp.expect_true((public.task_completion_status('d3000000-0000-0000-0000-000000000001')->'blockers')::text like '%subtask(s) are not done%', 'open subtask blocks completion');

-- A high-severity defect blocks; resolving it unblocks. Collaborators cannot accept the risk.
insert into public.issues (id, project_id, task_id, title, severity, issue_type) values
  ('d4000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'd3000000-0000-0000-0000-000000000001', 'Map drifts', 'critical', 'bug');
select pg_temp.expect_true((public.task_completion_status('d3000000-0000-0000-0000-000000000001')->'blockers')::text like '%high-severity defect%', 'defect blocks completion');
select pg_temp.as_user('0000000e-0000-0000-0000-00000000000e');
select pg_temp.expect_error($q$update public.issues set status='accepted_risk' where id='d4000000-0000-0000-0000-000000000001'$q$,
  'Only project owners can accept a risk', 'collaborator cannot accept risk');
select pg_temp.expect_error($q$insert into public.issues (project_id,task_id,title,status) values ('d0000000-0000-0000-0000-000000000001', null, 'sneaky', 'accepted_risk')$q$,
  'Only project owners can accept a risk', 'cannot create an issue already accepted');
select pg_temp.as_user('0000000d-0000-0000-0000-00000000000d');
update public.issues set status='resolved' where id='d4000000-0000-0000-0000-000000000001';
select pg_temp.expect_true(not ((public.task_completion_status('d3000000-0000-0000-0000-000000000001')->'blockers')::text like '%defect%'), 'resolved defect no longer blocks');

-- Finish the chain: calibrate -> route -> map (each waived by the owner for brevity)
update public.tasks set status='done', completion_waiver='calibration done offline, owner verified' where id='d3000000-0000-0000-0000-000000000003';
update public.tasks set status='done', completion_waiver='route planning reviewed by owner' where id='d3000000-0000-0000-0000-000000000002';

-- Milestone cannot complete while task 1 is open, then can once it is done
select pg_temp.expect_error($q$update public.milestones set status='completed' where id='d2000000-0000-0000-0000-000000000001'$q$,
  'task(s) are not done', 'milestone blocked while tasks open');
update public.tasks set status='done' where id='d3000000-0000-0000-0000-000000000001';
update public.milestones set status='completed' where id='d2000000-0000-0000-0000-000000000001';

-- ---------- Knowledge: versioned documents ----------
insert into public.documents (id, project_id, title, content_markdown) values ('d5000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'Nav architecture', '# v1');
select pg_temp.expect_true((select version = 1 from public.documents where id='d5000000-0000-0000-0000-000000000001'), 'new document is version 1');
update public.documents set content_markdown='# v2', version=1 where id='d5000000-0000-0000-0000-000000000001';
select pg_temp.expect_true((select version = 2 from public.documents where id='d5000000-0000-0000-0000-000000000001'), 'edit bumps version');
select pg_temp.expect_true((select content_markdown = '# v1' from public.document_versions where document_id='d5000000-0000-0000-0000-000000000001' and version=1), 'previous version archived');
select pg_temp.expect_error($q$update public.documents set content_markdown='# stale write', version=1 where id='d5000000-0000-0000-0000-000000000001'$q$,
  'Version conflict', 'stale edit rejected');
update public.documents set workstream_id='d1000000-0000-0000-0000-000000000001', version=2 where id='d5000000-0000-0000-0000-000000000001';
select pg_temp.expect_true((select version = 2 from public.documents where id='d5000000-0000-0000-0000-000000000001'), 'metadata-only change keeps version');

-- ---------- Decisions: collaborators propose, owners decide, accepted is immutable ----------
select pg_temp.as_user('0000000e-0000-0000-0000-00000000000e');
insert into public.decisions (id, project_id, title, decision) values ('d6000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'Use EKF', 'Use an extended Kalman filter');
select pg_temp.expect_error($q$insert into public.decisions (project_id,title,status) values ('d0000000-0000-0000-0000-000000000001','pre-accepted','accepted')$q$,
  'created as proposed', 'cannot create an accepted decision');
select pg_temp.expect_error($q$update public.decisions set status='accepted' where id='d6000000-0000-0000-0000-000000000001'$q$,
  'Only project owners', 'collaborator cannot accept');
select pg_temp.as_user('0000000d-0000-0000-0000-00000000000d');
update public.decisions set status='accepted' where id='d6000000-0000-0000-0000-000000000001';
select pg_temp.expect_true((select decided_by = '0000000d-0000-0000-0000-00000000000d' from public.decisions where id='d6000000-0000-0000-0000-000000000001'), 'decider recorded');
select pg_temp.expect_error($q$update public.decisions set decision='Use UKF' where id='d6000000-0000-0000-0000-000000000001'$q$,
  'immutable', 'accepted decision cannot be edited');
update public.decisions set status='superseded' where id='d6000000-0000-0000-0000-000000000001';

-- ---------- Link graph ----------
insert into public.project_links (project_id, source_type, source_id, target_type, target_id, relation)
  values ('d0000000-0000-0000-0000-000000000001', 'document', 'd5000000-0000-0000-0000-000000000001', 'task', 'd3000000-0000-0000-0000-000000000001', 'explains');
select pg_temp.expect_error($q$insert into public.project_links (project_id, source_type, source_id, target_type, target_id, relation)
  values ('d0000000-0000-0000-0000-000000000001', 'document', 'd5000000-0000-0000-0000-000000000001', 'task', 'd3000000-0000-0000-0000-000000000001', 'explains')$q$,
  'duplicate key', 'same relation only once');
select pg_temp.expect_error($q$insert into public.project_links (project_id, source_type, source_id, target_type, target_id)
  values ('d0000000-0000-0000-0000-000000000001', 'document', 'd5000000-0000-0000-0000-000000000001', 'task', 'd1000000-0000-0000-0000-000000000009')$q$,
  'does not belong to this project', 'link to a non-existent/foreign target rejected');
select pg_temp.expect_error($q$insert into public.project_links (project_id, source_type, source_id, target_type, target_id)
  values ('d0000000-0000-0000-0000-000000000001', 'bogus', 'd5000000-0000-0000-0000-000000000001', 'task', 'd3000000-0000-0000-0000-000000000001')$q$,
  'Unknown entity type', 'unknown entity type rejected');
delete from public.tasks where id='d3000000-0000-0000-0000-000000000001';
select pg_temp.expect_true(not exists (select 1 from public.project_links where target_id='d3000000-0000-0000-0000-000000000001'), 'deleting an entity removes its links');

-- ---------- Releases ----------
insert into public.requirements (id, project_id, title, status) values ('d7000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'Hold position within 1 m', 'approved');
insert into public.releases (id, project_id, version_label, title) values ('d8000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'v0.1.0', 'First flight');
select pg_temp.expect_error($q$update public.releases set status='ready' where id='d8000000-0000-0000-0000-000000000001'$q$,
  'no requirements are in scope', 'empty scope is not releasable');
insert into public.release_requirements (project_id, release_id, requirement_id) values ('d0000000-0000-0000-0000-000000000001', 'd8000000-0000-0000-0000-000000000001', 'd7000000-0000-0000-0000-000000000001');
select pg_temp.expect_error($q$update public.releases set status='ready' where id='d8000000-0000-0000-0000-000000000001'$q$,
  'not verified', 'unverified requirement blocks release');
-- Verify the requirement properly: task + required test + review
insert into public.tasks (id, project_id, title, requirement_id, status) values ('d3000000-0000-0000-0000-000000000009', 'd0000000-0000-0000-0000-000000000001', 'Position hold', 'd7000000-0000-0000-0000-000000000001', 'in_progress');
insert into public.test_cases (id, project_id, requirement_id, task_id, name) values ('d9000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'd7000000-0000-0000-0000-000000000001', 'd3000000-0000-0000-0000-000000000009', 'hovers in wind');
insert into public.test_runs (project_id, test_case_id, task_id, result, executed_by) values ('d0000000-0000-0000-0000-000000000001', 'd9000000-0000-0000-0000-000000000001', 'd3000000-0000-0000-0000-000000000009', 'passed', '0000000d-0000-0000-0000-00000000000d');
select pg_temp.as_user('0000000e-0000-0000-0000-00000000000e');
insert into public.task_reviews (project_id, task_id, decision) values ('d0000000-0000-0000-0000-000000000001', 'd3000000-0000-0000-0000-000000000009', 'approved');
update public.tasks set status='done' where id='d3000000-0000-0000-0000-000000000009';
update public.requirements set status='verified' where id='d7000000-0000-0000-0000-000000000001';
-- A critical project defect blocks the release even though everything else is green
select pg_temp.as_user('0000000d-0000-0000-0000-00000000000d');
insert into public.issues (id, project_id, title, severity, issue_type) values ('d4000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001', 'Crash on landing', 'critical', 'bug');
select pg_temp.expect_error($q$update public.releases set status='ready' where id='d8000000-0000-0000-0000-000000000001'$q$,
  'high-severity defect', 'critical defect blocks release');
update public.issues set status='resolved' where id='d4000000-0000-0000-0000-000000000002';
update public.releases set status='ready' where id='d8000000-0000-0000-0000-000000000001';
select pg_temp.expect_error($q$update public.releases set status='released' where id='d8000000-0000-0000-0000-000000000001'$q$,
  'commit SHA', 'release needs a commit SHA');
select pg_temp.as_user('0000000e-0000-0000-0000-00000000000e');
select pg_temp.expect_error($q$update public.releases set status='released', commit_sha='abc123' where id='d8000000-0000-0000-0000-000000000001'$q$,
  'Only project owners', 'collaborator cannot release');
select pg_temp.as_user('0000000d-0000-0000-0000-00000000000d');
update public.releases set status='released', commit_sha='abc123' where id='d8000000-0000-0000-0000-000000000001';
select pg_temp.expect_true((select released_at is not null from public.releases where id='d8000000-0000-0000-0000-000000000001'), 'released_at stamped');
select pg_temp.expect_error($q$delete from public.release_requirements where release_id='d8000000-0000-0000-0000-000000000001'$q$,
  'frozen', 'released scope is frozen');

-- ---------- Outsider sees nothing ----------
select pg_temp.as_user('0000000f-0000-0000-0000-00000000000f');
select pg_temp.expect_true(public.project_plan('d0000000-0000-0000-0000-000000000001') is null, 'outsider gets no plan');
select pg_temp.expect_true(public.release_readiness('d8000000-0000-0000-0000-000000000001') is null, 'outsider gets no release readiness');
select pg_temp.expect_true((select count(*) from public.document_versions) = 0, 'outsider cannot read document versions');
select pg_temp.expect_true((select count(*) from public.project_links) = 0, 'outsider cannot read links');

\echo ALL PROJECT MANAGEMENT TESTS PASSED
