from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from fastapi import HTTPException
from app.main import APP, safe_path, checked_command
from app.agent_runtime import parse_agent_payload
import app.main as worker_module

client = TestClient(APP)

@pytest.fixture(autouse=True)
def worker_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CONTINUUM_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("CONTINUUM_WORKER_TOKEN", "test-token-" + "x" * 40)
    monkeypatch.setenv("CONTINUUM_ALLOWED_ORIGINS", "http://localhost:5173")
    monkeypatch.setattr(worker_module, "assert_path_editable", lambda *args, **kwargs: None)
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
    assert denied.status_code == 400
    assert denied.headers.get("access-control-allow-origin") is None

def test_cloud_path_guard_rejects_locked_file_before_local_write(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    def block(*args, **kwargs):
        raise HTTPException(423, 'protected in cloud')
    monkeypatch.setattr(worker_module, 'assert_path_editable', block)
    response = client.put('/api/worker/file', headers=auth(), json={'path':'hello.py','content':'changed'})
    assert response.status_code == 423
    assert (tmp_path / 'hello.py').read_text(encoding='utf-8') == "print('hello')\n"


def test_agent_payload_parser_accepts_valid_proposal_and_normalizes_fields():
    data = parse_agent_payload('{"summary":"Plan complete","files":[{"path":"src/main.py","content":"print(1)"}],"next_role":"reviewer","status":"needs_review","review_notes":"Review test coverage"}')
    assert data["summary"] == "Plan complete"
    assert data["files"][0]["path"] == "src/main.py"
    assert data["next_role"] == "reviewer"
    assert data["status"] == "needs_review"

def test_agent_payload_parser_rejects_invalid_file_entries():
    with pytest.raises(ValueError):
        parse_agent_payload('{"summary":"oops","files":[{"path":"x.py"}]}')

def test_agent_payload_parser_accepts_fenced_json():
    fence = chr(96) * 3
    raw = fence + 'json\n{"summary":"hello","files":[],"next_role":"coder","status":"queued"}\n' + fence
    data = parse_agent_payload(raw)
    assert data["summary"] == "hello"
    assert data["next_role"] == "coder"


def test_pytest_arguments_are_allowlisted():
    ok, _ = checked_command(["pytest", "-q", "tests/test_a.py::test_x"])
    assert ok[0] == "pytest"
    for args in (["--basetemp=/home/user"], ["--basetemp=.."], ["-p", "evil"], ["-c", "x.ini"], ["--rootdir=/"], ["-o", "addopts=x"],
                 ["../outside.py"], ["/etc/passwd"], ["C:\\x.py"], ["--import-mode=importlib"]):
        with pytest.raises(HTTPException):
            checked_command(["pytest", *args])


def test_agent_prompt_uses_real_newlines():
    prompt = worker_module.build_agent_prompt(
        {"goal": "do it", "current_agent": "coder"}, [{"role": "user", "content": "hi"}], "FILE: a\nx", ["a"])
    assert "\\n" not in prompt
    assert "\n\n" in prompt


def test_automation_paths_are_detected():
    for path in (".github/workflows/ci.yml", ".husky/pre-commit", ".vscode/tasks.json", "sub/.githooks/x", ".gitmodules"):
        assert worker_module.is_automation_path(path)
    assert not worker_module.is_automation_path("docs/github.md")


def test_child_processes_do_not_inherit_worker_secrets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CONTINUUM_WORKER_TOKEN", "super-secret-" + "x" * 40)
    result = worker_module.run_process(["python3", "-c", "import os;print(os.environ.get('CONTINUUM_WORKER_TOKEN','absent'))"], tmp_path, 10)
    assert result["output"].strip() == "absent"


# ---------------------------------------------------------------------------------------------
# Workspace bridge: context preview, diff preview, selective + staleness-checked apply
# ---------------------------------------------------------------------------------------------
import json as _json

PROJECT = "11111111-1111-1111-1111-111111111111"
SESSION = "22222222-2222-2222-2222-222222222222"
CLOUD_HEADERS = {"X-Continuum-Project-Id": PROJECT, "X-Continuum-User-Token": "user-jwt"}


def bridge_headers():
    return {**auth(), **CLOUD_HEADERS}


@pytest.fixture
def cloud(monkeypatch: pytest.MonkeyPatch):
    state = {"status": "needs_review", "focus": ["hello.py", ".env", "missing.py"], "posted": []}
    proposal = {"summary": "tweak", "next_role": "reviewer", "status": "needs_review", "files": [
        {"path": "hello.py", "content": "print('hello world')\n"},
        {"path": "src/new.py", "content": "VALUE = 1\n"},
        {"path": "same.txt", "content": "unchanged\n"},
    ]}
    state["proposal"] = proposal
    monkeypatch.setattr(worker_module, "current_cloud_user", lambda project_id, token: "user-1")
    monkeypatch.setattr(worker_module, "load_agent_session", lambda project_id, session_id, token: {"status": state["status"], "focus_paths": state["focus"]})
    monkeypatch.setattr(worker_module, "session_messages", lambda project_id, session_id, token: [
        {"role": "user", "content": "go"}, {"role": "assistant", "content": _json.dumps(state["proposal"])}])
    monkeypatch.setattr(worker_module, "cloud_json", lambda path, token, method="GET", payload=None, **kw: state["posted"].append((path, payload)) or [])
    return state


def body(**extra):
    return {"project_id": PROJECT, "session_id": SESSION, **extra}


def test_context_preview_lists_only_files_that_would_be_sent(cloud):
    response = client.post("/api/worker/agents/context", json=body(), headers=bridge_headers())
    assert response.status_code == 200
    data = response.json()
    assert [item["path"] for item in data["files"]] == ["hello.py"]          # .env (secret) and missing.py are never sent
    assert set(data["skipped"]) == {".env", "missing.py"}
    assert data["total_bytes"] > 0 and data["using_defaults"] is False


def test_preview_requires_signed_in_project_session(cloud):
    assert client.post("/api/worker/agents/preview", json=body(), headers=auth()).status_code == 401
    wrong = {**auth(), "X-Continuum-Project-Id": "33333333-3333-3333-3333-333333333333", "X-Continuum-User-Token": "t"}
    assert client.post("/api/worker/agents/preview", json=body(), headers=wrong).status_code == 401


def test_preview_shows_diffs_and_never_writes(cloud, tmp_path: Path):
    (tmp_path / "same.txt").write_text("unchanged\n", encoding="utf-8")
    before = (tmp_path / "hello.py").read_text(encoding="utf-8")
    response = client.post("/api/worker/agents/preview", json=body(), headers=bridge_headers())
    assert response.status_code == 200
    by_path = {item["path"]: item for item in response.json()["files"]}
    assert by_path["hello.py"]["status"] == "modified" and by_path["hello.py"]["additions"] == 1 and by_path["hello.py"]["deletions"] == 1
    assert "+print('hello world')" in by_path["hello.py"]["diff"]
    assert by_path["hello.py"]["base_hash"]
    assert by_path["src/new.py"]["status"] == "new" and by_path["src/new.py"]["base_hash"] is None
    assert by_path["same.txt"]["status"] == "unchanged"
    assert (tmp_path / "hello.py").read_text(encoding="utf-8") == before and not (tmp_path / "src").exists()


def test_preview_flags_blocked_files_instead_of_failing(cloud, monkeypatch: pytest.MonkeyPatch):
    cloud["proposal"]["files"].append({"path": "pkg/readme.md", "content": "x"})
    def deny(project_id, path, token):
        if path == "pkg/readme.md":
            raise HTTPException(423, "pkg/readme.md is locked by the project owner.")
    monkeypatch.setattr(worker_module, "assert_path_editable", deny)
    response = client.post("/api/worker/agents/preview", json=body(), headers=bridge_headers())
    blocked = {item["path"]: item["blocked"] for item in response.json()["files"]}
    assert "locked" in blocked["pkg/readme.md"] and blocked["hello.py"] is None


def test_apply_selected_files_only_and_posts_audit_message(cloud, tmp_path: Path):
    preview = client.post("/api/worker/agents/preview", json=body(), headers=bridge_headers()).json()
    hashes = {item["path"]: item["base_hash"] for item in preview["files"]}
    response = client.post("/api/worker/agents/apply-proposal", json=body(paths=["src/new.py"], base_hashes=hashes), headers=bridge_headers())
    assert response.status_code == 200, response.text
    assert response.json()["applied"] == ["src/new.py"]
    assert (tmp_path / "src" / "new.py").read_text(encoding="utf-8") == "VALUE = 1\n"
    assert (tmp_path / "hello.py").read_text(encoding="utf-8") == "print('hello')\n"      # not selected -> untouched
    path, payload = cloud["posted"][-1]
    assert path.endswith("/agent_messages") and payload["actor_id"] == "user-1" and payload["role"] == "tool"


def test_apply_without_selection_keeps_old_behaviour(cloud, tmp_path: Path):
    response = client.post("/api/worker/agents/apply-proposal", json=body(), headers=bridge_headers())
    assert response.status_code == 200, response.text
    assert set(response.json()["applied"]) == {"hello.py", "src/new.py", "same.txt"}


def test_apply_refuses_a_file_that_changed_after_review(cloud, tmp_path: Path):
    preview = client.post("/api/worker/agents/preview", json=body(), headers=bridge_headers()).json()
    hashes = {item["path"]: item["base_hash"] for item in preview["files"]}
    (tmp_path / "hello.py").write_text("print('edited by a human meanwhile')\n", encoding="utf-8")
    response = client.post("/api/worker/agents/apply-proposal", json=body(paths=["hello.py"], base_hashes=hashes), headers=bridge_headers())
    assert response.status_code == 409 and "changed after you reviewed" in response.json()["detail"]
    assert "edited by a human meanwhile" in (tmp_path / "hello.py").read_text(encoding="utf-8")
    # a new file appearing where the review saw none is also a change
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "new.py").write_text("OTHER = 2\n", encoding="utf-8")
    assert client.post("/api/worker/agents/apply-proposal", json=body(paths=["src/new.py"], base_hashes=hashes), headers=bridge_headers()).status_code == 409


