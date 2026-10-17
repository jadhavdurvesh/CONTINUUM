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

1. Import the GitHub repository into Vercel.
2. Set Root Directory to apps/web.
3. Configure these environment variables for Production and Preview:
   - VITE_SUPABASE_URL — hosted project URL
   - VITE_SUPABASE_PUBLISHABLE_KEY — publishable client key
4. Deploy. Both PCs visit the same site and sign in to the same workspace.

The publishable key is intended for client use with RLS. Never add a Supabase secret/service-role key to VITE variables or bundle it in the desktop installer.

## Invite the second collaborator

After signing in and creating a project, open Settings → Members and enter the collaborator's email. The Edge Function validates the session and project-owner membership, sends the Auth invitation, and adds the account as a collaborator. The recipient must accept the email invitation before signing in.

The function uses Supabase's server-side service-role environment key. Never put that key in the web client, desktop bundle, GitHub, or a prompt.

## Status and remaining work

Once cloud values are configured and the migration/function are deployed, project/task operations, audit records, task locks, scoped permission grants, and realtime refresh can use the cloud. Agent-run and worker-node schema is present. A secure multi-PC worker service still needs task claim/lease APIs, worker identity, heartbeat handling, checkpoint transport/recovery, and the RELAY runtime adapter. Autonomous coding dispatch is not enabled until those pieces are implemented and tested.

The design can start with provider free tiers, but quotas and uptime are not guaranteed. Before relying on it, test backups, access revocation, recovery, and operational monitoring.
