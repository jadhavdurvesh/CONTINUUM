# CONTINUUM

**AI Project Operating System**  
*One project. Shared knowledge. Continuous progress.*

CONTINUUM is a collaborative project workspace for managing the full lifecycle of a complex engineering project. It connects planning, task management, requirements, documentation, test evidence, releases, project history, and AI-agent operations.

## Design principles

- **Persistent context:** project knowledge survives model changes, agent restarts, and conversation limits.
- **Interchangeable agents:** connect existing coding-agent runtimes through adapters.
- **Evidence-based progress:** completion metrics derive from recorded tasks, tests, and approvals.
- **Accountable collaboration:** human users, agents, and automated systems have distinct identities.
- **Enforced protection:** locks are checked by the backend, not merely represented in the UI.
- **Local-first execution:** begin on a developer machine and add remote workers later.
- **Budget-aware:** prioritize open-source tools and available free tiers.

## Planned modules

1. Project command center and analytics
2. Workstreams, requirements, milestones, dependencies, tasks, risks, and blockers
3. Documents, architecture, decisions, and shared project knowledge
4. Repository, build, test, defect, and release traceability
5. AI-agent registry, scheduler, shared context, checkpoints, and automatic handoffs
6. Invite-only accounts, roles, resource locks, permission requests, and approvals
7. Audit history and resource versioning
8. Local worker and optional remote workers

## Proposed stack

- Frontend: React + TypeScript + Vite
- API: Python + FastAPI
- Shared database and authentication: Supabase Auth + PostgreSQL with Row Level Security
- Model routing: integrate the existing RELAY project through a stable adapter
- Agent execution: existing coding-agent runtimes behind a unified interface
- Local execution: isolated Git worktrees and restricted/sandboxed commands

The stack is a starting proposal. Architecture changes should be captured as versioned decisions.

## Build phases

1. Project foundation: projects, members, requirements, tasks, documents, decisions, and activity history.
2. Collaboration and governance: authentication, roles, permissions, locks, scoped grants, and audit history.
3. Engineering traceability: repositories, commits, test cases, test runs, artifacts, issues, and releases.
4. AI orchestration: RELAY adapter, coding-agent runtime adapter, scheduler, checkpoints, and handoffs.
5. Project operations: dashboard, evidence-based progress, planning agent, quality workflows, supervised autopilot.
6. Distributed execution: local worker and optional remote workers.

## Safety defaults

- Public self-registration is off for the initial private workspace.
- Never place secrets in prompts, logs, browser code, or tracked configuration files.
- Agents cannot unlock protected resources or grant themselves permissions.
- Human approval is required for protected changes, destructive operations, merges, and deployment.
- Keep execution bounded by timeouts, retries, tool permissions, and usage limits.
- Treat repository content and issue text as untrusted input.
- Do not report a test as passed unless a recorded execution provides evidence.

## Repository status

**Status:** Initial planning scaffold. Product features are not implemented solely because they are described here.

See [product vision](docs/product-vision.md), [architecture](docs/architecture.md), [data model](docs/data-model.md), [security and permissions](docs/security-and-permissions.md), and [roadmap](docs/roadmap.md).

## Development

Copy `.env.example` to `.env` for local settings. Do not commit real credentials. Setup instructions for each runnable component will be added with the first implementation phase.

## License

Use is restricted by the proprietary terms in [LICENSE](LICENSE). No open-source license is granted.
