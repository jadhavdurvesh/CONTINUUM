# CONTINUUM IDE — Eclipse Theia foundation

This folder is the staged replacement candidate for the hand-built editor. It is an application built **on Eclipse Theia**, not an iframe or a separate website: Theia provides the workbench, editor, file explorer, terminal, task runner, debugger, extension host and theming foundation.

## Requirements

- Windows 10/11 x64 for the installer build.
- Node.js 24.x and Yarn Classic 1.22.22.
- Internet during dependency install and first build. The installed local workbench is intended to edit local folders without calling the cloud.

## Run in development

From this directory:

```powershell
corepack enable
corepack prepare yarn@1.22.22 --activate
yarn install --network-timeout 600000
yarn build
yarn start
```

The build compiles the CONTINUUM Theia extension, rebuilds Electron native dependencies, and bundles the Theia workbench. Run `yarn validate:config` for offline structural checks.

## Build the Windows installer

```powershell
yarn package:win
```

The installer is written to `apps/theia/release/`. GitHub Actions can build and upload this artifact with the **Build CONTINUUM Theia IDE (Windows)** workflow. This is a separate release lane; the existing PySide6 installer is deliberately retained until Theia passes real Windows smoke tests.

## CONTINUUM integration boundary

- Theia owns local files, editor tabs, language tooling, terminal and local developer tasks.
- The existing React dashboard in `apps/web` remains deployed from the Vercel project root `apps/web`.
- Supabase continues to own Auth, shared projects, tasks, agent sessions/messages, RLS, and Realtime.
- `apps/web/api/agents` continues to orchestrate hosted model calls. OpenAI/Groq/OpenRouter credentials remain only in Vercel server environment variables.
- The first extension stage adds a **CONTINUUM → Open Cloud Workspace** command that opens the current deployed dashboard. It does not duplicate authentication or put service/provider credentials in the IDE.
- An embedded authenticated agent view and a shared project selector are a later integration stage; do not claim those views are built until they use the existing Supabase session and Vercel APIs end-to-end.

## Branding and trust

The product/window name is CONTINUUM, application ID is `tech.dmjgroup.continuum`, and the splash screen uses CONTINUUM artwork. Extensions are executable code: install only extensions from trusted registries/sources. The workspace-trust preference remains enabled.

See [the migration plan](../../docs/theia-migration.md) and [third-party notices](THIRD_PARTY_NOTICES.md).
