# CONTINUUM architecture

## Product boundary

CONTINUUM is a native local-first IDE paired with hosted collaboration and AI. The desktop application is implemented with PySide6/Qt and talks to the operating system's filesystem directly. It is not an Electron application or a WebView wrapper.

## Responsibilities

- **Native desktop (apps/native)** — local folder explorer, tabbed text editing, safe saves, local backups, workspace context collection, optional cloud sign-in, and a review/apply workflow for cloud proposals.
- **Web dashboard (apps/web)** — project, task, protected-resource, activity, and shared code-workbench UI deployed on Vercel.
- **Vercel agent APIs (apps/web/api/agents)** — authenticate using the supplied Supabase user session, confirm access through Row Level Security, route model requests across provider configurations, write durable results to Supabase, and return reviewable proposals.
- **Supabase** — hosted authentication, PostgreSQL, RLS, Realtime, persistent agent sessions/messages, shared tasks, and protected resource records.
- **AI providers** — OpenAI-compatible endpoints configured using server-side Vercel environment variables. The native desktop never receives the provider API keys.
- **Optional legacy local worker (services/worker)** — retained for the browser Local IDE while the native desktop becomes the primary local workspace.

## Online/offline behavior

No cloud endpoint is required to open a local directory, browse normal files, create a local file, edit, save, or close the native app. Cloud sign-in, project data, agent sessions, model calls, and shared database state need an internet connection. The interface reports unavailable cloud features without blocking local editing.

## Cloud agent flow

1. A user signs into CONTINUUM from the native app or dashboard.
2. The user selects a shared Supabase project and creates a durable agent session; the prompt, role, linked task, and focus paths are stored in agent_sessions and agent_messages.
3. When asked to run one step, the desktop sends at most 12 bounded snippets from safe local text files (or the web client sends files from code_files) to POST /api/agents/run-step with the user's Supabase access token.
4. The Vercel function validates the session and membership using the user JWT and publishable key. The database's RLS policies remain the authority.
5. The function routes the model call through configured providers with failover, validates the structured JSON response, and records the result and provider metadata in Supabase.
6. The agent may return a source proposal but never executes it. The native desktop asks for explicit approval, verifies every path and shared path lock, backs up existing files, and applies the proposal locally. The dashboard applies proposals only to its shared code_files table where RLS and database triggers enforce protection.
7. Users inspect changed files and run their own local checks. Git commits, pushes, releases, and deployments remain explicit human actions.

## Credential boundaries

- VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY configure the browser client.
- SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY) configure server-side REST access using the current user's bearer token and RLS.
- OPENAI_API_KEY, GROQ_API_KEY, and OPENROUTER_API_KEY belong only in Vercel's server-side environment variables.
- SUPABASE_SERVICE_ROLE_KEY is not required by the agent endpoint and must never be embedded in the web bundle or desktop installer.
- CONTINUUM_CLOUD_API_URL is injected at desktop build time as a service base URL; it is not a credential.

## Native installer

GitHub Actions builds a native Windows app with PyInstaller and an Inno Setup installer. The compiled GUI is PySide6 and opens the local filesystem without a browser engine. Required public cloud connection settings are injected at build time from repository secrets so that end users do not complete a key-configuration wizard after installation.
