"""Cloud session and agent API client. The desktop embeds only publishable values."""
from __future__ import annotations

import json
import keyring
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

try:
    from ._release_cloud_config import CLOUD_API_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL
except ImportError:
    from .cloud_config import CLOUD_API_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL


class CloudError(RuntimeError):
    """A cloud request failed or needs the user to reconnect."""


class CloudClient:
    def __init__(self) -> None:
        self.supabase_url = SUPABASE_URL.rstrip("/")
        self.publishable_key = SUPABASE_PUBLISHABLE_KEY
        self.api_url = CLOUD_API_URL.rstrip("/")
        self.access_token = ""
        self.refresh_token = ""
        self.user: dict[str, Any] | None = None

    @property
    def configured(self) -> bool:
        return bool(self.supabase_url and self.publishable_key and self.api_url)

    @property
    def signed_in(self) -> bool:
        return bool(self.access_token and self.user)

    def _keyring_get(self) -> str:
        try:
            return keyring.get_password("CONTINUUM", "refresh_token") or ""
        except Exception:
            return ""

    def _keyring_set(self, value: str) -> None:
        try:
            if value:
                keyring.set_password("CONTINUUM", "refresh_token", value)
            else:
                keyring.delete_password("CONTINUUM", "refresh_token")
        except Exception:
            # The app remains usable for the current session without OS keyring support.
            pass

    def _open(self, url: str, method: str = "GET", payload: Any = None,
              *, authenticated: bool = True, headers: dict[str, str] | None = None,
              timeout: int = 12) -> Any:
        if not self.configured:
            raise CloudError("This installer was built without cloud deployment settings. Local files and editing still work.")
        request_headers = {
            "apikey": self.publishable_key,
            "Accept": "application/json",
        }
        if authenticated and self.access_token:
            request_headers["Authorization"] = "Bearer " + self.access_token
        if headers:
            request_headers.update(headers)
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=body, headers=request_headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                content = response.read().decode("utf-8")
                return json.loads(content) if content else None
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:600]
            if exc.code == 401 and authenticated and self.refresh_token:
                if self._refresh_session():
                    return self._open(url, method, payload, authenticated=authenticated, headers=headers, timeout=timeout)
                raise CloudError("Your cloud session expired. Select Connect Cloud and sign in again.") from exc
            if exc.code == 403:
                raise CloudError("The cloud workspace denied this action. Check project membership and protected-path permissions.") from exc
            raise CloudError("Cloud request failed (" + str(exc.code) + "): " + detail) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise CloudError("Cloud features need an internet connection. Local editing remains available.") from exc
        except json.JSONDecodeError as exc:
            raise CloudError("The cloud service returned an invalid response.") from exc

    def _auth(self, endpoint: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = self.supabase_url + "/auth/v1/" + endpoint
        result = self._open(url, "POST", payload, authenticated=False, timeout=15)
        if not isinstance(result, dict):
            raise CloudError("The identity service returned an invalid response.")
        return result

    def sign_in(self, email: str, password: str) -> None:
        result = self._auth("token?grant_type=password", {"email": email.strip(), "password": password})
        self._set_session(result)

    def _set_session(self, result: dict[str, Any]) -> None:
        access = result.get("access_token")
        refresh = result.get("refresh_token")
        user = result.get("user")
        if not isinstance(access, str) or not isinstance(refresh, str) or not isinstance(user, dict):
            raise CloudError("Sign-in did not return a complete cloud session.")
        self.access_token = access
        self.refresh_token = refresh
        self.user = user
        self._keyring_set(refresh)

    def _refresh_session(self) -> bool:
        if not self.refresh_token:
            return False
        try:
            result = self._auth("token?grant_type=refresh_token", {"refresh_token": self.refresh_token})
            self._set_session(result)
            return True
        except CloudError:
            self.access_token = ""
            self.refresh_token = ""
            self.user = None
            self._keyring_set("")
            return False

    def restore_session(self) -> bool:
        self.refresh_token = self._keyring_get()
        return self._refresh_session() if self.refresh_token else False

    def sign_out(self) -> None:
        if self.access_token:
            try:
                self._open(self.supabase_url + "/auth/v1/logout", "POST", {}, timeout=5)
            except CloudError:
                pass
        self.access_token = ""
        self.refresh_token = ""
        self.user = None
        self._keyring_set("")

    def _rest(self, resource: str, query: dict[str, str] | None = None,
              method: str = "GET", payload: Any = None,
              prefer: str | None = None) -> Any:
        url = self.supabase_url + "/rest/v1/" + resource
        if query:
            url += "?" + urllib.parse.urlencode(query)
        headers = {}
        if prefer:
            headers["Prefer"] = prefer
        return self._open(url, method, payload, headers=headers)

    def projects(self) -> list[dict[str, Any]]:
        result = self._rest("projects", {"select": "id,name,description,status,owner_id", "order": "created_at.desc"})
        return result if isinstance(result, list) else []

    def sessions(self, project_id: str) -> list[dict[str, Any]]:
        result = self._rest("agent_sessions", {
            "select": "id,project_id,title,goal,current_agent,status,focus_paths,checkpoint,last_error,task_id,updated_at",
            "project_id": "eq." + project_id, "order": "updated_at.desc", "limit": "100"
        })
        return result if isinstance(result, list) else []

    def messages(self, project_id: str, session_id: str) -> list[dict[str, Any]]:
        result = self._rest("agent_messages", {
            "select": "id,project_id,session_id,role,actor_type,actor_id,content,metadata,created_at",
            "project_id": "eq." + project_id, "session_id": "eq." + session_id,
            "order": "created_at.asc", "limit": "120"
        })
        return result if isinstance(result, list) else []

    def create_session(self, project_id: str, title: str, goal: str, role: str,
                       focus_paths: list[str]) -> dict[str, Any]:
        user_id = (self.user or {}).get("id")
        if not user_id:
            raise CloudError("Sign in to create an agent session.")
        payload = {
            "project_id": project_id, "title": title.strip(), "goal": goal.strip(),
            "current_agent": role, "status": "queued",
            "focus_paths": focus_paths[:12], "requested_by": user_id,
        }
        result = self._rest("agent_sessions", method="POST", payload=payload, prefer="return=representation")
        if not isinstance(result, list) or not result:
            raise CloudError("The cloud did not confirm creation of the agent session.")
        session = result[0]
        self._rest("agent_messages", method="POST", payload={
            "project_id": project_id, "session_id": session["id"], "role": "user",
            "actor_type": "human", "actor_id": user_id, "content": goal.strip(),
            "metadata": {"initial_goal": True, "focus_paths": focus_paths[:12]},
        }, prefer="return=minimal")
        return session

    def run_step(self, project_id: str, session_id: str, workspace_context: list[dict[str, str]] | None = None) -> dict[str, Any]:
        url = self.api_url + "/api/agents/run-step"
        result = self._open(
            url, "POST",
            {"project_id": project_id, "session_id": session_id,
             "workspace_context": (workspace_context or [])[:12]},
            timeout=65,
        )
        if not isinstance(result, dict):
            raise CloudError("The cloud agent service returned an invalid response.")
        return result

    def continue_session(self, project_id: str, session: dict[str, Any], feedback: str) -> None:
        session_id = str(session.get("id", ""))
        if not session_id or not self.user:
            raise CloudError("Select a valid session and sign in again.")
        if feedback.strip():
            self._rest("agent_messages", method="POST", payload={
                "project_id": project_id, "session_id": session_id,
                "role": "user", "actor_type": "human",
                "actor_id": str(self.user.get("id")), "content": feedback.strip()[:20000],
                "metadata": {"handoff_feedback": True},
            }, prefer="return=minimal")
        checkpoint = session.get("checkpoint") if isinstance(session.get("checkpoint"), dict) else {}
        next_role = checkpoint.get("next_role") or session.get("current_agent") or "planner"
        if next_role not in {"planner", "coder", "reviewer", "qa"}:
            next_role = "planner"
        self._rest("agent_sessions", {
            "id": "eq." + session_id, "project_id": "eq." + project_id,
        }, "PATCH", {
            "status": "queued", "current_agent": next_role,
            "last_error": None, "finished_at": None,
        }, "return=minimal")

    def assert_file_editable(self, project_id: str, relative_path: str) -> None:
        """Fail closed when a shared path is locked and this user has no grant."""
        user_id = (self.user or {}).get("id")
        if not user_id:
            raise CloudError("Sign in before applying a cloud agent proposal.")
        membership = self._rest("project_members", {
            "select": "user_id", "project_id": "eq." + project_id,
            "user_id": "eq." + user_id, "limit": "1",
        })
        if not isinstance(membership, list) or not membership:
            raise CloudError("This account is not a member of the selected cloud project.")
        locks = self._rest("repository_path_locks", {
            "select": "id,path,reason", "project_id": "eq." + project_id,
            "path": "eq." + relative_path.replace("\\", "/"), "is_locked": "eq.true", "limit": "1",
        })
        if not isinstance(locks, list) or not locks:
            return
        lock = locks[0]
        grants = self._rest("permission_grants", {
            "select": "expires_at", "project_id": "eq." + project_id,
            "resource_type": "eq.local_file", "resource_id": "eq." + str(lock["id"]),
            "user_id": "eq." + user_id, "permitted_action": "eq.edit", "revoked_at": "is.null",
        })
        now = datetime.now(timezone.utc)
        for grant in grants if isinstance(grants, list) else []:
            expires = grant.get("expires_at")
            if not expires:
                return
            try:
                value = datetime.fromisoformat(str(expires).replace("Z", "+00:00"))
                if value > now:
                    return
            except ValueError:
                continue
        raise CloudError("Protected path: " + relative_path + ". Ask the project owner to unlock it or grant temporary edit access.")
