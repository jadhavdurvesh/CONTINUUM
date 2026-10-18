from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from fastapi import HTTPException
from app.main import APP, safe_path, checked_command

client = TestClient(APP)

@pytest.fixture(autouse=True)
def worker_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CONTINUUM_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("CONTINUUM_WORKER_TOKEN", "test-token-" + "x" * 40)
    monkeypatch.setenv("CONTINUUM_ALLOWED_ORIGINS", "http://localhost:5173")
    (tmp_path / "hello.py").write_text("print('hello')\n", encoding="utf-8")
    (tmp_path / ".env").write_text("SECRET=do-not-show\n", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "ignored.js").write_text("ignored", encoding="utf-8")

def auth():
    return {"Authorization": "Bearer " + "test-token-" + "x" * 40}

def test_health_does_not_disclose_workspace_path():
    response = client.get("/api/worker/health")
    assert response.status_code == 200
    assert response.json()["paired"] is True
    assert "root" not in response.json()

def test_workspace_endpoints_require_token():
    assert client.get("/api/worker/files").status_code == 401
    assert client.get("/api/worker/files", headers={"Authorization": "Bearer wrong"}).status_code == 401

def test_lists_and_reads_workspace_files_without_secrets():
    listed = client.get("/api/worker/files", headers=auth())
    assert listed.status_code == 200
    assert [entry["path"] for entry in listed.json()["files"]] == ["hello.py"]
    read = client.get("/api/worker/file", params={"path": "hello.py"}, headers=auth())
    assert read.status_code == 200
    assert "hello" in read.json()["content"]
    assert client.get("/api/worker/file", params={"path": ".env"}, headers=auth()).status_code == 403

def test_rejects_traversal_and_secret_paths():
    for path in ("../outside.txt", "/etc/passwd", "src/../../outside", ".env", "private.pem"):
        with pytest.raises(HTTPException):
            safe_path(path)

def test_writes_only_inside_workspace(tmp_path: Path):
    response = client.put("/api/worker/file", headers=auth(), json={"path": "src/new.py", "content": "print('ok')"})
    assert response.status_code == 200
    assert (tmp_path / "src" / "new.py").read_text(encoding="utf-8") == "print('ok')"
    response2 = client.put("/api/worker/file", headers=auth(), json={"path": "src/new.py", "content": "print('updated')"})
    assert response2.status_code == 200
    assert (tmp_path / "src" / "new.py").read_text(encoding="utf-8") == "print('updated')"

def test_create_endpoint_never_overwrites_existing_file(tmp_path: Path):
    created = client.post("/api/worker/file", headers=auth(), json={"path": "fresh.py", "content": "print('fresh')"})
    assert created.status_code == 200
    conflict = client.post("/api/worker/file", headers=auth(), json={"path": "fresh.py", "content": "overwrite"})
    assert conflict.status_code == 409
    assert (tmp_path / "fresh.py").read_text(encoding="utf-8") == "print('fresh')"

def test_shell_chaining_and_unapproved_commands_are_rejected():
    for command in (["python", "-c", "import os"], ["npm", "run", "build", "&&", "whoami"], ["curl", "https://example.com"]):
        with pytest.raises(HTTPException):
            checked_command(command)
    assert checked_command(["npm", "run", "build"])[0] == ["npm", "run", "build"]
    assert checked_command(["git", "status", "--short", "--branch"])[0] == ["git", "status", "--short", "--branch"]

def test_cors_allows_only_configured_origin():
    response = client.options("/api/worker/files", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert response.headers.get("access-control-allow-credentials") != "true"

def test_private_network_header_only_for_configured_origin():
    allowed = client.options("/api/worker/files", headers={
        "Origin": "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
        "Access-Control-Request-Private-Network": "true",
    })
    assert allowed.status_code == 200
    assert allowed.headers.get("access-control-allow-private-network") == "true"
    denied = client.options("/api/worker/files", headers={
        "Origin": "https://untrusted.example",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
        "Access-Control-Request-Private-Network": "true",
    })
    assert denied.headers.get("access-control-allow-private-network") is None
