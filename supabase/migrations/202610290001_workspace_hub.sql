-- CONTINUUM Engineering OS: workspace hub.
-- One place to find anything (search across every kind of project record) and to see what needs *me* right now.
-- Both are SECURITY INVOKER, so row-level security still decides what each person can see.

-- ---------------------------------------------------------------------------------------------
-- Search across tasks, requirements, documents, decisions, defects, milestones, releases and tests.
-- Plain case-insensitive substring match with LIKE metacharacters escaped (no regex or injection surface).
-- ---------------------------------------------------------------------------------------------
create or replace function public.search_project(p_project_id uuid, p_query text, p_limit integer default 30)
returns jsonb language plpgsql stable security invoker set search_path = ''
as $$
declare
  q text := lower(trim(coalesce(p_query, '')));
  pattern text;
  lim integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  result jsonb;
begin
  if not private.is_project_member(p_project_id) then return null; end if;
  if length(q) < 2 then return '[]'::jsonb; end if;
  pattern := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  with hits as (
    select 'task'::text as type, t.id, t.title as title, t.status::text, t.updated_at,
           case when lower(t.title) like pattern escape '\' then 0 else 1 end as rank,
           left(coalesce(t.description, ''), 140) as snippet
      from public.tasks t where t.project_id = p_project_id
       and (lower(t.title) like pattern escape '\' or lower(coalesce(t.description, '')) like pattern escape '\')
    union all
    select 'requirement', r.id, coalesce(r.key || ' · ', '') || r.title, r.status::text, r.updated_at,
           case when lower(r.title) like pattern escape '\' then 0 else 1 end, left(coalesce(r.description, ''), 140)
      from public.requirements r where r.project_id = p_project_id
       and (lower(r.title) like pattern escape '\' or lower(coalesce(r.key, '')) like pattern escape '\' or lower(coalesce(r.description, '')) like pattern escape '\')
    union all
    select 'document', d.id, d.title, null::text, d.updated_at,
           case when lower(d.title) like pattern escape '\' then 0 else 1 end,
           case when position(q in lower(d.content_markdown)) > 0
                then substr(d.content_markdown, greatest(position(q in lower(d.content_markdown)) - 50, 1), 160)
                else left(d.content_markdown, 140) end
      from public.documents d where d.project_id = p_project_id
       and (lower(d.title) like pattern escape '\' or lower(d.content_markdown) like pattern escape '\')
    union all
    select 'decision', x.id, x.title, x.status::text, x.updated_at,
           case when lower(x.title) like pattern escape '\' then 0 else 1 end, left(coalesce(x.decision, ''), 140)
      from public.decisions x where x.project_id = p_project_id
       and (lower(x.title) like pattern escape '\' or lower(coalesce(x.context, '')) like pattern escape '\'
            or lower(coalesce(x.decision, '')) like pattern escape '\' or lower(coalesce(x.rationale, '')) like pattern escape '\')
    union all
    select 'issue', i.id, i.title, i.status::text, i.updated_at,
           case when lower(i.title) like pattern escape '\' then 0 else 1 end, left(coalesce(i.description, ''), 140)
      from public.issues i where i.project_id = p_project_id
       and (lower(i.title) like pattern escape '\' or lower(coalesce(i.description, '')) like pattern escape '\')
    union all
    select 'milestone', m.id, m.title, m.status::text, m.updated_at, 0, left(coalesce(m.description, ''), 140)
      from public.milestones m where m.project_id = p_project_id
       and (lower(m.title) like pattern escape '\' or lower(coalesce(m.description, '')) like pattern escape '\')
    union all
    select 'release', e.id, e.version_label || ' · ' || e.title, e.status::text, e.updated_at, 0, ''
      from public.releases e where e.project_id = p_project_id
       and (lower(e.title) like pattern escape '\' or lower(e.version_label) like pattern escape '\')
    union all
    select 'test_case', c.id, c.name, null::text, c.updated_at, 0, left(coalesce(c.description, ''), 140)
      from public.test_cases c where c.project_id = p_project_id
       and (lower(c.name) like pattern escape '\' or lower(coalesce(c.description, '')) like pattern escape '\')
  ), ranked as (select * from hits order by rank, updated_at desc limit lim)
  select coalesce(jsonb_agg(jsonb_build_object('type', type, 'id', id, 'title', title, 'status', status,
                                               'snippet', snippet, 'updated_at', updated_at) order by rank, updated_at desc), '[]'::jsonb)
    into result from ranked;
  return result;
end;
$$;
grant execute on function public.search_project(uuid, text, integer) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- "My work": what needs me right now, in one call.
-- ---------------------------------------------------------------------------------------------
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
    -- Work waiting for a reviewer: someone else's open task with a passing test run and no review from me since that run.
    -- (Based on evidence, not on the task's status field, which people do not always keep current.)
    'to_review', coalesce((select jsonb_agg(to_jsonb(x) order by x.updated_at desc) from (
        select t.id, t.title, t.status, t.updated_at
          from public.tasks t
         where t.project_id = p_project_id and t.status <> 'done'
           and t.assigned_to is distinct from me
           and exists (select 1 from public.test_runs r where r.task_id = t.id and r.project_id = p_project_id and r.result = 'passed')
           and not exists (select 1 from public.task_reviews v where v.task_id = t.id and v.reviewer_id = me
                           and v.created_at >= coalesce((select max(r2.created_at) from public.test_runs r2 where r2.task_id = t.id), 'epoch'::timestamptz))
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

notify pgrst, 'reload schema';
