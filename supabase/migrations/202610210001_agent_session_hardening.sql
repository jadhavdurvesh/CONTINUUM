-- Hardening for agent sessions.
-- 1. A member could previously UPDATE an agent session and move it to another project they belong to,
--    or reassign who requested it. Those columns become immutable.
-- 2. Claimed sessions must be claimed by the caller, not impersonate another member.

create or replace function private.protect_agent_session_identity()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.project_id is distinct from old.project_id then
    raise exception 'agent_sessions.project_id is immutable' using errcode = '42501';
  end if;
  if new.requested_by is distinct from old.requested_by then
    raise exception 'agent_sessions.requested_by is immutable' using errcode = '42501';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'agent_sessions.created_at is immutable' using errcode = '42501';
  end if;
  if new.claimed_by is not null and new.claimed_by is distinct from old.claimed_by
     and new.claimed_by is distinct from (select auth.uid()) then
    raise exception 'A session can only be claimed by the signed-in user' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_agent_session_identity on public.agent_sessions;
create trigger protect_agent_session_identity
before update on public.agent_sessions
for each row execute procedure private.protect_agent_session_identity();

-- Speeds up the "abandoned running session" recovery check and the per-session history query.
create index if not exists agent_sessions_running_idx
  on public.agent_sessions(started_at) where status = 'running';

notify pgrst, 'reload schema';
