# Architecture

## Logical components

1. **Web dashboard:** project views, task board, analytics, agent activity, diffs, approvals, settings.
2. **API and policy layer:** authentication verification, authorization, project APIs, lock enforcement, audit events, worker registration.
3. **Project data layer:** PostgreSQL with row-level security.
4. **Orchestrator:** task state machine, dependency scheduler, retries, checkpoints, handoff, approval gates.
5. **RELAY adapter:** routes model requests; does not own project task state.
6. **Agent adapters:** normalize start, continue, cancel, status, and result operations.
7. **Workers:** local first, remote optional; bounded execution in isolated workspaces.
8. **Evidence adapters:** repository events, CI results, test artifacts, releases.

## Responsibility boundaries

- Orchestrator decides what task should happen next.
- Coding-agent runtime decides how to perform a coding task.
- RELAY decides which model handles a model request.
- Project database records durable state and provenance.
- Git records version-controlled code.
- Test-run records and artifacts provide evidence of test outcomes.

## Task lifecycle

`queued -> ready -> running -> checkpointed -> review -> approved -> completed`

Other states include `blocked`, `failed`, `cancelled`, and `needs_permission`. Validate state transitions server-side and append an event for each transition.

## Agent handoff

1. Detect a classified, retryable provider/runtime failure or an explicit stop.
2. Stop scheduling new operations for that run.
3. Inspect the actual worktree; do not assume a failed request made no changes.
4. Persist task state, tool events, current diff/commit, test results, and next actions.
5. Select a compatible runtime with available capacity and permissions.
6. Provide project rules, relevant documents, task contract, checkpoint, and workspace reference.
7. Require the new agent to inspect the workspace before editing.
8. Resume, verify tests, and record the handoff outcome.

Cross-runtime handoff must rely on durable project state rather than assuming chat-history portability.

## Concurrency

Use isolated Git worktrees or separate checkouts for parallel code tasks. Store task leases/heartbeats and prevent duplicate task claiming. Use optimistic version checks or transactions for conflicting edits. Lock validation and the protected write must be concurrency-safe.

## Observability

Record timestamps, task ID, agent/runtime, model/provider when known, status transitions, tool calls, changed paths, test run IDs, retry count, usage/cost where available, and redacted error details.
