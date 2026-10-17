# Security and Permissions

## Authentication

Use a managed authentication provider instead of implementing password storage and session handling from scratch. Initial onboarding is invite-only. Never expose privileged server credentials in browser code.

## Roles

- **Owner:** manages membership, project policies, lock owners, protected settings, and high-risk approvals.
- **Collaborator:** works within granted capabilities and requests access to protected resources.
- **Agent identity:** scoped identity for a runtime/run; does not inherit the owner's unrestricted permissions.
- **System identity:** records trusted automation events such as CI results.

## Authorization

Enforce permissions in the backend and database policies. UI controls are convenience only. Every mutation validates identity, membership, action, resource scope, and protection state.

## Resource locks

A lock defines its resource/scope, owner, reason, status, and timestamps. Support lock, request permission, grant scoped permission, revoke permission, unlock, and view history.

A grant identifies the recipient, permitted actions, exact scope, expiry (if applicable), grantor, and revocation state. Agents cannot create grants, unlock resources, or expand their own permissions.

## Atomic enforcement

Lock/permission validation and the write must be atomic or concurrency-safe. Do not rely on a frontend `if not locked` check. A blocked edit leaves the protected resource unchanged; when practical, save a proposal as a separate patch/draft.

## Audit history

Record actor type/ID, action, resource, timestamp, authorization/grant reference, reason, and before/after values or immutable version references. Restrict ordinary users and agents from altering or deleting audit events. Redact secrets and sensitive data from logs.

## Agent sandboxing

- Isolated worktrees/checkouts per task
- Restricted commands and execution timeouts
- Explicit filesystem and network permissions
- No production secrets in model context
- Approval for destructive commands, protected changes, merges, and deployment
- Bounded concurrency, retries, and model usage
- Treat repository content as untrusted input, not instructions overriding policy

## Recovery

Back up shared state. Version documents and record diffs. Test restore and handoff workflows.
