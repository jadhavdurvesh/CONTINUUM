# Cloud Deployment and Shared Workspace

The backend is hosted. The web app and both PCs connect to the same cloud project; no developer PC needs to host the central database.

## Components

- Vercel deploys the React application from the apps/web root directory.
- Supabase Auth manages invited accounts and sessions.
- Supabase PostgreSQL stores projects, tasks, locks, permissions, run metadata, test records, and audit events.
- Supabase Realtime pushes authorized changes to connected clients.
- The invite-project-member Edge Function invites the collaborator and adds them to a project after verifying the caller is the owner.
- Local or remote workers execute code and will later report task leases, checkpoints, logs, and results to the cloud control plane.

Official references: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization), [Vercel Vite deployments](https://vercel.com/docs/frameworks/frontend/vite).

## Supabase setup

1. Create a hosted Supabase project.
2. Configure the project Site URL and allowed redirect URLs for the eventual Vercel URL and local development.
3. Configure email delivery before inviting your partner. Do not enable unrestricted public signup for this private workspace.
4. Install and authenticate the Supabase CLI.
5. From the repository root, run:

       supabase login
       supabase link --project-ref YOUR_PROJECT_REF
       supabase db push
       supabase functions deploy invite-project-member

6. Review and test the migration against the selected project before storing valuable data. Use a fresh, dedicated Supabase project for this application.

## Vercel setup

Deploy from the Vercel account you intend to use for this project. No Vercel project or deployment is linked by the repository commits in this change. In that account:

1. Import the GitHub repository into Vercel.
2. Set Root Directory to apps/web.
3. Configure these environment variables for Production and Preview:
   - VITE_SUPABASE_URL — hosted project URL
   - VITE_SUPABASE_PUBLISHABLE_KEY — publishable client key
4. Deploy. Both PCs visit the same site and sign in to the same workspace.

The publishable key is intended for client use with RLS. Never add a Supabase secret/service-role key to VITE variables or bundle it in the desktop installer. If the installer is built without Vercel build variables, it presents a cloud setup form where you enter the hosted project URL and publishable key; that client configuration is saved locally for the installation.

## Invite the second collaborator

After signing in and creating a project, open Settings → Members and enter the collaborator's email. The Edge Function validates the session and project-owner membership, sends the Auth invitation, and adds the account as a collaborator. The recipient must accept the email invitation before signing in.

The function uses Supabase's server-side service-role environment key. Never put that key in the web client, desktop bundle, GitHub, or a prompt.

## Code Workbench and Local IDE

Code Workbench stores versioned files in Supabase and protects against concurrent cloud edits. Local IDE connects to the opt-in worker in `services/worker` to edit a real checkout, inspect Git status/diffs, run allowlisted build/test/lint/typecheck commands, and create an explicit local commit for the selected file. The worker binds to loopback, requires a random bearer token, filters secret files, verifies project membership, and checks shared `repository_path_locks` before local writes, file creation, commits, and mutating build/test commands. When an active lock has no current grant, writes fail closed. It never pushes or deploys. Each developer PC runs its own worker and checkout.

For local worker permission checks, set `CONTINUUM_SUPABASE_URL` and `CONTINUUM_SUPABASE_PUBLISHABLE_KEY` in the worker process, plus the worker root/token/origin settings in `services/worker/README.md`. Only use the public publishable key; never use a service-role key in the worker UI or browser. The dashboard supplies the current signed-in user's session token with worker requests. Apply all SQL migrations using `supabase db push` before enabling the Local IDE. Lock state is shared by project-relative path; each PC should use a checkout of the same repository and matching relative file paths. A filesystem write and the cloud lock check cannot be one database transaction, so do not treat this local helper as an OS-level sandbox against other local programs or a user who controls the PC.

## Status and remaining work

Once cloud values are configured and the migration/function are deployed, project/task operations, audit records, task locks, scoped permission grants, and realtime refresh can use the cloud. Agent-run and worker-node schema is present. A secure multi-PC worker service still needs task claim/lease APIs, worker identity, heartbeat handling, checkpoint transport/recovery, and the RELAY runtime adapter. Autonomous coding dispatch is not enabled until those pieces are implemented and tested.

The design can start with provider free tiers, but quotas and uptime are not guaranteed. Before relying on it, test backups, access revocation, recovery, and operational monitoring.
