# Product Vision

## Summary

CONTINUUM is a project operating system for a small human team collaborating with AI agents. Coding agents are one type of worker among many.

## Actors

- **Owner:** manages workspace settings, membership, project policies, protected resources, and high-risk approvals.
- **Collaborator:** works within granted capabilities and requests access to protected resources.
- **AI agent:** performs scoped tasks through an approved runtime and tools.
- **Automation:** records CI results, scheduled checks, and system-generated events.

## Modules

### Command center
Project health, evidence-based progress, upcoming milestones, blocked work, failed tests, agent activity, usage, and recent events.

### Work management
Projects, workstreams, requirements, epics, tasks, subtasks, dependencies, milestones, risks, issues, and change requests.

### Engineering traceability
Repositories, branches, commits, pull requests, builds, test cases, test runs, artifacts, defects, releases, and acceptance criteria.

### AI workforce
Agent registry, capabilities, assignment, model routing, retries, checkpoints, handoffs, logs, and usage limits.

### Knowledge
Specifications, architecture, decisions, research, meeting notes, version history, and links to tasks and code.

### Collaboration and governance
Invite-only accounts, roles, permissions, resource locks, permission requests, scoped grants, approvals, and audit history.

### Analytics
Completion, milestone status, blockers, test pass rate, coverage, defects, throughput, agent reliability, latency, and model usage/cost where reliable data is available.

## First end-to-end success criterion

Create a task; execute it with coding agent A in an isolated worktree; persist a checkpoint; simulate a limit or runtime failure; hand off to agent B; verify it inspects and continues the same workspace; run and record tests; show the task, test evidence, actor history, and handoff in the dashboard; verify a protected resource cannot be modified without authorization.
