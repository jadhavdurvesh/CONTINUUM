"""Optional RELAY-backed agent runtime for CONTINUUM's local worker."""
from __future__ import annotations

import importlib
import json
from typing import Any


def _relay_class():
    try:
        module = importlib.import_module("main")
        return getattr(module, "Relay")
    except Exception as exc:
        raise RuntimeError(
            "RELAY is not installed in this worker. Install services/worker with the [agents] extra."
        ) from exc


def relay_status() -> dict[str, Any]:
    try:
        relay_cls = _relay_class()
        relay = relay_cls()
        providers = relay.available_providers()
        return {
            "installed": True,
            "configured": bool(providers),
            "providers": providers,
            "message": None if providers else "RELAY is installed, but no provider keys are configured on this PC.",
            "failover_enabled": bool(getattr(relay.settings, "enable_failover", True)),
        }
    except Exception as exc:
        return {
            "installed": False,
            "configured": False,
            "providers": [],
            "message": str(exc)[:500],
            "failover_enabled": False,
        }


async def generate_with_relay(prompt: str, *, metadata: dict[str, Any]) -> dict[str, Any]:
    relay_cls = _relay_class()
    relay = relay_cls()
    providers = relay.available_providers()
    if not providers:
        raise RuntimeError("No RELAY providers are configured. Set GROQ_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY on this PC.")
    result = await relay.generate(prompt, temperature=0.2, max_tokens=6000, metadata=metadata)
    return {
        "text": result.text,
        "provider": result.provider,
        "model": result.model,
        "latency_ms": result.latency_ms,
        "attempts": result.attempts,
        "fallback_used": result.fallback_used,
        "input_tokens": result.input_tokens,
        "output_tokens": result.output_tokens,
        "total_tokens": result.total_tokens,
    }


def parse_agent_payload(raw: str) -> dict[str, Any]:
    """Parse structured JSON, tolerating a fenced JSON answer."""
    text = raw.strip()
    fence = chr(96) * 3
    if text.startswith(fence):
        first_newline = text.find("\n")
        text = text[first_newline + 1:] if first_newline >= 0 else text[len(fence):]
        if text.rstrip().endswith(fence):
            text = text.rstrip()[:-len(fence)].rstrip()
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        if start < 0:
            raise ValueError("RELAY did not return a JSON object.")
        payload = None
        for end in range(len(text), start, -1):
            if text[end - 1] != "}":
                continue
            try:
                payload = json.loads(text[start:end])
                break
            except json.JSONDecodeError:
                continue
        if payload is None:
            raise ValueError("RELAY returned invalid structured JSON.")
    if not isinstance(payload, dict):
        raise ValueError("The agent response must be a JSON object.")
    summary = payload.get("summary", "")
    if not isinstance(summary, str) or not summary.strip():
        summary = "Agent step completed. Review the returned notes before continuing."
    files = payload.get("files", [])
    if not isinstance(files, list) or len(files) > 12:
        raise ValueError("The agent file list must contain at most 12 files.")
    normalized_files = []
    for item in files:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not isinstance(item.get("content"), str):
            raise ValueError("Every proposed file needs a relative path and string content.")
        normalized_files.append({"path": item["path"], "content": item["content"]})
    roles = {"planner", "coder", "reviewer", "qa"}
    next_role = payload.get("next_role", "reviewer" if normalized_files else "planner")
    if next_role not in roles:
        next_role = "reviewer" if normalized_files else "planner"
    status = payload.get("status", "needs_review")
    if status not in {"needs_review", "queued", "completed"}:
        status = "needs_review"
    notes = payload.get("review_notes", "")
    if not isinstance(notes, str):
        notes = ""
    return {
        "summary": summary[:8000],
        "files": normalized_files,
        "next_role": next_role,
        "status": status,
        "review_notes": notes[:8000],
    }
