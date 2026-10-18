# Architecture

## Shared cloud, local execution

The system is cloud-first for shared state and multi-PC coordination. It is not designed around one developer's laptop hosting the backend.

- **Web UI:** React + TypeScript + Vite deployed to Vercel.
- **Identity and shared data:** hosted Supabase Auth + PostgreSQL + Row Level Security.
- **Live collaboration:** Supabase Realtime for authorized task/activity updates, code-file changes, locks, and permission requests.
- **Code Workbench:** CodeMirror in the dashboard, with versioned cloud file records and optimistic version checks.
- **Local IDE worker:** opt-in loopback FastAPI service for the selected local checkout, token-authenticated file access, cloud-verified project membership and repository path locks, Git status/diff/explicit commits, and allowlisted build/test commands. Mutating commands are blocked while a protected path lacks an active grant. It never pushes or deploys.
- **Privileged operations:** Supabase SQL functions and Edge Functions. Secret keys never ship in the browser or desktop installer.
- **Workers:** a small worker service on each authorized PC performs local coding work and reports task status/checkpoints to the cloud control plane.
- **Model routing:** the existing RELAY service remains the provider-routing/failover layer.
- **Desktop app:** Electron shell around the same dashboard; it signs into the shared cloud rather than creating a separate per-PC database.

## Responsibility boundaries

- Orchestrator decides what task should happen next.
- Coding-agent runtime decides how to perform a coding task.
- RELAY routes model requests across providers and handles model-provider failover.
- Cloud database stores durable project state, permissions, checkpoints, and provenance.
- Git records repository history once the worker/repository adapter is connected; the initial Code Workbench has its own database-backed file history.
- Test-run records and artifacts provide evidence of test outcomes.
- Local workers execute code but do not become the source of truth.

## Cross-PC workflow

1. User creates or assigns a task in the web/desktop dashboard.
2. Cloud database stores the task and emits authorized realtime updates.
3. An authorized worker authenticates and claims a task through a server-side lease operation.
4. Worker executes in a dedicated Git worktree with bounded tools and permissions.
5. Worker periodically reports heartbeat, logs, changed paths, test evidence, and checkpoints.
6. If a provider or runtime limit is reached, the worker saves the actual workspace state and error classification.
7. The orchestrator selects a compatible runtime/worker and hands it a durable context packet.
8. The next worker inspects the workspace before resuming.
9. Human approval gates protected changes, merges, destructive actions, and deployment.

## Security boundaries

- Browser and desktop renderer use only the Supabase publishable key with RLS.
- No service-role/secret key is placed in Vite environment variables or desktop files.
- Worker authentication is separate from human sessions and is scoped to the minimum projects/actions required.
- Worker leases must prevent duplicate task claims.
- Protected-resource checks and writes must be concurrency-safe.
- Agent tools run in isolated worktrees and restricted environments.
- Treat repository text, issues, and external tool output as untrusted data.

## Important implementation status

The current milestone implements cloud-authenticated task creation/status updates, realtime refresh, project activity, versioned cloud code files, conflict-checked saves, code-file locks, database-enforced task locks, and a separately run local worker for real-checkout editing and approved development commands. It defines the agent-run/worker-node schema and interface surfaces, but does **not** yet include a complete worker gateway, secure worker token issuance, lease/claim RPC, checkpoint transport, or RELAY runtime adapter. Those must be implemented and tested before autonomous multi-PC execution is enabled.
