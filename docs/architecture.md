# CONTINUUM architecture

## Product boundary

CONTINUUM is a local-first engineering IDE paired with hosted collaboration and AI. The desktop is undergoing a staged migration from a hand-built PySide6 editor (`apps/native`) to a customizable Eclipse Theia workbench (`apps/theia`). The Theia candidate is the default IDE only after its packaged Windows app passes build and smoke tests. Both tracks remain available during validation.

## Responsibilities

- **Candidate desktop IDE (`apps/theia`)** — Eclipse Theia workbench built as a branded CONTINUUM desktop application. Theia supplies editor, explorer, terminal, tasks, debugging, search, SCM and extension infrastructure; the first-party extension exposes a command to open the existing cloud dashboard.
- **Current desktop (`apps/native`)** — PySide6/Qt local-first editor and current native installer. Kept until the Theia replacement is ready.
- **Web dashboard (`apps/web`)** — project, task, protected-resource, activity, settings, cloud-agent-session and shared code-workbench UI deployed to Vercel from root directory `apps/web`.
- **Vercel agent APIs (`apps/web/api/agents`)** — authenticated requests using the signed-in Supabase session, RLS-gated shared records, provider routing/failover and structured agent proposals.
- **Supabase** — hosted authentication, PostgreSQL, RLS, Realtime, persistent agent sessions/messages, shared tasks and protected-resource records.
- **AI providers** — provider endpoints configured using server-side Vercel environment variables. Provider API keys are never embedded in either desktop build.
- **Optional legacy local worker (`services/worker`)** — retained for the earlier browser Local IDE.

## Online/offline behavior

Theia is designed to open and edit local workspace files through its local desktop backend. Local workspace editing should not depend on CONTINUUM's cloud being available. Authentication, shared project records, synchronized agent sessions and hosted model calls require internet. These offline and restart behaviors must be smoke-tested against the packaged Windows artifact before the Theia app becomes the default release.

## Cloud agent flow

1. User opens the existing CONTINUUM dashboard or, in a later stage, the authenticated cloud panel integrated into Theia.
2. Supabase authenticates the user and applies project membership/RLS rules.
3. The dashboard or future Theia panel calls the existing `POST /api/agents/run-step` Vercel function with the user's Supabase access token.
4. Vercel validates the user and permissions, calls the configured model provider, validates the structured JSON proposal and persists the result through the existing Supabase data model.
5. Agent edits remain proposals. The user reviews before applying; local writes must continue to validate workspace paths and avoid secret/credential files.
6. Git commits, pushes, releases and deployments remain explicit human actions.

The first Theia stage opens the hosted dashboard rather than duplicating cloud authentication. An embedded agent/project panel is a later stage and must reuse the current Supabase identity and Vercel API. No provider keys are stored in Theia settings or plugin storage.

## Credential boundaries

- `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` configure the browser client.
- `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`) configure server-side REST access using the current user's bearer token and RLS.
- `OPENAI_API_KEY`, `GROQ_API_KEY`, and `OPENROUTER_API_KEY` belong only in Vercel's server-side environment variables.
- `SUPABASE_SERVICE_ROLE_KEY` must never be embedded in the web bundle or desktop installer.
- The Theia installer contains open-source Theia runtime packages and must ship with the applicable upstream license/notice materials. See [the migration plan](theia-migration.md) and [third-party notices](../apps/theia/THIRD_PARTY_NOTICES.md).

## Deployment and installers

- Vercel continues to deploy `apps/web`; the Theia build does not change the current Vercel project or root directory.
- The current native installer is built by `.github/workflows/build-installers.yml`.
- The candidate Theia installer is built separately by `.github/workflows/build-theia-windows.yml`.
- Keep the PySide6 release lane until the Theia installer compiles, launches and passes local editing plus cloud integration smoke checks.
