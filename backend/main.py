from __future__ import annotations

import json
import re
import socket
import subprocess
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

import yaml
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
REPOSITORY_ROOT = PROJECT_ROOT.parent
OUTBOX_FILE = PROJECT_ROOT / "runtime" / "outbox.jsonl"

PROFILE_DEFINITIONS = (
    {
        "id": "default",
        "name": "小黑",
        "port": 8642,
        "config_path": HERMES_HOME / "config.yaml",
    },
    {
        "id": "media-ops",
        "name": "小橙",
        "port": 8650,
        "config_path": PROFILES_HOME / "media-ops" / "config.yaml",
    },
    {
        "id": "investor",
        "name": "小金",
        "port": 8660,
        "config_path": PROFILES_HOME / "investor" / "config.yaml",
    },
)
PROFILE_BY_ID = {str(item["id"]): item for item in PROFILE_DEFINITIONS}

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


class OutboxRetryRequest(BaseModel):
    limit: int = Field(default=10, ge=1, le=50)


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


def redact_secret(value: str, secret: str, limit: int = 500) -> str:
    return redact_text(value.replace(secret, "[REDACTED]"), limit=limit)


def read_api_server_key(config_path: Path) -> str | None:
    try:
        payload = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, yaml.YAMLError):
        return None
    if not isinstance(payload, dict):
        return None
    platforms = payload.get("platforms")
    if not isinstance(platforms, dict):
        return None
    api_server = platforms.get("api_server")
    if not isinstance(api_server, dict):
        return None
    extra = api_server.get("extra")
    if not isinstance(extra, dict):
        return None
    key = extra.get("key")
    if not isinstance(key, str) or not key.strip():
        return None
    return key.strip()


def response_content(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return ""
    message = choices[0].get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts)
    return ""


