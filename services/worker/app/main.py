"""Local-only companion worker for the CONTINUUM IDE.
Run: uvicorn app.main:APP --host 127.0.0.1 --port 4318
Set CONTINUUM_WORKSPACE_ROOT and a random CONTINUUM_WORKER_TOKEN first.
"""
from __future__ import annotations
import hmac
import json as _json
import os
import re
import subprocess
import os as _os
import tempfile
import uuid as _uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from typing import Annotated
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

APP = FastAPI(title="CONTINUUM Local Worker", version="0.2.0")
MAX_FILE_BYTES = 1_500_000
MAX_OUTPUT = 30_000
IGNORED = {".git", "node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build", "coverage", ".pytest_cache"}
SECRETS = {".env", ".env.local", ".env.production", ".env.development", ".npmrc", ".pypirc", "credentials.json", "secrets.json", "id_rsa", "id_ed25519"}
SECRET_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".keystore"}
# Paths that execute automatically (CI, git hooks, editor tasks). Agent proposals must never write here.
AUTOMATION_DIRS = {".github", ".husky", ".githooks", ".vscode", ".gitlab"}
AUTOMATION_FILES = {".gitattributes", ".gitmodules", ".gitlab-ci.yml"}

def is_automation_path(path: str) -> bool:
    parts = [p.lower() for p in path.replace("\\", "/").split("/")]
    return any(p in AUTOMATION_DIRS for p in parts) or parts[-1] in AUTOMATION_FILES
