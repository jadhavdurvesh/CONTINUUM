# CONTINUUM IDE — Eclipse Theia foundation

This folder is the staged replacement candidate for the hand-built editor. It is an application built **on Eclipse Theia**, not an iframe or separate website. Theia provides the workbench, editor, file explorer, terminal, task runner, debugger, extension host and theming foundation. The first-party CONTINUUM extension adds an authenticated Cloud panel while preserving the existing dashboard.

## Requirements

- Windows 10/11 x64 for the installer build.
- Node.js 24.x and Yarn Classic 1.22.22.
- Internet during dependency installation and the first build. The installed local workbench is intended to edit local folders without calling the cloud.

## Run in development

From this directory:

```powershell
corepack enable
corepack prepare yarn@1.22.22 --activate
yarn install --network-timeout 600000
yarn build
yarn start
```

The build compiles the CONTINUUM Theia extension, rebuilds Electron native dependencies and bundles the Theia workbench. Run `yarn validate:config` for offline structural checks.

## Build the Windows installer

```powershell
yarn package:win
```

The installer is written to `apps/theia/release/`. GitHub Actions can build and upload it with the **Build CONTINUUM Theia IDE (Windows)** workflow. This is a separate release lane; retain the existing PySide6 installer until Theia passes automated builds and real Windows smoke tests.

## CONTINUUM integration boundary

- Theia owns local files, editor tabs, language tooling, terminal and local developer tasks.
- The existing React dashboard in `apps/web` remains deployed from the Vercel project root `apps/web`.
- Supabase continues to own Auth, shared projects, tasks, agent sessions/messages, RLS and Realtime.
- `apps/web/api/agents` continues to orchestrate hosted model calls. OpenAI/Groq/OpenRouter credentials remain only in Vercel server environment variables.
- **CONTINUUM → Open Cloud Panel** opens the integrated view for Supabase sign-in, RLS-scoped project selection, durable agent sessions, shared conversation history and one-step Vercel agent runs.
- **CONTINUUM → Open Cloud Dashboard** remains available as a link to the existing deployed dashboard.
- The panel saves only the Supabase project URL and public publishable/anon client key in local desktop storage. Supabase owns authentication and RLS; provider keys remain server-side on Vercel.
- Agent context is bounded before sending. Proposed changes are displayed for review; the panel does not silently write proposals into local folders.

## Branding and trust

The product/window name is CONTINUUM, application ID is `tech.dmjgroup.continuum`, and the splash screen uses CONTINUUM artwork. Extensions are executable code: install only extensions from trusted registries/sources. The workspace-trust preference remains enabled.

See [the migration plan](../../docs/theia-migration.md) and [third-party notices](THIRD_PARTY_NOTICES.md).
