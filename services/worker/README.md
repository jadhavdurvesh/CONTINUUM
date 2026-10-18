# CONTINUUM Local Worker

The worker gives the browser IDE access to one explicitly configured local repository. It is designed to run only on loopback on the developer's own PC. Never expose port 4318 to the LAN or internet.

## Windows PowerShell setup

From the repository root, run:

    cd services/worker
    py -3 -m venv .venv
    .\.venv\Scripts\Activate.ps1
    python -m pip install -e ".[dev]"
    $env:CONTINUUM_WORKSPACE_ROOT = "C:\path\to\your\checkout"
    $env:CONTINUUM_WORKER_TOKEN = (python -c "import secrets; print(secrets.token_urlsafe(40))")
    $env:CONTINUUM_SUPABASE_URL = "https://YOUR_PROJECT_REF.supabase.co"
    $env:CONTINUUM_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_..."
    $env:CONTINUUM_ALLOWED_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173,https://YOUR-VERCEL-DOMAIN"
    uvicorn app.main:APP --host 127.0.0.1 --port 4318

Replace the workspace path and Vercel origin with your real values. Keep the terminal open while using the IDE.

## macOS / Linux setup

    cd services/worker
    python3 -m venv .venv
    . .venv/bin/activate
    python -m pip install -e ".[dev]"
    export CONTINUUM_WORKSPACE_ROOT="$HOME/src/your-project"
    export CONTINUUM_WORKER_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(40))')"
    export CONTINUUM_SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co"
    export CONTINUUM_SUPABASE_PUBLISHABLE_KEY="sb_publishable_..."
    export CONTINUUM_ALLOWED_ORIGINS="http://localhost:5173,http://127.0.0.1:5173,https://YOUR-VERCEL-DOMAIN"
    uvicorn app.main:APP --host 127.0.0.1 --port 4318

## Connect the IDE

1. Open CONTINUUM and choose Local IDE.
2. Set worker URL to http://127.0.0.1:4318.
3. Paste the token generated in the worker terminal.
4. Click Connect. URL and token are stored only in this browser's local storage.
5. Select a file, edit it, and save. Use Source Control to inspect status/diffs.

The hosted website must be included in CONTINUUM_ALLOWED_ORIGINS before cross-origin browser requests are allowed. The worker also needs CONTINUUM_SUPABASE_URL and CONTINUUM_SUPABASE_PUBLISHABLE_KEY to verify membership and enforce repository path locks. Use the project URL and public publishable key only, never a service-role key. The dashboard sends the current signed-in session token per request; the worker does not store that user token. The worker can access only the checkout on the PC running it. For a second PC, run its own worker pointed at that PC's clone; use Git remote/push/pull to synchronize. The worker never pushes automatically.

## Security limits

- The server binds to 127.0.0.1; do not change it to 0.0.0.0.
- Workspace endpoints require a random bearer token at least 32 characters long.
- Only configured origins are allowed; browser credentials are not sent. The worker opts approved origins into private-network preflights required by some browsers.
- File paths are confined to the configured root; traversal and symlinks are rejected.
- Repository path locks are enforced against the shared cloud database for saves, new files, commits, and build/test commands; checks fail closed if the cloud is unavailable.
- .env files, private keys, common generated directories, and files over 1.5 MB are excluded.
- Commands are argument arrays, never shell strings. Only approved build/test/lint/typecheck, pytest, compileall, and read-only Git commands are accepted.
- Git commits require an explicit message and file list. The worker refuses to include pre-staged changes and never pushes or deploys.
- This is a developer companion, not a hardened multi-user remote execution service. Do not expose it publicly.

## Tests

    python -m pip install -e ".[dev]"
    pytest
