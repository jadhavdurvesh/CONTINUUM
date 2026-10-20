# CONTINUUM

**An engineering operating system built on a full IDE platform, with shared cloud intelligence.**

CONTINUUM is moving in stages from a hand-built PySide6 editor to a branded **Eclipse Theia** desktop IDE. The Theia candidate in `apps/theia` composes a mature workbench with editor, file explorer, terminal, tasks, debugging, search and extension-host capabilities; its first-party extension adds CONTINUUM commands. The existing PySide6 desktop in `apps/native` remains available while the new installer is built and tested. See [the migration plan](docs/theia-migration.md).

Cloud functionality remains separate and unchanged: Supabase provides authentication, shared projects, tasks, agent sessions, permissions and conversation history. Vercel serverless functions orchestrate cloud agents and provider failover. AI-provider credentials stay in Vercel and are never shipped with the desktop.

## What works in the native app

- Native Windows application and normal Start Menu/optional desktop shortcuts.
- Local project-folder explorer, multiple open editor tabs, new files, saving, and unsaved-change protection.
- Offline-first local editing. No web view or Electron runtime.
- Optional hosted cloud sign-in and shared project selection.
- Durable cloud agent sessions with Planner, Coder, Reviewer, and QA roles.
- Cloud model routing with provider failover (OpenAI-compatible OpenAI, Groq, and OpenRouter endpoints).
- The desktop sends a small, bounded set of relevant source snippets to the hosted AI service for a requested agent step.
- Agent edits are returned as proposals. Applying a proposal requires explicit approval, creates local backups, rejects secret paths/traversal, and checks cloud repository path locks first.
- No automatic commits, pushes, deployments, or arbitrary command execution from agent output.

**Offline boundary:** local file editing and saves continue without internet. Cloud sign-in, shared project records, agent runs, database sync, and model calls require internet. If the cloud is unavailable, the local IDE remains open and usable.

## Architecture

- **Desktop migration:** apps/theia — Eclipse Theia-based candidate desktop IDE; apps/native — current PySide6 desktop retained during validation.
- **Cloud dashboard:** apps/web — React + TypeScript + Vite; deploy to Vercel with root directory apps/web.
- **Cloud agent APIs:** apps/web/api/agents — authenticated Vercel functions; provider keys live only in Vercel.
- **Shared database:** hosted Supabase Auth, PostgreSQL, RLS, and Realtime. SQL migrations are in supabase/migrations.
- **Local Python worker:** services/worker remains an optional developer-only companion for the legacy browser Local IDE; the native app does not need it for normal local editing or cloud agent calls.

## Cloud deployment (one-time owner setup)

1. Create or select a hosted Supabase project. Apply all migrations using the Supabase CLI after linking the project:

~~~bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
supabase functions deploy invite-project-member
~~~

2. Import this repository into Vercel and set the project root to apps/web.
3. Configure Vercel environment variables:
   - VITE_SUPABASE_URL
   - VITE_SUPABASE_PUBLISHABLE_KEY
   - SUPABASE_URL
   - SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY)
   - At least one model-provider key: OPENAI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY.
   - Optional model settings: OPENAI_MODEL, OPENAI_BASE_URL, GROQ_MODEL, OPENROUTER_MODEL.
4. Use the stable Production URL of the Vercel deployment for the desktop release configuration.
5. Configure Supabase Auth email delivery and redirect URLs. Keep signup/invitation policies restricted to the intended workspace.
6. Apply RLS migrations before using cloud data or agent sessions.

The native installer does not ask users for Supabase or AI credentials. Before generating an installer, the repository owner adds these **GitHub Actions repository secrets once**:

- SUPABASE_URL — hosted project URL.
- SUPABASE_PUBLISHABLE_KEY — public publishable/anon client key only, never the service-role key.
- CONTINUUM_CLOUD_API_URL — stable Vercel Production URL, for example https://your-deployment.vercel.app.

The installer build embeds only these public connection settings. AI-provider keys stay in Vercel and are not distributed. Since the Supabase client key is public, Row Level Security is mandatory.

## Desktop IDE migration

The Theia candidate is built separately from [`apps/theia`](apps/theia/README.md). On Windows, use Node.js 24 and Yarn Classic 1.22.22 and run `yarn package:win` from that directory, or use the **Build CONTINUUM Theia IDE (Windows)** workflow. The new installer is not the default release yet: retain the PySide6 installer until Theia's installer, local-workspace behavior and cloud integration have passed the migration smoke tests.

The existing **Build native desktop installer** workflow is still available for the current PySide6 application.

## Develop locally

### Web dashboard

Requires Node.js 20+:

~~~bash
cd apps/web
npm install
cp .env.example .env.local
# Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY for your dev project
npm run dev
~~~

The Vercel API functions run when deployed on Vercel. For local serverless API development, use the Vercel CLI and configure the same server-side environment variables.

### Native desktop

Requires Python 3.11+:

~~~bash
cd apps/native
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
python -m pip install -r requirements.txt
python main.py
~~~

Without packaging-time cloud configuration, the native editor still works offline; cloud actions remain disabled and no key-entry wizard is shown.

Run native workspace safety tests:

~~~bash
cd apps/native
python -m unittest discover -s tests -v
~~~

### Existing Python services

- services/api — existing API service and unit tests.
- services/worker — local-only worker for the optional legacy browser IDE. Install its development extras before running pytest.

## Security boundaries

- Desktop embeds only a public Supabase publishable/anon key. It must not contain service-role keys or AI-provider credentials.
- Provider credentials are stored as Vercel environment variables and read only by server-side agent functions.
- Supabase row-level security enforces membership and protected cloud workspace writes.
- Local workspace writes are restricted to the selected root. Secret files, credential files, binary files, traversal paths, symlink paths, and very large text files are blocked by the built-in editor.
- Model changes are proposals; the user chooses when to apply them. Existing local files are backed up before applying.
- Git commit, push, deployment, destructive operations, and unrestricted shell execution are not automatic.

## License

Use is restricted by the proprietary terms in LICENSE. No open-source license is granted.