origins = [x.strip().rstrip("/") for x in os.getenv("CONTINUUM_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if x.strip()]
APP.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False, allow_methods=["GET", "POST", "PUT", "OPTIONS"], allow_headers=["Authorization", "Content-Type", "X-Continuum-Project-Id", "X-Continuum-User-Token"], allow_private_network=True, max_age=600)

def root_path() -> Path:
    raw = os.getenv("CONTINUUM_WORKSPACE_ROOT", "").strip()
    if not raw or not Path(raw).expanduser().is_absolute():
        raise HTTPException(503, "Set CONTINUUM_WORKSPACE_ROOT to an absolute repository folder.")
    try:
        root = Path(raw).expanduser().resolve(strict=True)
    except OSError as exc:
        raise HTTPException(503, "Configured workspace folder does not exist.") from exc
    if not root.is_dir():
        raise HTTPException(503, "Configured workspace path is not a directory.")
    return root

def require_token(authorization: Annotated[str | None, Header()] = None) -> None:
    expected = os.getenv("CONTINUUM_WORKER_TOKEN", "").strip()
    if len(expected) < 32:
        raise HTTPException(503, "Set CONTINUUM_WORKER_TOKEN to at least 32 random characters.")
    supplied = authorization.removeprefix("Bearer ").strip() if authorization else ""
    if not supplied or not hmac.compare_digest(supplied, expected):
        raise HTTPException(401, "Worker token is missing or invalid.")

def safe_path(raw: str) -> str:
    value = raw.replace("\\", "/").strip()
    parts = value.split("/")
    if not value or len(value) > 240 or value.startswith("/") or re.match(r"^[A-Za-z]:", value) or any(p in {"", ".", ".."} for p in parts) or any(ord(c) < 32 or c in '<>:"|?*' for c in value):
        raise HTTPException(400, "Use a safe relative path inside the workspace.")
    if any(p.lower() in IGNORED for p in parts):
        raise HTTPException(403, "Internal or generated directories are not exposed.")
    name = parts[-1].lower()
    safe_env_example = name in {".env.example", ".env.sample", ".env.template"}
    if (name in SECRETS or (name.startswith(".env.") and not safe_env_example)
            or Path(name).suffix.lower() in SECRET_SUFFIXES):
        raise HTTPException(403, "Secret and credential files are not exposed.")
    return "/".join(parts)

def resolve_path(root: Path, raw: str, must_exist: bool = False) -> Path:
    safe = safe_path(raw)
    target = root.joinpath(*safe.split("/"))
    try:
        target.resolve(strict=must_exist).relative_to(root)
    except FileNotFoundError as exc:
        raise HTTPException(404, "File not found.") from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(403, "Path escapes the configured workspace.") from exc
    current = root
    for part in safe.split("/"):
        current = current / part
        if current.is_symlink():
            raise HTTPException(403, "Symbolic links cannot be traversed through the worker.")
    return target

def run_process(args: list[str], root: Path, timeout: int = 30) -> dict:
    try:
        result = subprocess.run(args, cwd=root, shell=False, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", timeout=timeout, env={**{k: v for k, v in os.environ.items() if not k.upper().startswith("CONTINUUM_")}, "CI": "1", "GIT_TERMINAL_PROMPT": "0"})
        return {"exit_code": result.returncode, "output": result.stdout[-MAX_OUTPUT:], "truncated": len(result.stdout) > MAX_OUTPUT}
    except FileNotFoundError:
        return {"exit_code": 127, "output": "Executable not found: " + args[0], "truncated": False}
    except subprocess.TimeoutExpired:
        return {"exit_code": 124, "output": "Command timed out after " + str(timeout) + " seconds.", "truncated": True}

_PYTEST_FLAGS = {"-q", "-x", "-v", "-vv", "-s", "--lf", "--ff", "--co", "--collect-only", "--no-header", "-rA", "-ra"}
_PYTEST_VALUE_FLAGS = ("--tb=", "--maxfail=", "-k=", "-m=")

def _pytest_args_ok(args: list[str]) -> bool:
    """Allow only test paths and a few harmless flags.

    Options such as --basetemp (which deletes the directory it points at), -p/-c/--rootdir/-o
    (which load code or redirect configuration) must not be reachable from the browser.
    """
    for arg in args:
        if arg.startswith("-"):
            if arg in _PYTEST_FLAGS or arg.startswith(_PYTEST_VALUE_FLAGS):
                continue
            return False
        normalized = arg.replace("\\", "/")
        node = normalized.split("::", 1)[0]
        if (not node or node.startswith("/") or re.match(r"^[A-Za-z]:", node)
                or any(part in {"..", "."} for part in node.split("/"))
                or any(ord(c) < 32 for c in arg)):
            return False
    return True

def checked_command(command: list[str]) -> tuple[list[str], int]:
    if not command or len(command) > 20 or any(not a or len(a) > 500 for a in command):
        raise HTTPException(400, "Enter a command as separate arguments.")
    if any(a in {";", "&&", "||", "|", ">", ">>", "<", "$("} or "\x00" in a for a in command):
        raise HTTPException(400, "Shell operators and command chaining are disabled.")
    exe, args = Path(command[0]).name.lower(), command[1:]
    if exe in {"npm", "pnpm", "yarn"} and ((len(args) == 2 and args[0] == "run" and args[1] in {"build", "test", "lint", "typecheck"}) or args in (["build"], ["test"], ["lint"])):
        return [exe, *args], 45
    if exe == "pytest" and _pytest_args_ok(args):
        return [exe, *args], 45
    if exe in {"python", "python3"} and args in (["-m", "pytest"], ["-m", "compileall", "."]):
        return [exe, *args], 45
    if exe == "git" and args in (["status", "--short", "--branch"], ["diff", "--"], ["diff", "--cached", "--"], ["branch", "--show-current"], ["log", "-n", "10", "--oneline"]):
        return [exe, *args], 15
    raise HTTPException(403, "Command not allowed. Allowed: build/test/lint/typecheck, pytest, compileall, and read-only Git status/diff/log/branch.")

def cloud_json(path: str, user_token: str, *, method: str = 'GET', payload: dict | list | None = None, prefer: str | None = None):
    base = os.getenv('CONTINUUM_SUPABASE_URL', '').strip().rstrip('/')
    public_key = os.getenv('CONTINUUM_SUPABASE_PUBLISHABLE_KEY', '').strip()
    if not base or not public_key:
        raise HTTPException(503, 'Set CONTINUUM_SUPABASE_URL and CONTINUUM_SUPABASE_PUBLISHABLE_KEY so cloud workspace operations can run.')
    parsed = urlparse(base)
    local_host = parsed.hostname in {'localhost', '127.0.0.1', '::1'}
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and local_host):
        raise HTTPException(503, 'Cloud operations require HTTPS except for local development.')
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {'', '/'}:
        raise HTTPException(503, 'CONTINUUM_SUPABASE_URL must be the project origin, without a path or credentials.')
    headers = {'apikey': public_key, 'Authorization': 'Bearer ' + user_token, 'Accept': 'application/json'}
    data = None
    if payload is not None:
        data = _json.dumps(payload).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    if prefer:
        headers['Prefer'] = prefer
    request = Request(base + path, data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=12) as response:
            raw = response.read().decode('utf-8')
            return _json.loads(raw) if raw else None
    except HTTPError as exc:
        if exc.code == 401:
            raise HTTPException(401, 'Cloud session expired. Sign in again to continue.') from exc
        if exc.code == 403:
            raise HTTPException(403, 'Cloud permission check was denied.') from exc
        if exc.code == 409:
            raise HTTPException(409, 'The cloud record was changed by another user. Refresh and try again.') from exc
        detail = exc.read().decode('utf-8', errors='replace')[:500]
        raise HTTPException(503, 'Cloud request failed (' + str(exc.code) + '): ' + detail) from exc
    except (URLError, TimeoutError, ValueError) as exc:
        raise HTTPException(503, 'Could not reach the cloud backend to verify permissions or store agent progress.') from exc


def assert_path_editable(project_id: str | None, path: str, user_token: str | None) -> None:
    if not project_id or not user_token:
        raise HTTPException(401, 'A signed-in workspace session is required for local file writes.')
    try:
        project_uuid = str(_uuid.UUID(project_id))
    except ValueError as exc:
        raise HTTPException(400, 'A valid workspace project ID is required.') from exc
    identity = cloud_json('/auth/v1/user', user_token)
    user_id = identity.get('id') if isinstance(identity, dict) else None
    if not user_id:
        raise HTTPException(401, 'Cloud session is missing or expired.')
    member_query = urlencode({'select':'user_id', 'project_id':'eq.' + project_uuid, 'user_id':'eq.' + user_id, 'limit':'1'})
    membership = cloud_json('/rest/v1/project_members?' + member_query, user_token)
    if not isinstance(membership, list) or not membership:
        raise HTTPException(403, 'This account is not a member of the selected cloud project.')
    lock_query = urlencode({'select':'id,path,reason', 'project_id':'eq.' + project_uuid, 'path':'eq.' + safe_path(path), 'is_locked':'eq.true', 'limit':'1'})
    lock_rows = cloud_json('/rest/v1/repository_path_locks?' + lock_query, user_token)
    if not isinstance(lock_rows, list) or not lock_rows:
        return
    lock_row = lock_rows[0]
    grant_query = urlencode({'select':'expires_at', 'project_id':'eq.' + project_uuid, 'resource_type':'eq.local_file', 'resource_id':'eq.' + lock_row['id'], 'user_id':'eq.' + user_id, 'permitted_action':'eq.edit', 'revoked_at':'is.null'})
    grants = cloud_json('/rest/v1/permission_grants?' + grant_query, user_token)
    now = datetime.now(timezone.utc)
    for grant in grants if isinstance(grants, list) else []:
        expires = grant.get('expires_at')
        if not expires:
            return
        try:
            if datetime.fromisoformat(expires.replace('Z', '+00:00')) > now:
                return
        except (ValueError, TypeError):
            continue
    raise HTTPException(423, 'This file is protected in the shared workspace. Ask the owner to unlock it or grant temporary edit access.')

def assert_mutating_command_allowed(project_id: str | None, user_token: str | None) -> None:
    # A build/test script can write arbitrary files; block it while any protected
    # repository path lacks an explicit grant for this signed-in user.
    assert_path_editable(project_id, '.continuum-permission-probe', user_token)
    project_uuid = str(_uuid.UUID(project_id or ''))
    lock_query = urlencode({'select':'path', 'project_id':'eq.' + project_uuid, 'is_locked':'eq.true'})
    locks = cloud_json('/rest/v1/repository_path_locks?' + lock_query, user_token or '')
    for lock in locks if isinstance(locks, list) else []:
        assert_path_editable(project_uuid, lock['path'], user_token)

class AgentStepRequest(BaseModel):
    project_id: str = Field(min_length=36, max_length=36)
    session_id: str = Field(min_length=36, max_length=36)

class AgentApplyRequest(BaseModel):
    project_id: str = Field(min_length=36, max_length=36)
    session_id: str = Field(min_length=36, max_length=36)
def load_agent_session(project_id: str, session_id: str, access_token: str) -> dict:
    query = urlencode({'select':'*','id':'eq.' + session_id,'project_id':'eq.' + project_id,'limit':'1'})
    rows = cloud_json('/rest/v1/agent_sessions?' + query, access_token)
    if not isinstance(rows, list) or not rows:
        raise HTTPException(404, 'Agent session was not found in this project.')
    return rows[0]

def session_messages(project_id: str, session_id: str, access_token: str) -> list[dict]:
    query = urlencode({'select':'id,role,actor_type,content,metadata,created_at','project_id':'eq.' + project_id,'session_id':'eq.' + session_id,'order':'created_at.desc','limit':'30'})
    rows = cloud_json('/rest/v1/agent_messages?' + query, access_token)
    return list(reversed(rows)) if isinstance(rows, list) else []

def current_cloud_user(project_id: str, access_token: str) -> str:
    identity = cloud_json('/auth/v1/user', access_token)
    user_id = identity.get('id') if isinstance(identity, dict) else None
    if not user_id:
        raise HTTPException(401, 'Cloud session is missing or expired.')
    query = urlencode({'select':'user_id','project_id':'eq.' + project_id,'user_id':'eq.' + user_id,'limit':'1'})
    member_rows = cloud_json('/rest/v1/project_members?' + query, access_token)
    if not isinstance(member_rows, list) or not member_rows:
        raise HTTPException(403, 'This account is not a member of the selected project.')
    return user_id

def local_context_files(root: Path, focus_paths: list[str]) -> tuple[str, list[str]]:
    defaults = ['README.md','package.json','pyproject.toml','apps/web/package.json','apps/web/src/App.tsx','services/api/pyproject.toml']
    candidates = focus_paths[:12] if focus_paths else defaults
    excerpts: list[str] = []
    included: list[str] = []
    remaining = 42000
    for raw_path in candidates:
        try:
            path = safe_path(raw_path)
            full = resolve_path(root, path, True)
            if not full.is_file() or full.stat().st_size > 18000:
                continue
            content = full.read_text(encoding='utf-8')
        except (HTTPException, OSError, UnicodeDecodeError):
            continue
        if not content.strip():
            continue
        if len(content.encode('utf-8')) > remaining:
            content = content[:max(0, remaining // 2)] + '\n[context excerpt truncated]'
        excerpts.append('FILE: ' + path + '\n' + content)
        included.append(path)
        remaining -= len(content.encode('utf-8'))
        if remaining <= 0:
            break
    return '\n\n'.join(excerpts), included

def build_agent_prompt(session: dict, messages: list[dict], repo_context: str, inventory: list[str]) -> str:
    role = session.get('current_agent') or 'planner'
    role_instructions = {
        'planner': 'Break the goal into a short, ordered, testable plan. Do not propose file edits yet.',
        'coder': 'Implement the next smallest useful code change. Propose complete replacement contents only for files that genuinely need changes.',
        'reviewer': 'Review the current plan and source for bugs, security risks, missing tests, and lock/permission concerns. Do not propose edits unless essential.',
        'qa': 'Recommend precise tests and acceptance checks; do not claim to have run tests.'
    }.get(role, 'Work carefully on the engineering goal.')
    history = []
    for item in messages[-18:]:
        history.append(str(item.get('role','user')).upper() + ':\n' + str(item.get('content',''))[:7000])
    parts = [
        'You are the ' + role.upper() + ' role in CONTINUUM, a collaborative engineering workspace.',
        'Role objective: ' + role_instructions,
        'GOAL:\n' + str(session.get('goal',''))[:20000],
        'CONVERSATION HISTORY (durable shared context; do not ask the user to repeat it):\n' + ('\n\n'.join(history) or '(no prior messages)'),
        'LOCAL REPOSITORY FILE INVENTORY:\n' + '\n'.join(inventory[:160]),
        'SELECTED REPOSITORY CONTEXT:\n' + (repo_context or '(No source files were selected or readable.)'),
        'Return exactly one valid JSON object with summary (string), files (array of {path,content}), next_role (planner|coder|reviewer|qa), status (needs_review|queued|completed), and review_notes (string).',
        'Max 12 full-file changes. Use safe relative paths only. Never include secrets, environment files, private keys, generated folders, .git, or dependency directories.',
        'Never claim to have applied changes, committed code, deployed, or run tests. Return proposals only; the human must click Apply.',
        'Do not return shell commands and do not execute anything. Tests are run separately through allowed worker commands.',
        'Use existing history as context and continue the work. Avoid repeating the full plan unnecessarily.'
    ]
    return '\n\n'.join(parts)

def relay_agent_status() -> dict:
    try:
        from app.agent_runtime import relay_status
        return relay_status()
    except Exception as exc:
        return {'installed':False,'configured':False,'providers':[],'message':str(exc)[:500],'failover_enabled':False}
class FileWrite(BaseModel):
    path: str = Field(min_length=1, max_length=240)
    content: str = Field(max_length=1_500_000)
class CommandRequest(BaseModel):
    command: list[str] = Field(min_length=1, max_length=20)
class CommitRequest(BaseModel):
    message: str = Field(min_length=1, max_length=160)
    paths: list[str] = Field(min_length=1, max_length=50)

@APP.get("/api/worker/health")
def health() -> dict:
    return {"status": "ok", "service": "continuum-local-worker", "version": "0.2.0", "paired": len(os.getenv("CONTINUUM_WORKER_TOKEN", "").strip()) >= 32 and bool(os.getenv("CONTINUUM_WORKSPACE_ROOT", "").strip())}

@APP.get("/api/worker/workspace", dependencies=[Depends(require_token)])
def workspace() -> dict:
    root = root_path()
    branch = run_process(["git", "branch", "--show-current"], root, 5)
    return {"name": root.name, "branch": branch["output"].strip() if branch["exit_code"] == 0 else "not a Git repository"}

@APP.get("/api/worker/files", dependencies=[Depends(require_token)])
def files() -> dict:
    root, result = root_path(), []
    for current, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d.lower() not in IGNORED and not (Path(current) / d).is_symlink())
        for name in sorted(names):
            full = Path(current) / name
            relative = full.relative_to(root).as_posix()
            try:
                safe_path(relative)
                if full.is_symlink() or not full.is_file() or full.stat().st_size > MAX_FILE_BYTES:
                    continue
            except HTTPException:
                continue
            result.append({"path": relative, "size": full.stat().st_size, "extension": full.suffix.lower().lstrip(".") or "text"})
            if len(result) >= 2000:
                return {"files": result, "truncated": True}
    result.sort(key=lambda item: item["path"].lower())
    return {"files": result, "truncated": False}

@APP.get("/api/worker/file", dependencies=[Depends(require_token)])
def read_file(path: Annotated[str, Query(min_length=1, max_length=240)]) -> dict:
    root = root_path()
    target = resolve_path(root, path, True)
    if not target.is_file():
        raise HTTPException(400, "Path is not a file.")
    if target.stat().st_size > MAX_FILE_BYTES:
        raise HTTPException(413, "File exceeds the 1.5 MB limit.")
    try:
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(415, "File is not UTF-8 text.") from exc
    return {"path": safe_path(path), "content": content, "size": target.stat().st_size}

@APP.put("/api/worker/file", dependencies=[Depends(require_token)])
def write_file(body: FileWrite, x_continuum_project_id: Annotated[str | None, Header()] = None, x_continuum_user_token: Annotated[str | None, Header()] = None) -> dict:
    root = root_path()
    target = resolve_path(root, body.path)
    if target.exists() and not target.is_file():
        raise HTTPException(400, "Path is not a file.")
    if len(body.content.encode("utf-8")) > MAX_FILE_BYTES:
        raise HTTPException(413, "File exceeds the 1.5 MB limit.")
    assert_path_editable(x_continuum_project_id, body.path, x_continuum_user_token)
    target.parent.mkdir(parents=True, exist_ok=True)
    target = resolve_path(root, body.path)
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, prefix=".continuum-", suffix=".tmp", delete=False) as temp:
            temp_name = temp.name
            temp.write(body.content)
        _os.replace(temp_name, target)
    finally:
        if temp_name and Path(temp_name).exists():
            Path(temp_name).unlink(missing_ok=True)
    return {"path": safe_path(body.path), "size": target.stat().st_size, "saved": True}

@APP.post("/api/worker/file", dependencies=[Depends(require_token)])
def create_file(body: FileWrite, x_continuum_project_id: Annotated[str | None, Header()] = None, x_continuum_user_token: Annotated[str | None, Header()] = None) -> dict:
    root = root_path()
    target = resolve_path(root, body.path)
    if len(body.content.encode("utf-8")) > MAX_FILE_BYTES:
        raise HTTPException(413, "File exceeds the 1.5 MB limit.")
    assert_path_editable(x_continuum_project_id, body.path, x_continuum_user_token)
    target.parent.mkdir(parents=True, exist_ok=True)
    target = resolve_path(root, body.path)
    try:
        with target.open("x", encoding="utf-8", newline="") as handle:
            handle.write(body.content)
    except FileExistsError as exc:
        raise HTTPException(409, "That file already exists. Open it to edit rather than creating it again.") from exc
    return {"path": safe_path(body.path), "size": target.stat().st_size, "created": True}

@APP.get("/api/worker/agents/status", dependencies=[Depends(require_token)])
def agent_status() -> dict:
    return relay_agent_status()

@APP.post("/api/worker/agents/run-step", dependencies=[Depends(require_token)])
async def run_agent_step(body: AgentStepRequest, x_continuum_project_id: Annotated[str | None, Header()] = None, x_continuum_user_token: Annotated[str | None, Header()] = None) -> dict:
    if not x_continuum_user_token or body.project_id != x_continuum_project_id:
        raise HTTPException(401, "A signed-in project session is required.")
    user_id = current_cloud_user(body.project_id, x_continuum_user_token)
    session = load_agent_session(body.project_id, body.session_id, x_continuum_user_token)
    if session.get("status") != "queued":
        raise HTTPException(409, "Queue this session before running the next step.")
    claim_query = urlencode({"id":"eq." + body.session_id,"project_id":"eq." + body.project_id,"status":"eq.queued"})
    claimed = cloud_json("/rest/v1/agent_sessions?" + claim_query, x_continuum_user_token, method="PATCH", payload={"status":"running","claimed_by":user_id,"started_at":datetime.now(timezone.utc).isoformat(),"last_error":None}, prefer="return=representation")
    if not isinstance(claimed, list) or not claimed:
        raise HTTPException(409, "Another worker claimed this session. Refresh before retrying.")
    run_row = None
    try:
        run_result = cloud_json("/rest/v1/agent_runs", x_continuum_user_token, method="POST", payload={"project_id":body.project_id,"session_id":body.session_id,"agent_name":session.get("current_agent","planner"),"runtime":"relay-local-worker","status":"running","requested_by":user_id,"started_at":datetime.now(timezone.utc).isoformat(),"checkpoint":{"session_id":body.session_id}}, prefer="return=representation")
        run_row = run_result[0] if isinstance(run_result, list) and run_result else None
        messages = session_messages(body.project_id, body.session_id, x_continuum_user_token)
        root = root_path()
        repo_context, included_paths = local_context_files(root, list(session.get("focus_paths") or []))
        inventory = [str(item["path"]) for item in (files().get("files") or [])[:160]]
        from app.agent_runtime import generate_with_relay, parse_agent_payload
        prompt = build_agent_prompt(session, messages, repo_context, inventory)
        generated = await generate_with_relay(prompt, metadata={"project_id":body.project_id,"session_id":body.session_id,"agent_role":session.get("current_agent","planner")})
        proposal = parse_agent_payload(generated["text"])
        checked_files = []
        total_bytes = 0
        for item in proposal["files"]:
            path = safe_path(item["path"])
            if is_automation_path(path):
                raise HTTPException(403, "The agent proposed a CI, git-hook, or editor-task file, which is blocked: " + path)
            byte_count = len(item["content"].encode("utf-8"))
            if byte_count > MAX_FILE_BYTES:
                raise HTTPException(413, "A proposed file exceeds the 1.5 MB limit.")
            total_bytes += byte_count
            if total_bytes > 3000000:
                raise HTTPException(413, "The total proposed patch exceeds 3 MB.")
            checked_files.append({"path":path,"content":item["content"]})
        final_status = "needs_review" if checked_files or proposal["status"] != "completed" else "completed"
        message_content = _json.dumps({**proposal,"files":checked_files},ensure_ascii=False)
        cloud_json("/rest/v1/agent_messages", x_continuum_user_token, method="POST", payload={"project_id":body.project_id,"session_id":body.session_id,"run_id":run_row.get("id") if run_row else None,"role":"assistant","actor_type":"agent","actor_id":user_id,"content":message_content,"metadata":{"provider":generated["provider"],"model":generated["model"],"latency_ms":generated.get("latency_ms"),"attempts":generated.get("attempts"),"fallback_used":generated.get("fallback_used"),"included_paths":included_paths}}, prefer="return=representation")
        checkpoint = {"last_run_id":run_row.get("id") if run_row else None,"summary":proposal["summary"],"provider":generated["provider"],"model":generated["model"],"proposed_paths":[x["path"] for x in checked_files],"updated_at":datetime.now(timezone.utc).isoformat()}
        cloud_json("/rest/v1/agent_sessions?id=eq." + body.session_id, x_continuum_user_token, method="PATCH", payload={"status":final_status,"current_agent":proposal["next_role"],"claimed_by":None,"checkpoint":checkpoint,"last_error":None,"finished_at":datetime.now(timezone.utc).isoformat() if final_status=="completed" else None}, prefer="return=representation")
        if run_row:
            run_status = "needs_review" if checked_files else ("completed" if final_status=="completed" else "checkpointed")
            cloud_json("/rest/v1/agent_runs?id=eq." + run_row["id"], x_continuum_user_token, method="PATCH", payload={"status":run_status,"model_provider":generated["provider"],"model_id":generated["model"],"checkpoint":checkpoint,"usage":{"latency_ms":generated.get("latency_ms"),"attempts":generated.get("attempts"),"fallback_used":generated.get("fallback_used"),"input_tokens":generated.get("input_tokens"),"output_tokens":generated.get("output_tokens")},"finished_at":datetime.now(timezone.utc).isoformat()}, prefer="return=representation")
        return {"session_id":body.session_id,"status":final_status,"summary":proposal["summary"],"next_role":proposal["next_role"],"files":[x["path"] for x in checked_files],"provider":generated["provider"],"model":generated["model"],"attempts":generated.get("attempts"),"fallback_used":generated.get("fallback_used")}
    except Exception as exc:
        error_text = str(exc.detail) if isinstance(exc, HTTPException) else str(exc)
        try:
            cloud_json("/rest/v1/agent_sessions?id=eq." + body.session_id, x_continuum_user_token, method="PATCH", payload={"status":"failed","claimed_by":None,"last_error":error_text[:3000]}, prefer="return=representation")
            if run_row:
                cloud_json("/rest/v1/agent_runs?id=eq." + run_row["id"], x_continuum_user_token, method="PATCH", payload={"status":"failed","last_error":error_text[:3000],"finished_at":datetime.now(timezone.utc).isoformat()}, prefer="return=representation")
        except Exception:
            pass
        if isinstance(exc, HTTPException): raise
        raise HTTPException(502, "RELAY step failed. Session history remains saved; retry after fixing the reported issue.") from exc

@APP.post("/api/worker/agents/apply-proposal", dependencies=[Depends(require_token)])
def apply_agent_proposal(body: AgentApplyRequest, x_continuum_project_id: Annotated[str | None, Header()] = None, x_continuum_user_token: Annotated[str | None, Header()] = None) -> dict:
    if not x_continuum_user_token or body.project_id != x_continuum_project_id:
        raise HTTPException(401, "A signed-in project session is required.")
    user_id = current_cloud_user(body.project_id, x_continuum_user_token)
    session = load_agent_session(body.project_id, body.session_id, x_continuum_user_token)
    if session.get("status") != "needs_review":
        raise HTTPException(409, "The agent session has no proposal awaiting review.")
    messages = session_messages(body.project_id, body.session_id, x_continuum_user_token)
    latest = next((item for item in reversed(messages) if item.get("role")=="assistant"), None)
    if not latest: raise HTTPException(404, "No agent proposal was found.")
    from app.agent_runtime import parse_agent_payload
    try: proposal = parse_agent_payload(latest.get("content",""))
    except ValueError as exc: raise HTTPException(422, "The latest message is not a valid proposal.") from exc
    if not proposal["files"]: raise HTTPException(400, "This agent response contains no file changes to apply.")
    root = root_path()
    normalized = []
    total_bytes = 0
    for item in proposal["files"]:
        path = safe_path(item["path"])
        if is_automation_path(path):
            raise HTTPException(403, "Agent proposals cannot modify CI, git-hook, or editor-task files: " + path)
        content = item["content"]
        size = len(content.encode("utf-8"))
        total_bytes += size
        if size > MAX_FILE_BYTES or total_bytes > 3000000: raise HTTPException(413, "Proposed file changes exceed the size limit.")
        assert_path_editable(body.project_id, path, x_continuum_user_token)
        target = resolve_path(root, path)
        if target.exists() and not target.is_file(): raise HTTPException(400, "A proposed path is not a regular file: " + path)
        normalized.append({"path":path,"target":target,"content":content})
    backups = {item["path"]:(item["target"].read_bytes() if item["target"].exists() else None) for item in normalized}
    written = []
    try:
        for item in normalized:
            target = item["target"]
            target.parent.mkdir(parents=True,exist_ok=True)
            target = resolve_path(root,item["path"])
            temp_name = None
            try:
                with tempfile.NamedTemporaryFile(mode="w",encoding="utf-8",dir=target.parent,prefix=".continuum-agent-",suffix=".tmp",delete=False) as temp:
                    temp_name = temp.name
                    temp.write(item["content"])
                _os.replace(temp_name,target)
            finally:
                if temp_name and Path(temp_name).exists(): Path(temp_name).unlink(missing_ok=True)
            written.append(item["path"])
    except Exception as exc:
        for path in reversed(written):
            target = root.joinpath(*path.split("/"))
            old = backups.get(path)
            try:
                if old is None: target.unlink(missing_ok=True)
                else: target.write_bytes(old)
            except OSError:
                pass
        raise HTTPException(500, "Proposal apply failed; rollback was attempted. Inspect Git diff before retrying.") from exc
    note = "Applied " + str(len(written)) + " proposed file(s) to the local checkout: " + ", ".join(written) + ". Changes remain uncommitted; inspect Git diff and run checks."
    cloud_json("/rest/v1/agent_messages", x_continuum_user_token, method="POST", payload={"project_id":body.project_id,"session_id":body.session_id,"role":"tool","actor_type":"human","actor_id":user_id,"content":note,"metadata":{"action":"apply_proposal","paths":written}}, prefer="return=representation")
    return {"session_id":body.session_id,"applied":written,"committed":False,"pushed":False,"message":note}

@APP.get("/api/worker/git/status", dependencies=[Depends(require_token)])
def git_status() -> dict:
    return run_process(["git", "status", "--short", "--branch"], root_path(), 10)

@APP.get("/api/worker/git/diff", dependencies=[Depends(require_token)])
def git_diff(cached: bool = False) -> dict:
    return run_process(["git", "diff", "--cached", "--"] if cached else ["git", "diff", "--"], root_path(), 10)

@APP.post("/api/worker/run", dependencies=[Depends(require_token)])
def run(body: CommandRequest, x_continuum_project_id: Annotated[str | None, Header()] = None, x_continuum_user_token: Annotated[str | None, Header()] = None) -> dict:
    args, timeout = checked_command(body.command)
    read_only_git = args[0] == "git" and len(args) > 1 and args[1] in {"status", "diff", "branch", "log"}
    if not read_only_git:
        assert_mutating_command_allowed(x_continuum_project_id, x_continuum_user_token)
    return run_process(args, root_path(), timeout)

@APP.post("/api/worker/git/commit", dependencies=[Depends(require_token)])
def commit(body: CommitRequest, x_continuum_project_id: Annotated[str | None, Header()] = None, x_continuum_user_token: Annotated[str | None, Header()] = None) -> dict:
    root = root_path()
    message = body.message.strip()
    if not message or "\n" in message or "\r" in message:
        raise HTTPException(400, "Commit message must be one line.")
    paths = list(dict.fromkeys(safe_path(p) for p in body.paths))
    for path in paths:
        resolve_path(root, path, True)
        assert_path_editable(x_continuum_project_id, path, x_continuum_user_token)
    staged = run_process(["git", "diff", "--cached", "--"], root, 10)
    if staged["exit_code"] != 0:
        return staged
    if staged["output"].strip():
        raise HTTPException(409, "There are already staged changes. Commit or unstage them manually first.")
    added = run_process(["git", "add", "--", *paths], root, 15)
    if added["exit_code"] != 0:
        return added
    result = run_process(["git", "commit", "-m", message], root, 20)
    return {**result, "pushed": False}
