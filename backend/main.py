from __future__ import annotations

import json
import re
import socket
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field


HERMES_HOME = Path("/home/agentuser/.hermes")
PROFILES_HOME = HERMES_HOME / "profiles"
GATEWAY_LOG = HERMES_HOME / "logs" / "gateway.log"
CRON_JOBS = HERMES_HOME / "cron" / "jobs.json"
SKILLS_HOME = HERMES_HOME / "skills"
PROJECT_ROOT = Path(__file__).resolve().parent
OUTBOX_FILE = PROJECT_ROOT / "runtime" / "outbox.jsonl"

PROFILE_DEFINITIONS = (
    {"id": "default", "name": "小黑", "port": 8642},
    {"id": "media-ops", "name": "小橙", "port": 8644},
    {"id": "investor", "name": "小金", "port": 8650},
)

SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)(api[_-]?key|secret|token|password|passwd|authorization|cookie)"
    r"(\s*[:=]\s*)([^\s,;]+)"
)
BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")
JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")
URL_SECRET_RE = re.compile(
    r"(?i)([?&](?:api[_-]?key|secret|token|password|access_token)=)[^&\s]+"
)
LONG_CREDENTIAL_RE = re.compile(r"\b(?:sk|pk|ghp|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b")


app = FastAPI(
    title="Hermes Office Mobile BFF",
    version="0.1.0",
    description="Read-only local status API for the Hermes mobile office.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class MessageRequest(BaseModel):
    agent_id: str = Field(..., min_length=1, max_length=64)
    message: str = Field(..., min_length=1, max_length=4000)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def iso_mtime(path: Path) -> str | None:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
    except OSError:
        return None


def file_metadata(path: Path) -> dict[str, Any]:
    try:
        stat = path.stat()
        return {
            "present": path.is_file(),
            "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
            "size_bytes": stat.st_size,
        }
    except OSError:
        return {"present": False, "modified_at": None, "size_bytes": None}


def is_port_listening(port: int, host: str = "127.0.0.1") -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.2):
            return True
    except OSError:
        return False


def redact_text(value: str, limit: int = 500) -> str:
    redacted = SECRET_ASSIGNMENT_RE.sub(r"\1\2[REDACTED]", value)
    redacted = BEARER_RE.sub("Bearer [REDACTED]", redacted)
    redacted = JWT_RE.sub("[REDACTED_JWT]", redacted)
    redacted = URL_SECRET_RE.sub(r"\1[REDACTED]", redacted)
    redacted = LONG_CREDENTIAL_RE.sub("[REDACTED_CREDENTIAL]", redacted)
    redacted = redacted.replace("\x00", "")
    if len(redacted) > limit:
        return f"{redacted[:limit]}…"
    return redacted


def read_recent_lines(path: Path, max_lines: int = 40, max_bytes: int = 128_000) -> list[str]:
    try:
        with path.open("rb") as handle:
            handle.seek(0, 2)
            size = handle.tell()
            handle.seek(max(0, size - max_bytes))
            raw = handle.read()
    except OSError:
        return []

    text = raw.decode("utf-8", errors="replace")
    lines = text.splitlines()
    if size > max_bytes and lines:
        lines = lines[1:]
    return [redact_text(line) for line in lines[-max_lines:] if line.strip()]


def safe_string(value: Any, limit: int = 160) -> str | None:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return redact_text(str(value), limit=limit)
    return None


def first_value(mapping: dict[str, Any], keys: Iterable[str]) -> Any:
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return None


