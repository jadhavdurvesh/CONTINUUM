# CONTINUUM

**AI Project Operating System**  
*One project. Shared knowledge. Continuous progress.*

CONTINUUM is a cloud-synchronized project workspace for managing engineering work from requirements and planning through implementation, testing, approval, and release. Human collaborators and AI agents share project state, while permissions and resource locks control who can change protected work.

## Current implementation

- React + TypeScript + Vite dashboard with a warm paper/ink visual system, terracotta, olive, and plum accents
- Hosted Supabase Auth + PostgreSQL + Row Level Security for shared state
- Realtime refresh for tasks, activity, locks, permission requests, agent runs, and worker status
- Project creation, task creation, task status updates, and project activity audit events
- Code Workbench with a file explorer, multi-tab syntax-aware editor, search shortcuts, version history, protected files, and conflict-safe cloud saves
- Local IDE companion for editing a real checkout, inspecting Git status/diffs, running allowlisted build/test commands, and creating explicit local commits
- Database-enforced resource locks and time-limited permission grants
- Supabase Edge Function for invite-only project-member invitations
- Electron desktop shell and Windows installer workflow with a license-acceptance page
- Product, architecture, cloud deployment, security, data model, and roadmap documentation

The Code Workbench edits versioned files stored in the shared cloud workspace. The separate Local IDE connects to a loopback-only worker on a developer PC for local file edits, Git status/diffs, allowlisted build/test tasks, and explicitly requested local commits. It never pushes or deploys automatically. Worker leases/heartbeats, the RELAY adapter, cross-runtime handoff execution, and test-runner integration still require further implementation. The dashboard marks unconfigured areas honestly rather than inventing metrics.

## Cloud architecture

The web application is not deployed by these commits. In your own Vercel account, import this repository and set its root directory to `apps/web`; then configure the Supabase URL and publishable key as environment variables. See `docs/cloud-deployment.md`.


- Web dashboard: Vercel, project root apps/web
- Shared backend: hosted Supabase Auth, PostgreSQL, RLS, and Realtime
- Member invitations: Supabase Edge Function invite-project-member
- Model routing: integrate the existing RELAY project through a server-side adapter
- Coding execution: authorized local or remote worker nodes
- Desktop app: Electron shell around the same dashboard, signing into the same cloud project

See docs/cloud-deployment.md, docs/architecture.md, and docs/security-and-permissions.md.

## Run the web client locally

Requires Node.js 20 or newer.

    cd apps/web
    npm install
    cp .env.example .env.local
    # Fill VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local
    npm run dev

Open http://localhost:5173. Without cloud values the app displays the cloud-configuration guide rather than fabricated project data.

## Set up the shared cloud database

Install and authenticate the Supabase CLI, link your hosted project, and apply the migration and invitation function:

    supabase login
    supabase link --project-ref YOUR_PROJECT_REF
    supabase db push
    supabase functions deploy invite-project-member

Configure Auth email delivery and allowed redirect URLs before inviting collaborators. Keep privileged server keys in the hosted function environment only. Never add a service-role key to a VITE_ variable.

## Local IDE worker

See `services/worker/README.md` to connect the Local IDE to a real checkout on your own PC. The worker must bind to `127.0.0.1`; configure its random bearer token and exact allowed browser origins. Each PC runs its own worker against its own clone.

## Desktop installer

GitHub Actions builds the Windows installer. Run the Build desktop installers workflow manually, or push a version tag such as v0.1.0. The NSIS installer displays LICENSE and requires acceptance before installation proceeds.

## Tests and CI

GitHub Actions builds the dashboard and runs the API unit tests on pushes and pull requests. The installer workflow creates an artifact downloadable from its run. A successful CI build is not the same as deployment to a configured cloud project.

## Safety defaults

- Invitation-only authentication; no public signup flow is provided in the app
- Browser uses only the Supabase URL and publishable key with RLS
- Locks and role checks are enforced server-side
- Agents cannot grant their own permissions or unlock protected resources
- Merge, deployment, and destructive operations remain approval-gated
- Test results must originate from recorded executions
- Do not commit credentials or private keys

## License

Use is restricted by the proprietary terms in LICENSE. No open-source license is granted.
