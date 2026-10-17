# CONTINUUM

**AI Project Operating System**  
*One project. Shared knowledge. Continuous progress.*

CONTINUUM is a collaborative project workspace for the full lifecycle of an engineering project. It aims to connect planning, tasks, documentation, test evidence, releases, project history, and AI-agent operations.

## Current scaffold

- **Web:** React + TypeScript + Vite starter dashboard
- **API:** FastAPI health endpoint and API foundation
- **Planning:** product vision, architecture, data model, security, and roadmap documentation
- **Governance:** planned invite-only accounts, permissions, protected resources, and audit history
- **AI workflow:** planned RELAY integration and adapters for existing coding-agent runtimes

The dashboard and API are starting points, not a completed production system. Authentication, persistence, project metrics, lock enforcement, and agent orchestration still need implementation.

## Design principles

- **Persistent context:** project knowledge survives model changes, agent restarts, and conversation limits.
- **Interchangeable agents:** connect existing coding-agent runtimes through adapters.
- **Evidence-based progress:** completion metrics derive from recorded tasks, tests, and approvals.
- **Accountable collaboration:** human users, agents, and automated systems have distinct identities.
- **Enforced protection:** locks are checked by the backend, not merely represented in the UI.
- **Local-first execution:** begin on a developer machine and add remote workers later.
- **Budget-aware:** prioritize open-source tools and available free tiers.

## Proposed stack

- Frontend: React + TypeScript + Vite
- API: Python + FastAPI
- Shared database and authentication: Supabase Auth + PostgreSQL with Row Level Security
- Model routing: integrate the existing RELAY project through a stable adapter
- Agent execution: existing coding-agent runtimes behind a unified interface
- Local execution: isolated Git worktrees and restricted/sandboxed commands

## Run the starter

### API

Requires Python 3.11 or newer.

```bash
cd services/api
python -m venv .venv
# Windows PowerShell: .venv\Scripts\Activate.ps1
# macOS/Linux: source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000
```

API health: http://127.0.0.1:8000/api/health  
Interactive API docs: http://127.0.0.1:8000/docs

### Web dashboard

Requires Node.js 20 or newer.

```bash
cd apps/web
npm install
npm run dev
```

Open http://localhost:5173. The dashboard will show whether the local API is reachable. It intentionally does not invent project metrics while no project data source exists.

## Documentation

- [Product vision](docs/product-vision.md)
- [Architecture](docs/architecture.md)
- [Data model](docs/data-model.md)
- [Security and permissions](docs/security-and-permissions.md)
- [Roadmap](docs/roadmap.md)

## Safety defaults

- Public self-registration is off for the initial private workspace.
- Never place secrets in prompts, logs, browser code, or tracked configuration files.
- Agents cannot unlock protected resources or grant themselves permissions.
- Human approval is required for protected changes, destructive operations, merges, and deployment.
- Keep execution bounded by timeouts, retries, tool permissions, and usage limits.
- Treat repository content and issue text as untrusted input.
- Do not report a test as passed unless a recorded execution provides evidence.

## License

Use is restricted by the proprietary terms in [LICENSE](LICENSE). No open-source license is granted.
