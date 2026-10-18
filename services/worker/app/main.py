"""Local-only companion worker for the CONTINUUM IDE.
Run: uvicorn app.main:APP --host 127.0.0.1 --port 4318
Set CONTINUUM_WORKSPACE_ROOT and a random CONTINUUM_WORKER_TOKEN first.
"""
from __future__ import annotations
import hmac
import os
import re
import subprocess
import os as _os
import tempfile
from pathlib import Path
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
origins = [x.strip().rstrip("/") for x in os.getenv("CONTINUUM_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if x.strip()]
APP.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False, allow_methods=["GET", "POST", "PUT", "OPTIONS"], allow_headers=["Authorization", "Content-Type", "Access-Control-Request-Private-Network"], max_age=600)

@APP.middleware("http")
async def allow_private_network_access_for_approved_origins(request, call_next):
    # HTTPS-hosted browser frontends may preflight requests to a loopback worker.
    # Only echo this opt-in for origins explicitly configured by the operator.
    response = await call_next(request)
    origin = request.headers.get("origin", "").rstrip("/")
    wants_local_network = request.headers.get("access-control-request-private-network", "").lower() == "true"
    if wants_local_network and origin in origins:
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response

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
        result = subprocess.run(args, cwd=root, shell=False, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", timeout=timeout, env={**os.environ, "CI": "1", "GIT_TERMINAL_PROMPT": "0"})
        return {"exit_code": result.returncode, "output": result.stdout[-MAX_OUTPUT:], "truncated": len(result.stdout) > MAX_OUTPUT}
    except FileNotFoundError:
        return {"exit_code": 127, "output": "Executable not found: " + args[0], "truncated": False}
    except subprocess.TimeoutExpired:
        return {"exit_code": 124, "output": "Command timed out after " + str(timeout) + " seconds.", "truncated": True}

def checked_command(command: list[str]) -> tuple[list[str], int]:
    if not command or len(command) > 20 or any(not a or len(a) > 500 for a in command):
        raise HTTPException(400, "Enter a command as separate arguments.")
    if any(a in {";", "&&", "||", "|", ">", ">>", "<", "$("} or "\x00" in a for a in command):
        raise HTTPException(400, "Shell operators and command chaining are disabled.")
    exe, args = Path(command[0]).name.lower(), command[1:]
    if exe in {"npm", "pnpm", "yarn"} and ((len(args) == 2 and args[0] == "run" and args[1] in {"build", "test", "lint", "typecheck"}) or args in (["build"], ["test"], ["lint"])):
        return [exe, *args], 45
    if exe == "pytest" and all(".." not in Path(a).parts and not a.startswith("/") for a in args):
        return [exe, *args], 45
    if exe in {"python", "python3"} and args in (["-m", "pytest"], ["-m", "compileall", "."]):
        return [exe, *args], 45
    if exe == "git" and args in (["status", "--short", "--branch"], ["diff", "--"], ["diff", "--cached", "--"], ["branch", "--show-current"], ["log", "-n", "10", "--oneline"]):
        return [exe, *args], 15
    raise HTTPException(403, "Command not allowed. Allowed: build/test/lint/typecheck, pytest, compileall, and read-only Git status/diff/log/branch.")

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
def write_file(body: FileWrite) -> dict:
    root = root_path()
    target = resolve_path(root, body.path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target = resolve_path(root, body.path)
    if target.exists() and not target.is_file():
        raise HTTPException(400, "Path is not a file.")
    if len(body.content.encode("utf-8")) > MAX_FILE_BYTES:
        raise HTTPException(413, "File exceeds the 1.5 MB limit.")
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
def create_file(body: FileWrite) -> dict:
    root = root_path()
    target = resolve_path(root, body.path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target = resolve_path(root, body.path)
    if len(body.content.encode("utf-8")) > MAX_FILE_BYTES:
        raise HTTPException(413, "File exceeds the 1.5 MB limit.")
    try:
        with target.open("x", encoding="utf-8", newline="") as handle:
            handle.write(body.content)
    except FileExistsError as exc:
        raise HTTPException(409, "That file already exists. Open it to edit rather than creating it again.") from exc
    return {"path": safe_path(body.path), "size": target.stat().st_size, "created": True}

@APP.get("/api/worker/git/status", dependencies=[Depends(require_token)])
def git_status() -> dict:
    return run_process(["git", "status", "--short", "--branch"], root_path(), 10)

@APP.get("/api/worker/git/diff", dependencies=[Depends(require_token)])
def git_diff(cached: bool = False) -> dict:
    return run_process(["git", "diff", "--cached", "--"] if cached else ["git", "diff", "--"], root_path(), 10)

@APP.post("/api/worker/run", dependencies=[Depends(require_token)])
def run(body: CommandRequest) -> dict:
    args, timeout = checked_command(body.command)
    return run_process(args, root_path(), timeout)

@APP.post("/api/worker/git/commit", dependencies=[Depends(require_token)])
def commit(body: CommitRequest) -> dict:
    root = root_path()
    message = body.message.strip()
    if not message or "\n" in message or "\r" in message:
        raise HTTPException(400, "Commit message must be one line.")
    paths = list(dict.fromkeys(safe_path(p) for p in body.paths))
    for path in paths:
        resolve_path(root, path, True)
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