def deliver_to_api_server(port: int, key: str, message: str) -> str:
    body = json.dumps(
        {
            "model": "hermes-agent",
            "messages": [{"role": "user", "content": message}],
            "max_tokens": 800,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/chat/completions",
        data=body,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=12) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return response_content(payload)


def write_outbox_message(
    *, stored_at: str, agent_id: str, message: str, fallback_reason: str
) -> None:
    record = {
        "stored_at": stored_at,
        "agent_id": agent_id,
        "message": message,
        "queued": True,
        "source": "hermes-office-mobile",
        "fallback_reason": fallback_reason,
    }
    OUTBOX_FILE.parent.mkdir(parents=True, exist_ok=True)
    with OUTBOX_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def read_outbox_records() -> list[dict[str, Any]]:
    if not OUTBOX_FILE.is_file():
        return []
    records: list[dict[str, Any]] = []
    try:
        lines = OUTBOX_FILE.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    for index, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(item, dict):
            continue
        item["id"] = index
        records.append(item)
    return records


def write_outbox_records(records: list[dict[str, Any]]) -> None:
    OUTBOX_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = OUTBOX_FILE.with_suffix(".jsonl.tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        for record in records:
            clean = {key: value for key, value in record.items() if key != "id"}
            handle.write(json.dumps(clean, ensure_ascii=False) + "\n")
    tmp_path.replace(OUTBOX_FILE)


def write_sent_record(record: dict[str, Any], response_preview: str) -> None:
    sent_file = OUTBOX_FILE.parent / "sent.jsonl"
    sent_file.parent.mkdir(parents=True, exist_ok=True)
    payload = {key: value for key, value in record.items() if key != "id"}
    payload.update({
        "delivered_at": utc_now(),
        "delivered": True,
        "channel": "api_server",
        "response_preview": response_preview,
    })
    with sent_file.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def compact_outbox_record(record: dict[str, Any]) -> dict[str, Any]:
    message = redact_text(str(record.get("message") or ""), limit=4000)
    return {
        "id": record.get("id"),
        "agent_id": redact_text(str(record.get("agent_id") or ""), limit=64),
        "message_preview": message[:80] + ("…" if len(message) > 80 else ""),
        "stored_at": safe_string(record.get("stored_at")),
        "fallback_reason": safe_string(record.get("fallback_reason")),
    }


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


def evolution_trend(skill_entries: list[Path], profile_documents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    today = datetime.now(timezone.utc).date()
    dates = [today - timedelta(days=offset) for offset in range(6, -1, -1)]
    skill_changes = Counter(
        modified_at.date()
        for item in skill_entries
        if (modified_at := file_modified_datetime(item)) is not None
    )
    profile_changes: Counter[Any] = Counter()
    for profile in profile_documents:
        for field in ("soul", "agent"):
            modified_at = profile.get(field, {}).get("modified_at")
            if not isinstance(modified_at, str):
                continue
            try:
                profile_changes[datetime.fromisoformat(modified_at).date()] += 1
            except ValueError:
                continue
    return [
        {
            "date": day.isoformat(),
            "skill_changes": skill_changes[day],
            "profile_changes": profile_changes[day],
            "total_changes": skill_changes[day] + profile_changes[day],
        }
        for day in dates
    ]


def file_modified_datetime(path: Path) -> datetime | None:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
    except OSError:
        return None


def recent_git_milestones(limit: int = 6) -> list[dict[str, str]]:
    try:
        result = subprocess.run(
            [
                "git",
                "log",
                f"-{limit}",
                "--date=iso-strict",
                "--pretty=format:%h%x1f%aI%x1f%s%x1e",
            ],
            cwd=REPOSITORY_ROOT,
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return []

    milestones = []
    for record in result.stdout.split("\x1e"):
        parts = record.strip().split("\x1f", 2)
        if len(parts) != 3:
            continue
        commit_hash, committed_at, subject = parts
        milestones.append(
            {
                "title": subject,
                "date": committed_at,
                "type": "commit",
                "description": f"项目提交 {commit_hash}",
            }
        )
    return milestones


def evolution_milestones(
    latest_skills: list[Path], profile_documents: list[dict[str, Any]]
) -> list[dict[str, str]]:
    milestones = recent_git_milestones()
    for profile in profile_documents:
        present_documents = [
            filename
            for filename, field in (("SOUL.md", "soul"), ("AGENT.md", "agent"))
            if profile.get(field, {}).get("present")
        ]
        modified_dates = [
            profile.get(field, {}).get("modified_at")
            for field in ("soul", "agent")
            if isinstance(profile.get(field, {}).get("modified_at"), str)
        ]
        if not present_documents or not modified_dates:
            continue
        milestones.append(
            {
                "title": f"{profile['name']} 员工档案更新",
                "date": max(modified_dates),
                "type": "profile",
                "description": f"已记录{'、'.join(present_documents)}",
            }
        )
    for skill in latest_skills[:3]:
        modified_at = iso_mtime(skill)
        if modified_at is None:
            continue
        milestones.append(
            {
                "title": f"{skill.name} 能力资料更新",
                "date": modified_at,
                "type": "skill",
                "description": "Skill 目录最近修改记录",
            }
        )
    return sorted(milestones, key=lambda item: item["date"], reverse=True)[:12]


def evolution_skill_tree(skill_entries: list[Path]) -> list[dict[str, Any]]:
    categories = (
        (
            "messaging",
            "消息处理",
            ("message", "messaging", "email", "mail", "chat", "im", "social", "feed", "feeds"),
        ),
        (
            "knowledge",
            "知识管理",
            (
                "knowledge",
                "memory",
                "note",
                "doc",
                "wiki",
                "search",
                "research",
                "pdf",
                "read",
                "content",
                "data",
                "kb",
            ),
        ),
        (
            "development",
            "开发执行",
            (
                "develop",
                "development",
                "code",
                "git",
                "github",
                "terminal",
                "cli",
                "api",
                "browser",
                "web",
                "frontend",
                "devops",
                "mlops",
                "infrastructure",
                "execute",
                "mcp",
                "skill",
                "skills",
                "app",
            ),
        ),
        (
            "automation",
            "自动化",
            (
                "automation",
                "workflow",
                "task",
                "cron",
                "schedule",
                "dispatch",
                "process",
                "project",
                "productivity",
            ),
        ),
    )
    tree = [{"key": key, "title": title, "children": []} for key, title, _ in categories]
    for skill in sorted(skill_entries, key=lambda item: item.name.lower()):
        name_tokens = set(re.findall(r"[a-z0-9]+", skill.name.lower()))
        for index, (_, _, keywords) in enumerate(categories):
            if any(keyword in name_tokens for keyword in keywords):
                tree[index]["children"].append(
                    {"name": skill.name, "modified_at": iso_mtime(skill)}
                )
                break
    return tree


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
        "trend": evolution_trend(skill_entries, profile_documents),
        "milestones": evolution_milestones(latest_skills, profile_documents),
        "skill_tree": evolution_skill_tree(skill_entries),
    }


@app.get("/api/cron")
def cron() -> dict[str, Any]:
    return {"generated_at": utc_now(), **cron_summary()}


@app.get("/api/outbox")
def outbox() -> dict[str, Any]:
    records = read_outbox_records()
    recent = [compact_outbox_record(record) for record in records[-50:]]
    return {
        "generated_at": utc_now(),
        "source": str(OUTBOX_FILE),
        "count": len(records),
        "items": recent,
    }


@app.post("/api/outbox/retry")
def retry_outbox(payload: OutboxRetryRequest) -> dict[str, Any]:
    records = read_outbox_records()
    remaining: list[dict[str, Any]] = []
    attempted = 0
    delivered = 0
    failures: list[dict[str, Any]] = []

    for record in records:
        if attempted >= payload.limit:
            remaining.append(record)
            continue
        attempted += 1
        agent_id = str(record.get("agent_id") or "").strip()
        message = str(record.get("message") or "").strip()
        definition = PROFILE_BY_ID.get(agent_id)
        reason = "unknown_agent"
        if definition is not None and message:
            port = int(definition["port"])
            if is_port_listening(port):
                key = read_api_server_key(Path(definition["config_path"]))
                if key:
                    try:
                        result = deliver_to_api_server(port, key, message)
                        write_sent_record(record, redact_secret(result, key, limit=240))
                        delivered += 1
                        continue
                    except (
                        OSError,
                        UnicodeError,
                        json.JSONDecodeError,
                        urllib.error.URLError,
                    ):
                        reason = "api_request_failed"
                else:
                    reason = "api_key_unavailable"
            else:
                reason = "api_server_offline"
        elif not message:
            reason = "empty_message"
        record["fallback_reason"] = reason
        remaining.append(record)
        failures.append({
            "id": record.get("id"),
            "agent_id": redact_text(agent_id, limit=64),
            "fallback_reason": reason,
        })

    write_outbox_records(remaining)
    return {
        "ok": True,
        "attempted": attempted,
        "delivered": delivered,
        "remaining": len(remaining),
        "failures": failures[:10],
        "generated_at": utc_now(),
    }


@app.post("/api/messages")
def queue_message(payload: MessageRequest) -> Any:
    stored_at = utc_now()
    agent_id = payload.agent_id.strip()
    message = payload.message.strip()
    safe_message = redact_text(message, limit=4000)
    preview = safe_message[:80] + ("…" if len(safe_message) > 80 else "")
    if not agent_id or not message:
        return JSONResponse(
            status_code=422,
            content={
                "ok": False,
                "delivered": False,
                "queued": False,
                "message_preview": preview,
                "stored_at": stored_at,
                "error": "agent_id 和 message 不能为空",
            },
        )
    definition = PROFILE_BY_ID.get(agent_id)
    if definition is None:
        return JSONResponse(
            status_code=422,
            content={
                "ok": False,
                "delivered": False,
                "queued": False,
                "agent_id": redact_text(agent_id, limit=64),
                "message_preview": preview,
                "stored_at": stored_at,
                "error": "未知 agent_id",
            },
        )

    port = int(definition["port"])
    config_path = Path(definition["config_path"])
    fallback_reason = "api_server_offline"
    if is_port_listening(port):
        key = read_api_server_key(config_path)
        if key is None:
            fallback_reason = "api_key_unavailable"
        else:
            try:
                result = deliver_to_api_server(port, key, message)
                return {
                    "ok": True,
                    "delivered": True,
                    "queued": False,
                    "channel": "api_server",
                    "agent_id": agent_id,
                    "message_preview": preview,
                    "stored_at": stored_at,
                    "response_preview": redact_secret(result, key, limit=240),
                }
            except (
                OSError,
                UnicodeError,
                json.JSONDecodeError,
                urllib.error.URLError,
            ):
                fallback_reason = "api_request_failed"

    try:
        write_outbox_message(
            stored_at=stored_at,
            agent_id=agent_id,
            message=message,
            fallback_reason=fallback_reason,
        )
    except OSError as exc:
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "delivered": False,
                "agent_id": agent_id,
                "queued": False,
                "channel": "outbox",
                "message_preview": preview,
                "stored_at": stored_at,
                "error": f"消息入队失败：{type(exc).__name__}",
            },
        )
    return {
        "ok": True,
        "delivered": False,
        "agent_id": agent_id,
        "queued": True,
        "channel": "outbox",
        "message_preview": preview,
        "stored_at": stored_at,
        "fallback_reason": fallback_reason,
    }