def extract_jobs(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("jobs", "items", "data"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    if payload and all(isinstance(item, dict) for item in payload.values()):
        return [item for item in payload.values() if isinstance(item, dict)]
    return []


def cron_schedule(job: dict[str, Any]) -> str | None:
    value = first_value(job, ("schedule", "cron", "cron_expression", "expression"))
    if isinstance(value, dict):
        value = first_value(value, ("expression", "cron", "value", "text"))
    return safe_string(value)


def cron_summary() -> dict[str, Any]:
    metadata = file_metadata(CRON_JOBS)
    if not metadata["present"]:
        return {
            "available": False,
            "source": str(CRON_JOBS),
            "modified_at": None,
            "total": 0,
            "enabled": 0,
            "disabled": 0,
            "status_counts": {},
            "jobs": [],
        }

    try:
        with CRON_JOBS.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        jobs = extract_jobs(payload)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        return {
            "available": False,
            "source": str(CRON_JOBS),
            "modified_at": metadata["modified_at"],
            "total": 0,
            "enabled": 0,
            "disabled": 0,
            "status_counts": {},
            "jobs": [],
            "error": type(exc).__name__,
        }

    compact_jobs: list[dict[str, Any]] = []
    status_counts: Counter[str] = Counter()
    enabled_count = 0
    for index, job in enumerate(jobs):
        enabled_value = first_value(job, ("enabled", "active", "is_enabled"))
        enabled = enabled_value is not False
        enabled_count += int(enabled)
        status = safe_string(first_value(job, ("status", "state", "last_status"))) or "unknown"
        status_counts[status] += 1
        compact_jobs.append(
            {
                "id": safe_string(first_value(job, ("id", "job_id", "uuid"))) or str(index + 1),
                "name": safe_string(first_value(job, ("name", "title", "description")))
                or f"Job {index + 1}",
                "enabled": enabled,
                "status": status,
                "schedule": cron_schedule(job),
                "next_run_at": safe_string(
                    first_value(job, ("next_run_at", "next_run", "nextRunAt"))
                ),
                "last_run_at": safe_string(
                    first_value(job, ("last_run_at", "last_run", "lastRunAt"))
                ),
            }
        )

    return {
        "available": True,
        "source": str(CRON_JOBS),
        "modified_at": metadata["modified_at"],
        "total": len(jobs),
        "enabled": enabled_count,
        "disabled": len(jobs) - enabled_count,
        "status_counts": dict(status_counts),
        "jobs": compact_jobs[:25],
        "truncated": len(compact_jobs) > 25,
    }


def directory_children(path: Path) -> list[Path]:
    try:
        return [item for item in path.iterdir() if not item.name.startswith(".")]
    except OSError:
        return []


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "hermes-office-mobile-bff",
        "timestamp": utc_now(),
        "hermes_home": {
            "path": str(HERMES_HOME),
            "available": HERMES_HOME.is_dir(),
        },
        "sources": {
            "profiles": PROFILES_HOME.is_dir(),
            "gateway_log": GATEWAY_LOG.is_file(),
            "cron_jobs": CRON_JOBS.is_file(),
            "skills": SKILLS_HOME.is_dir(),
        },
    }


@app.get("/api/agents")
def agents() -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    for definition in PROFILE_DEFINITIONS:
        profile_id = str(definition["id"])
        profile_path = PROFILES_HOME / profile_id
        port = int(definition["port"])
        listening = is_port_listening(port)
        items.append(
            {
                "id": profile_id,
                "name": definition["name"],
                "profile_path": str(profile_path),
                "profile_available": profile_path.is_dir(),
                "status": "online" if listening else "offline",
                "port": port,
                "port_listening": listening,
                "soul": file_metadata(profile_path / "SOUL.md"),
                "agent": file_metadata(profile_path / "AGENT.md"),
            }
        )
    return {"generated_at": utc_now(), "count": len(items), "agents": items}


@app.get("/api/activity")
def activity() -> dict[str, Any]:
    lines = read_recent_lines(GATEWAY_LOG)
    return {
        "generated_at": utc_now(),
        "source": str(GATEWAY_LOG),
        "available": GATEWAY_LOG.is_file(),
        "modified_at": iso_mtime(GATEWAY_LOG),
        "count": len(lines),
        "items": [
            {"id": index + 1, "message": line}
            for index, line in enumerate(lines)
        ],
        "redacted": True,
    }


@app.get("/api/evolution")
def evolution() -> dict[str, Any]:
    skill_entries = [item for item in directory_children(SKILLS_HOME) if item.is_dir()]
    latest_skills = sorted(
        skill_entries,
        key=lambda item: item.stat().st_mtime if item.exists() else 0,
        reverse=True,
    )[:20]
    profile_documents = []
    for definition in PROFILE_DEFINITIONS:
        profile_id = str(definition["id"])
        profile_path = PROFILES_HOME / profile_id
        profile_documents.append(
            {
                "profile": profile_id,
                "name": definition["name"],
                "profile_available": profile_path.is_dir(),
                "soul": file_metadata(profile_path / "SOUL.md"),
                "agent": file_metadata(profile_path / "AGENT.md"),
            }
        )
    return {
        "generated_at": utc_now(),
        "skills": {
            "path": str(SKILLS_HOME),
            "available": SKILLS_HOME.is_dir(),
            "count": len(skill_entries),
            "recent": [
                {"name": item.name, "modified_at": iso_mtime(item)} for item in latest_skills
            ],
        },
        "profiles": profile_documents,
    }


@app.get("/api/cron")
def cron() -> dict[str, Any]:
    return {"generated_at": utc_now(), **cron_summary()}


@app.post("/api/messages")
def queue_message(payload: MessageRequest) -> Any:
    stored_at = utc_now()
    agent_id = redact_text(payload.agent_id.strip(), limit=64)
    message = redact_text(payload.message, limit=4000).strip()
    preview = message[:80] + ("…" if len(message) > 80 else "")
    if not agent_id or not message:
        return JSONResponse(
            status_code=422,
            content={
                "ok": False,
                "queued": False,
                "message_preview": preview,
                "stored_at": stored_at,
                "error": "agent_id 和 message 不能为空",
            },
        )
    record = {
        "stored_at": stored_at,
        "agent_id": agent_id,
        "message": message,
        "queued": True,
        "source": "hermes-office-mobile",
    }
    try:
        OUTBOX_FILE.parent.mkdir(parents=True, exist_ok=True)
        with OUTBOX_FILE.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError as exc:
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "agent_id": agent_id,
                "queued": False,
                "message_preview": preview,
                "stored_at": stored_at,
                "error": f"消息入队失败：{type(exc).__name__}",
            },
        )
    return {
        "ok": True,
        "agent_id": agent_id,
        "queued": True,
        "message_preview": preview,
        "stored_at": stored_at,
    }
