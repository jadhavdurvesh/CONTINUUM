# Initial Data Model

This is a conceptual starting point, not a finalized migration.

- `profiles`: user profile linked to the authentication provider's user ID.
- `projects`: identity, objective, settings, status, owner.
- `project_members`: membership, role, invitation state, capabilities.
- `workstreams`: major project areas.
- `requirements`: expected behavior and acceptance criteria.
- `milestones`: deliverables, target dates, dependencies, status.
- `tasks`: parent task, dependencies, assignee, status, priority, progress, evidence.
- `documents`: specifications, reports, research, knowledge.
- `decisions`: context, options, rationale, approval status, author.
- `repositories`: repository, default branch, integration settings.
- `agent_definitions`: role, capabilities, runtime adapter, allowed tools, limits.
- `agent_runs`: task/run relationship, actor identity, runtime/model metadata, state.
- `checkpoints`: durable handoff state, workspace/diff reference, next actions.
- `test_cases`: test definition, expected outcome, linked requirements/tasks.
- `test_runs`: commit/build/environment, status, timestamps, logs, artifacts.
- `issues`: defects, risks, blockers, severity, resolution.
- `releases`: version, included changes, acceptance evidence, status.
- `resource_locks`: protected resource, scope, owner, state, reason.
- `permission_requests`: requester, resource, requested action, decision status.
- `permission_grants`: grantor, recipient, action scope, expiry, revocation.
- `approvals`: subject, reviewer, decision, policy, timestamp, evidence.
- `resource_versions`: version and diff references.
- `activity_events`: append-only audit events for human, agent, and system actions.

## Common rules

- Project-owned records include `project_id`.
- Actor IDs distinguish human users, agents, and system automations.
- Agent actions link to an `agent_run` and record which person or approved workflow authorized it.
- Use foreign keys and explicit status constraints where practical.
- Use transactions for state transitions and lock enforcement.
- Test status stays separate from task completion and release readiness.
- Store large logs/artifacts outside relational rows when appropriate and retain secure references.
- Never use a single giant JSON blob as the source of truth for an entire project.
