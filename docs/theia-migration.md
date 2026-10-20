# CONTINUUM migration to Eclipse Theia

## Why this migration

The first editor was custom-built in PySide6 and a smaller React workbench. That gives CONTINUUM its own look and local-file safety rules, but it means editor fundamentals—language tooling, task/terminal integration, debugging, extension hosting, search and workspace behaviors—have to be recreated one by one.

Eclipse Theia is a modular IDE platform designed to be adopted and branded into a product. The application in `apps/theia` composes Theia's editor, Explorer, workspace, terminal, task, debug, SCM, search, output and extension-host packages, then adds a CONTINUUM-specific extension. Theia upstream reference: https://github.com/eclipse-theia/theia (version 1.76.0, EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0 on core packages).

## Staged rollout

### Stage 0 — repository inspection (complete)

- Existing browser dashboard: `apps/web`, deployed separately to Vercel with root directory `apps/web`.
- Cloud agent endpoints: `apps/web/api/agents/status.ts` and `apps/web/api/agents/run-step.ts`.
- Shared identity/data: Supabase Auth, PostgreSQL, RLS and migrations under `supabase/migrations`.
- Current native editor and installer: `apps/native`, PySide6 plus PyInstaller/Inno Setup.
- The current dashboard and native app have existing workflows and remain in place during the migration.

### Stage 1 — Theia desktop foundation (this change)

- Add a separate Eclipse Theia Electron application, branded CONTINUUM, with normal workspace files, editor, terminal, task, debugger, search, source-control and extension-host building blocks.
- Add a first-party Theia extension with a menu/command for opening the hosted CONTINUUM cloud workspace and a short explanation of the cloud credential boundary.
- Add structural validation and a separate Windows installer workflow.
- Do **not** replace the existing PySide6 installer until the Theia installer and local workspace are smoke-tested on Windows.
- Do **not** alter the Vercel project, Vercel environment variables, Supabase schema, or production dashboard.

### Stage 2 — authenticated in-IDE cloud panel

- Reuse the existing Supabase user identity/session model and the authenticated Vercel agent APIs.
- Add project selection and an embedded agent-session view only after end-to-end auth, membership/RLS checks, session persistence, and proposal review tests pass.
- All model calls continue through Vercel; no provider keys enter Theia settings, plugin storage or installer files.

### Stage 3 — migration and release cutover

- Package and smoke-test Windows x64 and then other supported platforms.
- Test workspace open/save offline, file and terminal operations, restart/reopen, theming, and plugin trust.
- Test sign-in, project membership, durable sessions, agent API calls, and review-before-apply against the existing Supabase/Vercel production stack.
- Add build/installer SBOM and third-party notices and verify license obligations.
- Only then change the default desktop installer to Theia and retire redundant PySide6 editor UI.

## Build and tests

Static validation:

```bash
node apps/theia/scripts/validate-config.mjs
```

Build the full IDE and Windows installer on Windows with Node 24 and Yarn Classic:

```powershell
cd apps/theia
corepack enable
corepack prepare yarn@1.22.22 --activate
yarn install --network-timeout 600000
yarn package:win
```

The Windows CI workflow builds an installer artifact on pull requests that touch the Theia app. A passing JSON/config check alone is not evidence that a packaged application launches; use the workflow result plus a manual Windows smoke test before release.

## Trade-offs

- The full Eclipse Theia desktop product uses Electron. This migration intentionally accepts that in exchange for a mature complete IDE foundation; it supersedes the earlier PySide6-only constraint for the **candidate** desktop, but retains the old app during staged validation.
- The installed local IDE is designed to open and edit local workspace files without the cloud. Authentication, shared project records and hosted model agents require network access.
- Marketplace extensions are executable code, so extension installation should remain restricted to approved/trusted sources for managed deployments.
