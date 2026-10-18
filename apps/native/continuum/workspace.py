"""Safe filesystem primitives used by the native local workspace."""
from __future__ import annotations

from pathlib import Path

MAX_TEXT_BYTES = 2 * 1024 * 1024
IGNORED_DIRS = {
    ".git", ".hg", ".svn", ".venv", "venv", "node_modules",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    "dist", "build", ".next", ".idea", ".vs",
}
_SECRET_NAMES = {
    ".env", ".env.local", ".env.production", ".npmrc", ".pypirc",
    "credentials.json", "service-account.json", "id_rsa", "id_ed25519",
}
_SECRET_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".keystore"}


class WorkspaceError(ValueError):
    """A workspace path is invalid or not safe to edit."""


def is_sensitive_path(relative: str | Path) -> bool:
    parts = Path(relative).parts
    for part in parts:
        low = part.lower()
        if low in _SECRET_NAMES or low.startswith(".env.") or low in {".ssh", ".aws", ".azure", ".gnupg"}:
            return True
        if Path(low).suffix in _SECRET_SUFFIXES:
            return True
        if low.endswith("_secret") or low.endswith("_credentials"):
            return True
    return False


def safe_file_path(root: str | Path, relative: str | Path, *, allow_sensitive: bool = False) -> Path:
    """Resolve a relative workspace file and reject traversal and symlink escapes."""
    base = Path(root).expanduser().resolve(strict=True)
    if not base.is_dir():
        raise WorkspaceError("Workspace root must be a directory.")
    raw = str(relative).strip()
    if not raw or "\x00" in raw:
        raise WorkspaceError("A relative file path is required.")
    candidate_input = Path(raw)
    if candidate_input.is_absolute() or any(part in {"..", "."} for part in candidate_input.parts):
        raise WorkspaceError("Only normalized relative paths inside the workspace are allowed.")
    if not allow_sensitive and is_sensitive_path(candidate_input):
        raise WorkspaceError("Secret and credential files are hidden from the workspace editor.")
    current = base
    for part in candidate_input.parts:
        current = current / part
        if current.exists() and current.is_symlink():
            raise WorkspaceError("Symbolic links are not editable from the workspace.")
    candidate = current.resolve(strict=False)
    try:
        candidate.relative_to(base)
    except ValueError as exc:
        raise WorkspaceError("The path resolves outside the selected workspace.") from exc
    return candidate


def should_ignore_path(relative: str | Path) -> bool:
    parts = Path(relative).parts
    if not parts:
        return False
    if any(part in IGNORED_DIRS for part in parts):
        return True
    if is_sensitive_path(relative):
        return True
    return any(part.endswith((".pyc", ".pyo", ".class", ".o", ".obj", ".dll", ".exe")) for part in parts)


def read_text_file(path: str | Path) -> str:
    file_path = Path(path)
    if not file_path.is_file():
        raise WorkspaceError("Select a regular file.")
    if file_path.stat().st_size > MAX_TEXT_BYTES:
        raise WorkspaceError("Files larger than 2 MiB are not opened in the text editor.")
    data = file_path.read_bytes()
    if b"\x00" in data:
        raise WorkspaceError("This appears to be a binary file.")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise WorkspaceError("Only UTF-8 text files are supported in the built-in editor.") from exc
