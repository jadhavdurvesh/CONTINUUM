# Cloud deployment

## Vercel

Import the repository into Vercel and set **Root Directory** to apps/web. Use Node.js 20 or newer. Vercel serves the Vite-built dashboard and the Node serverless functions under apps/web/api.

Set these environment variables for Preview and Production as appropriate:

| Variable | Purpose |
|---|---|
| VITE_SUPABASE_URL | Supabase project URL for the browser dashboard |
| VITE_SUPABASE_PUBLISHABLE_KEY | Public Supabase publishable/anon key for the browser dashboard |
| SUPABASE_URL | Supabase project URL used by cloud agent endpoints |
| SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY | Public key paired with the current user's bearer token |
| OPENAI_API_KEY | Optional cloud model provider |
| GROQ_API_KEY | Optional fallback cloud model provider |
| OPENROUTER_API_KEY | Optional fallback cloud model provider |
| OPENAI_MODEL | Optional model override; defaults to gpt-4o-mini |
| OPENAI_BASE_URL | Optional OpenAI-compatible API base URL |
| GROQ_MODEL | Optional Groq model override |
| OPENROUTER_MODEL | Optional OpenRouter model override |

Configure at least one provider key. With multiple keys present, the agent endpoint attempts the configured providers in order and falls back after a provider failure. The status endpoint returns provider names only; it never returns key values.

## Supabase

Use the Supabase CLI to link your hosted project, apply the checked-in schema/migrations, and deploy the invite function:

~~~bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
supabase functions deploy invite-project-member
~~~

Configure Auth email delivery and redirect URLs. Invitation-only projects need a workspace owner and properly invited members. Ensure all database migrations are applied before running the agent console, since agent sessions and messages require 202610180003_agent_sessions.sql.

The cloud agent endpoint uses the current signed-in user's bearer token with the Supabase public key and is subject to RLS. It does not require a service-role key. Never add service-role credentials to Vite or a desktop build.

## Native Windows installer

The native application needs its cloud endpoints at packaging time so end users never have to paste keys into the installed app. Add these **GitHub Actions repository secrets** once:

- SUPABASE_URL — Supabase hosted project URL.
- SUPABASE_PUBLISHABLE_KEY — publishable/anon key, not service role.
- CONTINUUM_CLOUD_API_URL — stable Vercel Production URL, with no /api/... suffix.

Then run the **Build native desktop installer** workflow. It generates the ignored apps/native/continuum/_release_cloud_config.py module in the Actions runner, builds the native PySide6 app, packages it with PyInstaller, and creates an Inno Setup installer. The generated file is not committed. AI provider keys remain only in Vercel and are never shipped to the desktop.

If the Vercel deployment URL changes, update CONTINUUM_CLOUD_API_URL and build a new installer. The desktop local IDE works offline regardless; only cloud features depend on the deployment being reachable.

## Smoke checks

- Open the Vercel dashboard and sign in with an invited account.
- Check /api/agents/status on the Production domain; it should indicate Supabase configuration and at least one provider.
- Create a project and agent session after applying all migrations.
- Install the generated Windows artifact, open a local directory, and confirm that editing and saving files work with the network disconnected.
- Reconnect, sign in, select the same project, queue an agent session, run one step, and review the proposal before applying.