def test_apply_requires_hash_for_every_selected_file(cloud):
    response = client.post("/api/worker/agents/apply-proposal", json=body(paths=["hello.py"], base_hashes={}), headers=bridge_headers())
    assert response.status_code == 409 and "out of date" in response.json()["detail"]


def test_apply_rejects_unknown_empty_and_blocked_selection(cloud):
    assert client.post("/api/worker/agents/apply-proposal", json=body(paths=["not-in-proposal.py"]), headers=bridge_headers()).status_code == 400
    assert client.post("/api/worker/agents/apply-proposal", json=body(paths=[]), headers=bridge_headers()).status_code == 400
    cloud["proposal"]["files"].append({"path": ".github/workflows/x.yml", "content": "on: push"})
    assert client.post("/api/worker/agents/apply-proposal", json=body(paths=[".github/workflows/x.yml"]), headers=bridge_headers()).status_code == 403


def test_apply_needs_a_proposal_in_review(cloud):
    cloud["status"] = "completed"
    assert client.post("/api/worker/agents/apply-proposal", json=body(), headers=bridge_headers()).status_code == 409


def test_git_head_reports_commit_and_dirty_state(tmp_path: Path):
    import subprocess
    assert client.get("/api/worker/git/head", headers=auth()).json() == {"sha": None, "dirty": False}  # not a repository yet
    env = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t", "PATH": __import__("os").environ["PATH"]}
    for args in (["init", "-q"], ["add", "hello.py"], ["commit", "-q", "-m", "init"]):
        subprocess.run(["git", *args], cwd=tmp_path, env=env, check=True)
    clean = client.get("/api/worker/git/head", headers=auth()).json()
    assert len(clean["sha"]) == 40 and clean["dirty"] is True        # .env/untracked files make it dirty
    (tmp_path / "hello.py").write_text("changed\n", encoding="utf-8")
    assert client.get("/api/worker/git/head", headers=auth()).json()["dirty"] is True
    assert client.get("/api/worker/git/head").status_code == 401
