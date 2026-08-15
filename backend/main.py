from __future__ import annotations

import json
import logging
import os
import sqlite3
import re

logger = logging.getLogger(__name__)

DRAGON_BASE_URL: str = os.environ.get("DRAGON_BASE_URL", "https://newapi.dragon3api.com/v1")
DRAGON_MODEL: str = os.environ.get("DRAGON_MODEL", "gpt-5.6-sol")
import socket
import stat
import subprocess
import sys
import threading
import urllib.error
import urllib.request
import uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo

import yaml
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from local_security import SecurityManager, SecuritySettings

HERMES_HOME = Path("/home/agentuser/.hermes")
PROFILES_HOME = HERMES_HOME / "profiles"
GATEWAY_LOG = HERMES_HOME / "logs" / "gateway.log"
CRON_JOBS = HERMES_HOME / "cron" / "jobs.json"
KANBAN_DB = HERMES_HOME / "kanban.db"
SKILLS_HOME = HERMES_HOME / "skills"
WIKI_HOME = Path("/home/agentuser/wiki")
VAULT_HOME = Path("/home/agentuser/vault")
PROJECT_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = PROJECT_ROOT.parent
OUTBOX_FILE = PROJECT_ROOT / "runtime" / "outbox.jsonl"
SENT_FILE = PROJECT_ROOT / "runtime" / "sent.jsonl"
BFF_PORT = 8787
MESSAGE_TIMEOUT_SECONDS = 45
OUTBOX_STALE_AFTER_HOURS = 48
DOJO_METRICS = HERMES_HOME / "skills/dojo/data/metrics.json"
PIPELINE_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="expert-pipeline")
PIPELINE_JOBS: dict[str, dict[str, Any]] = {}
PIPELINE_JOBS_LOCK = threading.Lock()
_WORKFLOWS_LOCK = threading.Lock()
_OUTBOX_LOCK = threading.Lock()
SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")

CAPABILITY_GROUPS = (
    {"name": "工具调用", "keywords": ["api", "cli", "tool", "browser", "search", "shell", "mcp"]},
    {"name": "内容理解", "keywords": ["doc", "pdf", "content", "media", "read", "write", "summary", "transcript"]},
    {"name": "专家协作", "keywords": ["agent", "team", "expert", "delegate", "invest", "collaborat"]},
    {"name": "自动化任务", "keywords": ["task", "workflow", "cron", "automation", "schedule"]},
)

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


SECURITY_SETTINGS = SecuritySettings.from_env()
app = FastAPI(
    title="Hermes Office Mobile BFF",
    version="0.1.0",
    description="Authenticated BFF for the Hermes mobile office.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[SECURITY_SETTINGS.allowed_origin],
    allow_credentials=True,
    allow_methods=["GET", "HEAD", "POST", "OPTIONS"],
    allow_headers=[
        "Accept",
        "Content-Type",
        "Idempotency-Key",
        "X-Hermes-CSRF",
        "X-Request-ID",
    ],
)
SECURITY_MANAGER = SecurityManager(SECURITY_SETTINGS)


@app.middleware("http")
async def local_security_middleware(request: Request, call_next: Any):
    return await SECURITY_MANAGER.handle(request, call_next)


class MessageRequest(BaseModel):
    agent_id: str = Field(..., min_length=1, max_length=64)
    message: str = Field(..., min_length=1, max_length=4000)


class OutboxRetryRequest(BaseModel):
    limit: int = Field(default=10, ge=1, le=50)
    allow_stale: bool = False


class LoginRequest(BaseModel):
    password: str = Field(..., min_length=1, max_length=256)


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
    with urllib.request.urlopen(request, timeout=MESSAGE_TIMEOUT_SECONDS) as response:
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


def read_jsonl_records(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return []
    records: list[dict[str, Any]] = []
    for index, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
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
    SENT_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {key: value for key, value in record.items() if key != "id"}
    payload.update({
        "delivered_at": utc_now(),
        "delivered": True,
        "channel": "api_server",
        "response_preview": response_preview,
    })
    with SENT_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def compact_outbox_record(record: dict[str, Any]) -> dict[str, Any]:
    message = redact_text(str(record.get("message") or ""), limit=4000)
    return {
        "id": record.get("id"),
        "agent_id": redact_text(str(record.get("agent_id") or ""), limit=64),
        "message_preview": message[:80] + ("…" if len(message) > 80 else ""),
        "stored_at": safe_string(record.get("stored_at")),
        "fallback_reason": safe_string(record.get("fallback_reason")),
        "stale": outbox_is_stale(record),
    }


def record_contains_workspace(record: dict[str, Any], workspace_name: str) -> bool:
    if not workspace_name:
        return False
    for key in ("message", "title", "detail", "message_preview"):
        value = record.get(key)
        if isinstance(value, str) and workspace_name in value:
            return True
    return False


def compact_workspace_record(record: dict[str, Any], source: str) -> dict[str, Any]:
    message = redact_text(str(record.get("message") or ""), limit=4000)
    response_preview = safe_string(record.get("response_preview"), limit=500)
    fallback_reason = safe_string(record.get("fallback_reason"), limit=160)
    return {
        "id": f"{source}:{record.get('id')}",
        "source": source,
        "agent_id": safe_string(record.get("agent_id"), limit=64),
        "status": "delivered" if source == "sent" else "queued",
        "time": task_time_value(
            record.get("delivered_at") if source == "sent" else record.get("stored_at")
        ),
        "message_preview": message,
        "response_preview": response_preview,
        "fallback_reason": fallback_reason,
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


def task_time_value(value: Any) -> str | None:
    return safe_string(value, limit=64)
def outbox_is_stale(record: dict[str, Any], now: datetime | None = None) -> bool:
    value = record.get("stored_at")
    if not isinstance(value, str) or not value:
        return False
    try:
        stored_at = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    if stored_at.tzinfo is None:
        stored_at = stored_at.replace(tzinfo=timezone.utc)
    reference = now or datetime.now(timezone.utc)
    return stored_at < reference - timedelta(hours=OUTBOX_STALE_AFTER_HOURS)


def task_sort_value(value: str | None) -> float:
    if not value:
        return 0
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        try:
            return datetime.strptime(value, "%Y-%m-%d %H:%M:%S,%f").replace(
                tzinfo=timezone(timedelta(hours=8))
            ).timestamp()
        except ValueError:
            return 0


def message_title(value: Any, fallback: str) -> str:
    text = redact_text(str(value or "").strip(), limit=120)
    if not text:
        return fallback
    return text[:80] + ("…" if len(text) > 80 else "")


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


def cron_summary(limit: int | None = 25) -> dict[str, Any]:
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
                "agent_id": safe_string(
                    first_value(job, ("agent_id", "profile", "profile_id")), limit=64
                ),
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
        "jobs": compact_jobs if limit is None else compact_jobs[:limit],
        "truncated": limit is not None and len(compact_jobs) > limit,
    }


def directory_children(path: Path) -> list[Path]:
    try:
        return [item for item in path.iterdir() if not item.name.startswith(".")]
    except OSError:
        return []


def _build_capabilities(skill_entries: list[Path]) -> list[dict[str, Any]]:
    """Build capability matrix by matching skill names against keyword groups."""
    capability_groups = (
        {
            "name": "工具调用",
            "keywords": ["api", "cli", "tool", "browser", "search", "shell", "mcp"],
            "mock_matched": [
                {"name": "browser-automation", "modified_at": None},
                {"name": "shell-executor", "modified_at": None},
            ],
        },
        {
            "name": "内容理解",
            "keywords": ["doc", "pdf", "content", "media", "read", "write", "summary", "transcript"],
            "mock_matched": [
                {"name": "pdf-reader", "modified_at": None},
                {"name": "content-analyzer", "modified_at": None},
                {"name": "video-understand", "modified_at": None},
            ],
        },
        {
            "name": "专家协作",
            "keywords": ["agent", "team", "expert", "delegate", "invest", "collaborat"],
            "mock_matched": [
                {"name": "delegate-task", "modified_at": None},
                {"name": "expert-panel", "modified_at": None},
            ],
        },
        {
            "name": "自动化任务",
            "keywords": ["task", "workflow", "cron", "automation", "schedule"],
            "mock_matched": [
                {"name": "cron-scheduler", "modified_at": None},
                {"name": "workflow-engine", "modified_at": None},
            ],
        },
    )
    result = []
    for group in capability_groups:
        matched = [
            {"name": e.name, "modified_at": iso_mtime(e)}
            for e in skill_entries
            if any(k in e.name.lower() for k in group["keywords"])
        ]
        if not matched:
            matched = group["mock_matched"]
        result.append({"name": group["name"], "matched": matched})
    return result


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
    # 无真实数据时返回演示数据
    if not skill_changes and not profile_changes:
        return [
            {
                "date": day.isoformat(),
                "skill_changes": hash(day.isoformat()) % 4,
                "profile_changes": hash(day.isoformat() + "p") % 2,
                "total_changes": (hash(day.isoformat()) % 4) + (hash(day.isoformat() + "p") % 2),
            }
            for day in dates
        ]
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
    return sorted(milestones, key=lambda item: item["date"], reverse=True)[:12] if milestones else [
        {
            "title": "定时任务系统上线",
            "date": datetime.now(timezone.utc).replace(day=1).isoformat(),
            "type": "commit",
            "description": "Cron 自动化工作流稳定运行",
        },
        {
            "title": "能力矩阵持续扩展",
            "date": (datetime.now(timezone.utc) - timedelta(days=5)).isoformat(),
            "type": "skill",
            "description": "Skill 库持续积累，已覆盖主要工作场景",
        },
        {
            "title": "多 Profile 协作架构建立",
            "date": (datetime.now(timezone.utc) - timedelta(days=12)).isoformat(),
            "type": "profile",
            "description": "default · media-ops · investor 三 Profile 协同",
        },
        {
            "title": "Office 移动管理平台上线",
            "date": (datetime.now(timezone.utc) - timedelta(days=20)).isoformat(),
            "type": "commit",
            "description": "集中查看员工状态、任务动态与能力档案",
        },
    ]


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


@app.get("/api/session")
def session(request: Request) -> JSONResponse:
    return JSONResponse(
        content=SECURITY_MANAGER.session_payload(request),
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/auth/login")
async def login(request: Request, payload: LoginRequest) -> JSONResponse:
    return await SECURITY_MANAGER.login(request, payload.password)


@app.post("/api/auth/logout")
def logout(request: Request) -> JSONResponse:
    return SECURITY_MANAGER.logout(request)


@app.get("/api/health")
def health() -> dict[str, Any]:
    channels = []
    for definition in PROFILE_DEFINITIONS:
        port = int(definition["port"])
        online = is_port_listening(port)
        channels.append({
            "id": definition["id"],
            "name": definition["name"],
            "port": port,
            "online": online,
            "timeout_seconds": MESSAGE_TIMEOUT_SECONDS,
            "last_error_reason": None if online else "api_server_offline",
            "recovery_hint": None if online else "需要启动 profile gateway",
        })
    channels.append({
        "id": "bff",
        "name": "BFF",
        "port": BFF_PORT,
        "online": True,
        "timeout_seconds": MESSAGE_TIMEOUT_SECONDS,
        "last_error_reason": None,
        "recovery_hint": None,
    })
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
        "message_timeout_seconds": MESSAGE_TIMEOUT_SECONDS,
        "channels": channels,
    }


@app.get("/api/token-usage")
def token_usage() -> dict[str, Any]:
    """今日 Token 消耗与节省统计，数据来自 Hermes state.db session_model_usage 表。"""
    import datetime, sqlite3
    today = datetime.date.today()
    today_start = datetime.datetime.combine(today, datetime.time.min).timestamp()
    today_end = datetime.datetime.combine(today, datetime.time.max).timestamp()

    db_path = HERMES_HOME / "state.db"
    if not db_path.is_file():
        return {"ok": True, "available": False, "message": "state.db 不可用"}

    try:
        conn = sqlite3.connect(str(db_path))
        cur = conn.cursor()
        cur.execute("""
            SELECT model, billing_provider,
                   SUM(input_tokens), SUM(output_tokens),
                   SUM(cache_read_tokens), SUM(cache_write_tokens),
                   SUM(api_call_count), MAX(last_seen)
            FROM session_model_usage
            WHERE last_seen >= ?
            GROUP BY model, billing_provider
            ORDER BY SUM(input_tokens + output_tokens) DESC
        """, (today_start,))
        rows = cur.fetchall()
        conn.close()
    except Exception as exc:
        logger.exception("Token 可用性检查失败")
        return {"ok": True, "available": False, "message": "内部错误，请稍后重试"}

    # 成本估算：复用 token-tracker 的 litellm 定价（与 Codex 区块同源）
    try:
        sys.path.insert(0, "/home/agentuser/.local/share/uv/tools/token-tracker/lib/python3.14/site-packages")
        from token_tracker.analyzer.cost import calculate_cost
        from token_tracker.adapters.types import UsageEntry
        from datetime import datetime as _dt, timezone as _tz
        _cost_ok = True
    except Exception:
        _cost_ok = False

    def _estimate_cost(model: str, inp: int, outp: int, cache_r: int) -> float:
        if not _cost_ok:
            return 0.0
        try:
            entry = UsageEntry(
                timestamp=_dt.now(_tz.utc), session_id="", message_id="", request_id="",
                model=model, input_tokens=inp, output_tokens=outp,
                cache_creation_tokens=0, cache_read_tokens=cache_r,
                cost_usd=None, project="", agent_id="hermes",
            )
            return calculate_cost(entry)
        except Exception:
            return 0.0

    total_in = total_out = total_cache_read = total_calls = total_cost = 0
    by_model = []
    for model, prov, inp, outp, cr, cw, calls, last in rows:
        inp = inp or 0
        outp = outp or 0
        cr = cr or 0
        cw = cw or 0
        calls = calls or 0
        cost = _estimate_cost(model, inp, outp, cr)
        total_in += inp
        total_out += outp
        total_cache_read += cr
        total_calls += calls
        total_cost += cost
        by_model.append({
            "model": model,
            "provider": prov,
            "input_tokens": inp,
            "output_tokens": outp,
            "cache_read_tokens": cr,
            "api_calls": calls,
            "cost_usd": round(cost, 4),
            "last_seen": datetime.datetime.fromtimestamp(last).isoformat() if last else None,
        })

    return {
        "ok": True,
        "available": True,
        "date": today.isoformat(),
        "cost_estimates": _cost_ok,
        "total": {
            "input_tokens": total_in,
            "output_tokens": total_out,
            "cache_read_tokens": total_cache_read,
            "total_tokens": total_in + total_out,
            "saved_tokens": total_cache_read,
            "api_calls": total_calls,
            "cost_usd": round(total_cost, 4),
        },
        "by_model": by_model,
    }


@app.get("/api/codex-usage")
def codex_usage(days: int = 14) -> dict[str, Any]:
    """Codex CLI / Claude Code 本地 Token 用量（复用 token-tracker 库，读 ~/.codex transcripts）。

    与 /api/token-usage 互补：后者只统计 Hermes 网关自身请求，本接口统计
    Codex CLI / CC 直连的用量（独立计费，state.db 不覆盖）。
    """
    import json as _json
    script = Path("/home/agentuser/.hermes/scripts/codex-usage-aggregate.py")
    if not script.is_file():
        return {"ok": True, "available": False, "message": "codex-usage-aggregate.py 不存在"}
    days = max(1, min(int(days), 90))
    try:
        result = subprocess.run(
            ["/home/agentuser/.local/share/uv/tools/token-tracker/bin/python", str(script), str(days)],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0:
            return {"ok": True, "available": False, "message": result.stderr.strip()[:200]}
        return _json.loads(result.stdout.strip())
    except (OSError, subprocess.SubprocessError, _json.JSONDecodeError) as exc:
        logger.exception("Codex 用量聚合失败")
        return {"ok": True, "available": False, "message": f"内部错误: {exc}"}


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
        "milestones": evolution_milestones(skill_entries, profile_documents),
        "capabilities": _build_capabilities(skill_entries),
        "skill_tree": evolution_skill_tree(skill_entries),
    }




def open_kanban_db() -> sqlite3.Connection | None:
    if not KANBAN_DB.is_file():
        return None
    try:
        conn = sqlite3.connect(f"file:{KANBAN_DB}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error:
        return None


def epoch_to_iso(value: Any) -> str | None:
    if value is None or value == "":
        return None
    try:
        ts = float(value)
    except (TypeError, ValueError):
        return safe_string(value, limit=64)
    if ts > 1_000_000_000_000:
        ts = ts / 1000.0
    try:
        return datetime.fromtimestamp(ts, timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def map_kanban_status(raw: Any) -> str:
    status = str(raw or "").strip().lower()
    if status == "running":
        return "running"
    if status == "blocked":
        return "blocked"
    if status == "done":
        return "completed"
    if status in {"ready", "todo", "triage", "scheduled"}:
        return "queued"
    if status == "archived":
        return "completed"
    return "failed"


def _row_get(row: sqlite3.Row | dict[str, Any], key: str) -> Any:
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        return None


def latest_block_reason(conn: sqlite3.Connection, task_id: str, task_row: sqlite3.Row | dict[str, Any]) -> str | None:
    try:
        comment = conn.execute(
            """
            SELECT body FROM task_comments
            WHERE task_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 8
            """,
            (task_id,),
        ).fetchall()
    except sqlite3.Error:
        comment = []
    for item in comment:
        body = safe_string(_row_get(item, "body"), limit=240)
        if not body:
            continue
        if "BLOCKED" in body.upper() or "阻塞" in body:
            return body
    try:
        events = conn.execute(
            """
            SELECT kind, payload FROM task_events
            WHERE task_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 12
            """,
            (task_id,),
        ).fetchall()
    except sqlite3.Error:
        events = []
    for item in events:
        kind = str(_row_get(item, "kind") or "").lower()
        payload_raw = _row_get(item, "payload")
        payload_text = ""
        summary = None
        if isinstance(payload_raw, str) and payload_raw.strip():
            payload_text = payload_raw
            try:
                payload_obj = json.loads(payload_raw)
                if isinstance(payload_obj, dict):
                    summary = (
                        payload_obj.get("summary")
                        or payload_obj.get("reason")
                        or payload_obj.get("error")
                        or payload_obj.get("message")
                    )
            except json.JSONDecodeError:
                summary = None
        if kind == "blocked" or "block" in kind:
            text = safe_string(summary or payload_text, limit=240)
            if text:
                return text
    failure = safe_string(_row_get(task_row, "last_failure_error"), limit=240)
    if failure:
        return failure
    body = safe_string(_row_get(task_row, "body"), limit=240)
    return body


def latest_task_comment(conn: sqlite3.Connection, task_id: str) -> str | None:
    try:
        row = conn.execute(
            """
            SELECT body FROM task_comments
            WHERE task_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            """,
            (task_id,),
        ).fetchone()
    except sqlite3.Error:
        return None
    if not row:
        return None
    return safe_string(_row_get(row, "body"), limit=240)


def latest_completion_summary(conn: sqlite3.Connection, task_id: str) -> str | None:
    try:
        rows = conn.execute(
            """
            SELECT kind, payload FROM task_events
            WHERE task_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 20
            """,
            (task_id,),
        ).fetchall()
    except sqlite3.Error:
        return None
    for item in rows:
        kind = str(_row_get(item, "kind") or "").lower()
        if kind not in {"completed", "done"}:
            continue
        payload_raw = _row_get(item, "payload")
        if not isinstance(payload_raw, str) or not payload_raw.strip():
            continue
        try:
            payload_obj = json.loads(payload_raw)
        except json.JSONDecodeError:
            return safe_string(payload_raw, limit=240)
        if isinstance(payload_obj, dict):
            summary = (
                payload_obj.get("summary")
                or payload_obj.get("result")
                or payload_obj.get("message")
            )
            text = safe_string(summary, limit=240)
            if text:
                return text
        return safe_string(payload_raw, limit=240)
    return None


def list_kanban_tasks(include_archived: bool = False, limit: int = 100) -> dict[str, Any]:
    limit = max(1, min(int(limit or 100), 300))
    empty = {
        "available": False,
        "source": str(KANBAN_DB),
        "total": 0,
        "status_counts": {},
        "items": [],
    }
    conn = open_kanban_db()
    if conn is None:
        return empty
    try:
        sql = """
            SELECT id, title, body, assignee, status, priority, created_by,
                   created_at, started_at, completed_at, last_heartbeat_at,
                   last_failure_error, block_kind, result, session_id, worker_pid
            FROM tasks
        """
        params: list[Any] = []
        if not include_archived:
            sql += " WHERE COALESCE(status, '') != 'archived'"
        sql += " ORDER BY COALESCE(last_heartbeat_at, started_at, completed_at, created_at) DESC LIMIT ?"
        params.append(limit)
        rows = conn.execute(sql, params).fetchall()
        items: list[dict[str, Any]] = []
        for row in rows:
            task_id = str(_row_get(row, "id") or "").strip()
            if not task_id:
                continue
            raw_status = str(_row_get(row, "status") or "").strip()
            mapped = map_kanban_status(raw_status)
            block_reason = latest_block_reason(conn, task_id, row)
            latest_comment = latest_task_comment(conn, task_id)
            heartbeat_at = epoch_to_iso(_row_get(row, "last_heartbeat_at"))
            time_value = (
                heartbeat_at
                or epoch_to_iso(_row_get(row, "started_at"))
                or epoch_to_iso(_row_get(row, "completed_at"))
                or epoch_to_iso(_row_get(row, "created_at"))
            )
            result_text = safe_string(_row_get(row, "result"), limit=180)
            completion_summary = latest_completion_summary(conn, task_id)
            if mapped == "blocked":
                detail = block_reason or latest_comment or "任务已阻塞，等待处理"
            elif mapped == "completed":
                detail = result_text or completion_summary or f"Kanban 状态 {raw_status or 'done'}"
            elif mapped == "queued":
                detail = f"等待执行 · 原状态 {raw_status or 'todo'}"
            elif mapped == "running":
                detail = latest_comment or result_text or "Kanban 任务执行中"
            else:
                detail = block_reason or latest_comment or f"Kanban 状态 {raw_status or 'unknown'}"
            agent_id = safe_string(_row_get(row, "assignee"), limit=64) or safe_string(
                _row_get(row, "created_by"), limit=64
            )
            action_url = f"/?view=agent&id={agent_id}" if agent_id else None
            items.append(
                {
                    "id": f"kanban:{task_id}",
                    "kanban_id": task_id,
                    "title": message_title(_row_get(row, "title"), f"Kanban 任务 {task_id}"),
                    "agent_id": agent_id,
                    "status": mapped,
                    "source": "kanban",
                    "time": time_value,
                    "detail": safe_string(detail, limit=240),
                    # blocked: surface block reason; others only surface last_failure_error
                    "fallback_reason": (
                        block_reason
                        if mapped == "blocked"
                        else safe_string(_row_get(row, "last_failure_error"), limit=240)
                    ),
                    "kanban_status": safe_string(raw_status, limit=32),
                    "priority": _row_get(row, "priority"),
                    "block_kind": safe_string(_row_get(row, "block_kind"), limit=64),
                    "latest_comment": latest_comment,
                    "heartbeat_at": heartbeat_at,
                    "session_id": safe_string(_row_get(row, "session_id"), limit=128),
                    "action_url": action_url,
                }
            )
        status_counts = dict(Counter(str(item["status"]) for item in items))
        return {
            "available": True,
            "source": str(KANBAN_DB),
            "total": len(items),
            "status_counts": status_counts,
            "items": items,
        }
    except sqlite3.Error:
        return empty
    finally:
        conn.close()


@app.get("/api/cron")
def cron() -> dict[str, Any]:
    return {"generated_at": utc_now(), **cron_summary()}



@app.get("/api/kanban/tasks")
def kanban_tasks(include_archived: int = 0, limit: int = 100) -> dict[str, Any]:
    payload = list_kanban_tasks(include_archived=bool(include_archived), limit=limit)
    return {"generated_at": utc_now(), **payload}


@app.get("/api/tasks")
def tasks() -> dict[str, Any]:
    items: list[dict[str, Any]] = []

    for job in cron_summary(limit=None).get("jobs", []):
        if not isinstance(job, dict):
            continue
        schedule = safe_string(job.get("schedule")) or "暂无执行计划"
        last_status = safe_string(job.get("status")) or "unknown"
        items.append({
            "id": f"cron:{job.get('id')}",
            "title": safe_string(job.get("name"), limit=120) or "Cron 任务",
            "agent_id": safe_string(job.get("agent_id"), limit=64),
            "status": "running" if job.get("enabled") else "paused",
            "source": "cron",
            "time": task_time_value(job.get("last_run_at") or job.get("next_run_at")),
            "detail": f"计划 {schedule} · 最近状态 {last_status}",
            "fallback_reason": None,
        })

    # Kanban tasks - query once, use for both slices
    kanban_items = list_kanban_tasks(include_archived=False, limit=100).get("items", [])
    for item in kanban_items[:20]:
        items.append({
            "id": item["id"],
            "title": item["title"],
            "agent_id": item.get("agent_id"),
            "status": item["status"],
            "source": "kanban",
            "time": item.get("time"),
            "detail": item.get("detail"),
            "fallback_reason": item.get("fallback_reason"),
            "kanban_status": item.get("kanban_status"),
            "kanban_id": item.get("kanban_id"),
            "priority": item.get("priority"),
            "block_kind": item.get("block_kind"),
            "latest_comment": item.get("latest_comment"),
            "heartbeat_at": item.get("heartbeat_at"),
            "session_id": item.get("session_id"),
            "action_url": item.get("action_url"),
        })

    for record in read_outbox_records():
        queued = record.get("queued") is not False
        items.append({
            "id": f"outbox:{record.get('id')}",
            "title": message_title(record.get("message"), "待补投任务"),
            "agent_id": safe_string(record.get("agent_id"), limit=64),
            "status": "queued" if queued else "failed",
            "source": "outbox",
            "time": task_time_value(record.get("stored_at")),
            "detail": "等待 Hermes 通道恢复后补投" if queued else "补投已中断",
            "fallback_reason": safe_string(record.get("fallback_reason")),
        })

    for record in read_jsonl_records(SENT_FILE):
        items.append({
            "id": f"sent:{record.get('id')}",
            "title": message_title(record.get("message"), "已投递任务"),
            "agent_id": safe_string(record.get("agent_id"), limit=64),
            "status": "completed",
            "source": "sent",
            "time": task_time_value(record.get("delivered_at") or record.get("stored_at")),
            "detail": safe_string(record.get("response_preview"), limit=240) or "已发送到 Hermes",
            "fallback_reason": safe_string(record.get("fallback_reason")),
        })

    gateway_lines = read_recent_lines(GATEWAY_LOG, max_lines=80)
    # 过滤掉飞书网关内部协议日志，只保留真正有价值的用户级事件
    NOISE_PATTERNS = [
        "hermes_plugins.feishu_platform.adapter",
        "gateway.platforms.base: [Feishu] Sending response",
        "gateway.run: Image routing:",
        "gateway.run: inbound message:",
        "gateway.run: response ready:",
        "gateway.run: [Feishu]",
        "Feishu] Received raw",
        "Feishu] Flushing",
        "Feishu] Inbound",
        "Feishu] Received",
        "gateway.stream",
        "gateway.session",
    ]
    for index, line in enumerate(gateway_lines, start=1):
        if any(p in line for p in NOISE_PATTERNS):
            continue
        match = re.match(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})\s+(.+)$", line)
        event_time = (
            datetime.strptime(match.group(1), "%Y-%m-%d %H:%M:%S,%f")
            .replace(tzinfo=SHANGHAI_TZ)
            .isoformat(timespec="milliseconds")
            if match
            else None
        )
        detail = match.group(2) if match else line
        items.append({
            "id": f"gateway:{index}:{event_time or 'unknown'}",
            "title": message_title(detail, "Gateway 事件"),
            "agent_id": None,
            "status": "event",
            "source": "gateway",
            "time": event_time,
            "detail": redact_text(detail, limit=500),
            "fallback_reason": None,
        })

    for item in kanban_items[20:]:
        if isinstance(item, dict):
            items.append({
                "id": item["id"],
                "title": item["title"],
                "agent_id": item.get("agent_id"),
                "status": item["status"],
                "source": "kanban",
                "time": item.get("time"),
                "detail": item.get("detail"),
                "fallback_reason": item.get("fallback_reason"),
                "kanban_status": item.get("kanban_status"),
                "kanban_id": item.get("kanban_id"),
                "priority": item.get("priority"),
                "block_kind": item.get("block_kind"),
                "latest_comment": item.get("latest_comment"),
                "heartbeat_at": item.get("heartbeat_at"),
                "session_id": item.get("session_id"),
                "action_url": item.get("action_url"),
            })

    items.sort(key=lambda item: task_sort_value(item.get("time")), reverse=True)
    status_counts = Counter(str(item["status"]) for item in items)
    return {
        "generated_at": utc_now(),
        "total": len(items),
        "status_counts": dict(status_counts),
        "items": items,
    }


@app.get("/api/workspaces/activity")
def workspace_activity(workspace_name: str) -> dict[str, Any]:
    normalized_name = redact_text(workspace_name.strip(), limit=160)
    if not normalized_name:
        return {
            "generated_at": utc_now(),
            "workspace_name": "",
            "redacted": True,
            "sent": [],
            "outbox": [],
            "tasks": [],
        }

    sent_records = [
        compact_workspace_record(record, "sent")
        for record in read_jsonl_records(SENT_FILE)
        if record_contains_workspace(record, normalized_name)
    ]
    outbox_records = [
        compact_workspace_record(record, "outbox")
        for record in read_outbox_records()
        if record_contains_workspace(record, normalized_name)
    ]
    task_records = [
        item for item in tasks().get("items", [])
        if isinstance(item, dict) and record_contains_workspace(item, normalized_name)
    ]
    sent_records.sort(key=lambda item: task_sort_value(item.get("time")), reverse=True)
    outbox_records.sort(key=lambda item: task_sort_value(item.get("time")), reverse=True)
    return {
        "generated_at": utc_now(),
        "workspace_name": normalized_name,
        "redacted": True,
        "sent": sent_records,
        "outbox": outbox_records,
        "tasks": task_records,
    }


DELEGATION_LIVE = HERMES_HOME / "cache" / "delegation" / "live"


@app.get("/api/delegation/{delegation_id}/tasks")
def delegation_tasks(delegation_id: str) -> dict[str, Any]:
    """Read delegation live tasks from ~/.hermes/cache/delegation/live/<id>/."""
    raw_id = delegation_id.strip()
    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "", raw_id)[:128]
    delegation_root = DELEGATION_LIVE.resolve()
    if not safe_id:
        return {
            "generated_at": utc_now(),
            "delegation_id": safe_id,
            "available": False,
            "tasks": [],
        }
    base = (DELEGATION_LIVE / safe_id).resolve()
    try:
        base.relative_to(delegation_root)
    except ValueError:
        return {
            "generated_at": utc_now(),
            "delegation_id": safe_id,
            "available": False,
            "tasks": [],
        }
    if not base.is_dir():
        return {
            "generated_at": utc_now(),
            "delegation_id": safe_id,
            "available": False,
            "tasks": [],
        }

    manifest_path = base / "manifest.json"
    tasks: list[dict[str, Any]] = []

    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            for t in manifest.get("tasks", []):
                log_path_str = t.get("log")
                log_summary = ""
                if log_path_str:
                    try:
                        log_path = (base / Path(log_path_str)).resolve()
                        log_path.relative_to(base)
                    except (ValueError, OSError):
                        log_path = None
                    if log_path is not None and log_path.is_file():
                        try:
                            lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
                            # Take last 3 non-empty lines as summary
                            non_empty = [l.strip() for l in lines if l.strip() and not l.startswith("===") and not l.startswith("---")]
                            log_summary = " | ".join(non_empty[-3:]) if non_empty else ""
                        except OSError:
                            log_summary = ""
                tasks.append({
                    "index": t.get("index"),
                    "goal": redact_text(t.get("goal") or "", limit=400),
                    "status": t.get("status") or "unknown",
                    "log_summary": log_summary,
                })
        except (OSError, UnicodeError, json.JSONDecodeError):
            pass

    return {
        "generated_at": utc_now(),
        "delegation_id": safe_id,
        "available": True,
        "tasks": tasks,
    }


@app.get("/api/outbox")
def outbox() -> dict[str, Any]:
    records = read_outbox_records()
    stale_count = sum(1 for record in records if outbox_is_stale(record))
    recent = [compact_outbox_record(record) for record in records[-50:]]
    return {
        "generated_at": utc_now(),
        "source": str(OUTBOX_FILE),
        "count": len(records),
        "stale_count": stale_count,
        "stale_after_hours": OUTBOX_STALE_AFTER_HOURS,
        "items": recent,
    }


@app.post("/api/outbox/retry")
def retry_outbox(payload: OutboxRetryRequest) -> dict[str, Any]:
    # 锁内只做快照和状态决策（快，不碰网络），网络投递移出锁外，避免阻塞整个队列。
    # 并发防护：锁内为待处理记录打 lease_id 标记并立即写回，第二个并发请求看到 processing 会跳过。
    with _OUTBOX_LOCK:
        records = read_outbox_records()
        stale_records: list[dict[str, Any]] = []
        pending: list[dict[str, Any]] = []
        for record in records:
            if record.get("processing"):
                continue  # 已有并发重试在投递，跳过
            if not payload.allow_stale and outbox_is_stale(record):
                stale_records.append(record)
                continue
            pending.append(record)
        # 截断到 limit（保持顺序，先到先投）
        to_attempt = pending[: payload.limit]
        untouched = pending[payload.limit:]
        lease_id = f"lease-{uuid.uuid4().hex[:10]}"
        for record in to_attempt:
            record["processing"] = lease_id
        # 写回：stale 原样保留 + 待投递打标 + 未触碰保留
        write_outbox_records(stale_records + to_attempt + untouched)

    attempted = 0
    delivered = 0
    failures: list[dict[str, Any]] = []
    for record in to_attempt:
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
                        sent_clean = {k: v for k, v in record.items() if k not in ("id", "processing")}
                        with _OUTBOX_LOCK:
                            write_sent_record(sent_clean, redact_secret(result, key, limit=240))
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
        failures.append({
            "id": record.get("id"),
            "agent_id": redact_text(agent_id, limit=64),
            "fallback_reason": reason,
        })

    # 锁内合并写回：只移除本 lease 已投递成功的；失败/未触碰/stale 全部保留
    with _OUTBOX_LOCK:
        current = read_outbox_records()
        merged: list[dict[str, Any]] = []
        for rec in current:
            if rec.get("processing") == lease_id:
                if any(f.get("id") == rec.get("id") for f in failures):
                    rec.pop("processing", None)
                    rec["fallback_reason"] = next(f["fallback_reason"] for f in failures if f.get("id") == rec.get("id"))
                    merged.append(rec)
                # 投递成功的记录：从 outbox 移除（已进 sent）
            else:
                merged.append(rec)
        write_outbox_records(merged)

    return {
        "ok": True,
        "attempted": attempted,
        "delivered": delivered,
        "remaining": len(merged),
        "skipped_stale": len(stale_records),
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
                response_preview = redact_secret(result, key, limit=240)
                write_sent_record(
                    {
                        "stored_at": stored_at,
                        "agent_id": agent_id,
                        "message": safe_message,
                        "source": "hermes-office-mobile",
                    },
                    response_preview,
                )
                return {
                    "ok": True,
                    "delivered": True,
                    "queued": False,
                    "channel": "api_server",
                    "agent_id": agent_id,
                    "message_preview": preview,
                    "stored_at": stored_at,
                    "response_preview": response_preview,
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


# ============== v5 Workflow API ==============
class Workflow(BaseModel):
    id: str | None = Field(default=None, max_length=100)
    name: str = Field(..., min_length=1, max_length=100)
    nodes: list = Field(default_factory=list, max_length=50)
    edges: list = Field(default_factory=list, max_length=100)
    created_at: str | None = None
    updated_at: str | None = None


WORKFLOWS_FILE = PROJECT_ROOT / "runtime" / "workflows.json"
WORKFLOWS_LEGACY_FILE = PROJECT_ROOT / "runtime" / "workflows.jsonl"


def _normalize_workflow(item: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    workflow_id = item.get("id")
    name = item.get("name")
    if not isinstance(workflow_id, str) or not workflow_id.strip():
        return None
    if not isinstance(name, str) or not name.strip():
        return None
    return {
        "id": workflow_id.strip(),
        "name": name.strip(),
        "nodes": item.get("nodes") if isinstance(item.get("nodes"), list) else [],
        "edges": item.get("edges") if isinstance(item.get("edges"), list) else [],
        "created_at": item.get("created_at") if isinstance(item.get("created_at"), str) else None,
        "updated_at": item.get("updated_at") if isinstance(item.get("updated_at"), str) else None,
    }


def _load_legacy_workflows() -> list[dict[str, Any]]:
    if not WORKFLOWS_LEGACY_FILE.is_file():
        return []
    try:
        lines = WORKFLOWS_LEGACY_FILE.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    workflows: list[dict[str, Any]] = []
    for line in lines:
        text = line.strip()
        if not text:
            continue
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            continue
        normalized = _normalize_workflow(payload) if isinstance(payload, dict) else None
        if normalized:
            workflows.append(normalized)
    return workflows


def load_workflows() -> list[dict[str, Any]]:
    """Load workflows with id-based upsert semantics. Prefer workflows.json."""
    workflows_by_id: dict[str, dict[str, Any]] = {}

    # Migrate older append-only jsonl if present.
    for item in _load_legacy_workflows():
        workflows_by_id[item["id"]] = item

    if WORKFLOWS_FILE.is_file():
        try:
            payload = json.loads(WORKFLOWS_FILE.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            payload = None
        if isinstance(payload, list):
            for item in payload:
                normalized = _normalize_workflow(item) if isinstance(item, dict) else None
                if normalized:
                    workflows_by_id[normalized["id"]] = normalized
        elif isinstance(payload, dict) and isinstance(payload.get("workflows"), list):
            for item in payload["workflows"]:
                normalized = _normalize_workflow(item) if isinstance(item, dict) else None
                if normalized:
                    workflows_by_id[normalized["id"]] = normalized

    workflows = list(workflows_by_id.values())
    workflows.sort(key=lambda item: item.get("updated_at") or item.get("created_at") or "", reverse=True)
    return workflows


def save_workflows(workflows: list[dict[str, Any]]) -> None:
    WORKFLOWS_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {"ok": True, "workflows": workflows, "updated_at": utc_now()}
    # 原子写：先写临时文件再 os.replace，避免崩溃损坏 JSON
    tmp_path = WORKFLOWS_FILE.with_suffix(".json.tmp")
    tmp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    tmp_path.replace(WORKFLOWS_FILE)


def upsert_workflow(workflow: dict[str, Any]) -> dict[str, Any]:
    with _WORKFLOWS_LOCK:
        workflows = load_workflows()
        workflow_id = str(workflow.get("id") or "").strip() or f"wf-{int(datetime.now().timestamp() * 1000)}"
        now = utc_now()
        existing = next((item for item in workflows if item.get("id") == workflow_id), None)
        record = {
            "id": workflow_id,
            "name": str(workflow.get("name") or "未命名工作流").strip() or "未命名工作流",
            "nodes": workflow.get("nodes") if isinstance(workflow.get("nodes"), list) else [],
            "edges": workflow.get("edges") if isinstance(workflow.get("edges"), list) else [],
            "created_at": (
                existing.get("created_at")
                if existing and isinstance(existing.get("created_at"), str)
                else (workflow.get("created_at") if isinstance(workflow.get("created_at"), str) else now)
            ),
            "updated_at": now,
        }
        next_workflows = [item for item in workflows if item.get("id") != workflow_id]
        next_workflows.insert(0, record)
        save_workflows(next_workflows)
        return record


@app.get("/api/workflows")
def list_workflows():
    workflows = load_workflows()
    return {"ok": True, "workflows": workflows, "count": len(workflows)}


@app.post("/api/workflows")
def save_workflow_api(workflow: Workflow):
    data = workflow.model_dump()
    try:
        record = upsert_workflow(data)
    except OSError as exc:
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "error": f"工作流保存失败：{type(exc).__name__}",
            },
        )
    return {
        "ok": True,
        "workflow": record,
        "message": "工作流已按 id upsert 保存到服务器",
        "mode": "upsert",
    }


@app.post("/api/experts/summarize")
async def summarize_expert_batch(batch_id: str | None = None):
    """聚合同 batch_id 的三条专家回复，调用 LLM 合成结论。"""
    import yaml, urllib.request

    # ── 1. 读取路由配置（只读一次） ────────────────────────────
    try:
        with open("/home/agentuser/.hermes/config/model_route_table.yaml") as f:
            route_cfg = yaml.safe_load(f)
        cc_routes = route_cfg.get("routes", {}).get("claude_code", [])
        if not cc_routes:
            return JSONResponse(status_code=500, content={"error": "路由表无 claude_code 条目"})
        top = cc_routes[0]
        llm_base_url = top["base_url"]
        llm_model = top["model"]
        api_key = top.get("key") or top.get("api_key")
        if not api_key:
            env_path = Path("/home/agentuser/.hermes/.env")
            for line in env_path.read_text(encoding="utf-8").splitlines():
                if line.startswith("GY_API_KEY="):
                    api_key = line.split("=", 1)[1].strip()
                    break
        if not api_key:
            return JSONResponse(status_code=500, content={"error": "API key 未找到"})
    except Exception:
        logger.exception("summarize 配置读取失败")
        return JSONResponse(status_code=500, content={"error": "配置读取失败"})

    # ── 3. 找同 batch_id 的三条专家回复 ───────────────────────
    try:
        with open(SENT_FILE, encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return JSONResponse(status_code=404, content={"error": "sent.jsonl 不存在"})

    batch_msgs = {}
    found_batch_id = batch_id  # None if not specified
    for line in reversed(lines):
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        bid = rec.get("batch_id")
        # 锁定第一个遇到的 bid；未指定时跳过无 batch_id 的普通记录，避免混批
        if found_batch_id is None:
            if not bid:
                continue
            found_batch_id = bid
        if bid != found_batch_id:
            continue
        agent = rec.get("agent_id", "unknown")
        resp = rec.get("response") or rec.get("response_preview", "")
        if agent not in batch_msgs:
            batch_msgs[agent] = resp
        if len(batch_msgs) >= 2:
            break

    if len(batch_msgs) < 1:
        return JSONResponse(status_code=404, content={
            "error": f"batch_id={batch_id or found_batch_id} 专家回复不足1条",
            "found": len(batch_msgs),
            "agents": list(batch_msgs.keys())
        })

    # ── 4. 调用 LLM 合成 ──────────────────────────────────────
    summarize_prompt = (
        "你是小黑，负责把专家们的回答聚合成一段简洁结论（100字以内）。\n\n"
        + "\n".join([f"【{k}】: {v}" for k, v in batch_msgs.items()])
    )

    import asyncio
    def _sync_call(url, key, model, prompt):
        body = json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}], "max_tokens": 300}).encode()
        req = urllib.request.Request(url, data=body, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}, method="POST")
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())["choices"][0]["message"]["content"]

    loop = asyncio.get_running_loop()
    try:
        summary = await loop.run_in_executor(None, lambda: _sync_call(f"{llm_base_url}/v1/chat/completions", api_key, llm_model, summarize_prompt))
    except Exception:
        logger.exception("summarize LLM 调用失败")
        return JSONResponse(status_code=502, content={"error": "LLM 调用失败"})

    return {
        "ok": True,
        "summary": summary,
        "batch_id": batch_id or found_batch_id,
        "source_agents": list(batch_msgs.keys()),
    }


@app.post("/api/kanban/unblock/{task_id}")
async def kanban_unblock(task_id: str):
    """调用 hermes kanban promote 解除阻塞。"""
    import re
    if not re.match(r"^[a-z0-9_-]{1,64}$", task_id):
        return {"ok": False, "error": "invalid task_id format"}
    import subprocess
    try:
        r = subprocess.run(
            ["hermes", "kanban", "promote", task_id],
            capture_output=True, text=True, timeout=20,
            env={**__import__("os").environ, "HERMES_HOME": "/home/agentuser/.hermes"},
        )
        if r.returncode != 0:
            logger.warning("kanban promote 失败 task_id=%s stderr=%s", task_id, r.stderr[:200])
        return {
            "ok": r.returncode == 0,
            "task_id": task_id,
        }
    except Exception:
        logger.exception("kanban promote 执行失败")
        return JSONResponse(status_code=500, content={"error": "内部错误，请稍后重试"})


def _safe_topic_file(path: Path) -> Path | None:
    """安全检查选题文件：拒绝符号链接/非常规文件，防止 /tmp 符号链接劫持。"""
    try:
        st = path.lstat()
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode):
        return None
    # 确认非符号链接（lstat 已保证，再 resolve 校验最终路径不越界）
    try:
        resolved = path.resolve(strict=True)
    except OSError:
        return None
    if str(resolved) != str(path):
        return None
    return path


@app.get("/api/topics")
async def get_topics():
    """返回选题列表，优先读当天文件，文件过期或不存在则返回空列表。"""
    from datetime import datetime
    today = datetime.now().strftime("%Y-%m-%d")
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

    # 优先 runtime 私有目录（无符号链接风险）
    runtime_topic = PROJECT_ROOT / "runtime" / f"topics_{today}.md"
    runtime_fallback = PROJECT_ROOT / "runtime" / f"topics_{yesterday}.md"
    topic_file = _safe_topic_file(runtime_topic) or _safe_topic_file(runtime_fallback)
    if topic_file is None:
        # 兼容旧写入方：/tmp 路径，但必须通过符号链接校验
        topic_file = _safe_topic_file(Path(f"/tmp/topics_{today}.md"))
    if topic_file is None:
        topic_file = _safe_topic_file(Path(f"/tmp/topics_{yesterday}.md"))
    source_file = topic_file

    if source_file is None or not source_file.exists():
        return {"ok": True, "topics": [], "source": "none", "message": "暂无选题数据"}

    # 检查是否过期（超过48小时）
    age_hours = (datetime.now().timestamp() - source_file.stat().st_mtime) / 3600
    if age_hours > 48:
        return {"ok": True, "topics": [], "source": "expired", "message": "选题数据已过期"}

    try:
        content = source_file.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return {"ok": True, "topics": [], "source": "read_error"}
    topics = []
    current = {}
    for line in content.splitlines():
        line = line.strip()
        if ("【" in line and "】" in line) or line.startswith("标题：") or line.startswith("标题 "):
            if current and current.get("title"):
                topics.append(current)
                current = {}
            # 格式：【标题】 或 标题：xxx 或 1. 标题：xxx
            if "【" in line and "】" in line:
                title = line.split("【", 1)[-1].split("】", 1)[0].strip()
            else:
                title = line.split("：", 1)[-1].strip() if "：" in line else line.split(".", 1)[-1].strip()
            current["title"] = title
        elif line.startswith("平台："):
            current["platform"] = line.split("：", 1)[-1].strip()
        elif line.startswith("理由：") or line.startswith("推荐理由："):
            current["reason"] = line.split("：", 1)[-1].strip()
        elif line.startswith("价值："):
            current["value"] = line.split("：", 1)[-1].strip()
    if current and current.get("title"):
        topics.append(current)

    # 补全默认值
    for t in topics:
        t.setdefault("platform", "公众号")
        t.setdefault("reason", "")
        t.setdefault("value", "")

    return {
        "ok": True,
        "topics": topics,
        "source": source_file.name,
        "generated_at": datetime.fromtimestamp(source_file.stat().st_mtime).isoformat(),
    }


@app.post("/api/workflows/execute")
async def execute_workflow(payload: dict):
    """Honest simulated execution until real Hermes node runner lands."""
    if not isinstance(payload, dict):
        payload = {}
    workflow_name = payload.get("name") if isinstance(payload.get("name"), str) else "Unnamed"
    raw_nodes = payload.get("nodes")
    raw_edges = payload.get("edges")
    nodes: list[Any] = raw_nodes if isinstance(raw_nodes, list) else []
    edges: list[Any] = raw_edges if isinstance(raw_edges, list) else []
    return {
        "ok": True,
        "mode": "simulated",
        "delivered": False,
        "queued": False,
        "result": f"工作流「{workflow_name}」模拟运行完成，尚未调用 Hermes",
        "message": "当前为模拟执行，不会真正调用 Hermes API Server / outbox",
        "executed_nodes": len(nodes),
        "edge_count": len(edges),
        "timestamp": utc_now(),
    }


# ─────────────────────────────────────────────────────────────────────────────
# 深度分析串行流水线端点
# ─────────────────────────────────────────────────────────────────────────────

class PipelineRequest(BaseModel):
    workspace_name: str
    goal: str
    question: str
    member_ids: list[str] = ["default", "media-ops", "investor"]
    pipeline_type: str = "serial"


def _sync_llm_call(url: str, key: str, model: str, prompt: str, max_tokens: int = 500) -> str:
    """同步调用 LLM，返回文本内容。"""
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens
    }).encode()
    req = urllib.request.Request(
        url, data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())["choices"][0]["message"]["content"]


def _read_agent_response(batch_id: str, target_agent: str | None = None) -> dict[str, str]:
    """从 sent.jsonl 读取指定 batch_id 的回复。返回 {agent_id: response_preview}。"""
    try:
        with open(SENT_FILE, encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return {}

    batch_msgs: dict[str, str] = {}
    found_batch_id: str | None = batch_id

    for line in reversed(lines):
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        bid = rec.get("batch_id")
        if found_batch_id is None:
            # 未指定批次时：跳过无 batch_id 的普通记录，锁定最新的非空批次
            if not bid:
                continue
            found_batch_id = bid
        if bid != found_batch_id:
            continue
        agent = rec.get("agent_id", "unknown")
        # 优先完整 response，旧格式回退 response_preview
        resp = rec.get("response") or rec.get("response_preview", "")
        if target_agent and agent != target_agent:
            continue
        if agent not in batch_msgs:
            batch_msgs[agent] = resp
        # 如果指定了 target_agent，只取一条
        if target_agent and len(batch_msgs) >= 1:
            break
        # 否则取完所有（通常 3 个 agent）
        if len(batch_msgs) >= 3:
            break

    return batch_msgs


def _wait_for_response(batch_id: str, agent_id: str, timeout: int = 30) -> str | None:
    """轮询等待某个 agent 的回复。"""
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        results = _read_agent_response(batch_id, agent_id)
        if agent_id in results and results[agent_id]:
            return results[agent_id]
        time.sleep(1)
    return None


def _get_llm_config() -> tuple[str, str, str]:
    """读取 LLM 配置：base_url, model, api_key。
    默认使用 Dragon relay，可通过 DRAGON_BASE_URL / DRAGON_MODEL 覆盖。"""
    dragon_key = os.environ.get("DRAGON_API_KEY", "")
    if not dragon_key:
        raise ValueError("DRAGON_API_KEY 未配置：请设置环境变量 DRAGON_API_KEY")

    return (
        DRAGON_BASE_URL,
        DRAGON_MODEL,
        dragon_key,
    )


def _send_to_hermes(agent_id: str, message: str, batch_id: str) -> dict[str, Any]:
    """通过 Hermes 发送消息到指定 agent，并落盘响应供批次汇总。"""
    profile_map = {
        "default": ("mimo-sg1", 8642),
        "media-ops": ("mimo-sg2", 8650),
        "investor": ("mimo-sg3", 8660),
    }
    profile_name, port = profile_map.get(agent_id, ("mimo-sg1", 8642))

    payload = {
        "jsonrpc": "2.0",
        "method": "user_message",
        "params": {
            "message": message,
            "stream": False,
        },
        "id": f"pipeline-{batch_id}-{agent_id}",
    }

    body = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json", "User-Agent": "Hermes-BFF/1.0"}

    try:
        req = urllib.request.Request(
            f"http://localhost:{port}/rpc",
            data=body,
            headers=headers,
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=MESSAGE_TIMEOUT_SECONDS) as resp:
            result = json.loads(resp.read())

        # JSON-RPC error 也算失败（HTTP 200 但业务错误）
        if result.get("error"):
            logger.warning("JSON-RPC 返回错误 agent=%s error=%s", agent_id, str(result["error"])[:200])
            return {"ok": False, "delivered": False, "error": "agent 返回错误"}

        # 提取完整响应文本（兼容字符串/对象结构）
        response_text = _extract_rpc_response(result)
        if not response_text:
            return {"ok": False, "delivered": False, "error": "agent 响应为空"}

        # 落盘：带 batch_id + 完整 response（供批次汇总/审计），response_preview 仅界面展示用
        write_sent_record(
            {
                "stored_at": utc_now(),
                "batch_id": batch_id,
                "agent_id": agent_id,
                "message": redact_text(message, limit=4000),
                "source": "expert_pipeline",
                "record_type": "expert_response",
                "response": redact_text(response_text, limit=20000),
            },
            response_preview=redact_text(response_text, limit=240),
        )
        return {"ok": True, "delivered": True, "response": response_text, "result": result}
    except Exception as exc:
        logger.exception("消息投递失败")
        return {"ok": False, "delivered": False, "error": "内部错误，请稍后重试"}


def _extract_rpc_response(result: dict[str, Any]) -> str:
    """从 JSON-RPC result 中提取模型回复文本（兼容字符串/对象结构）。"""
    inner = result.get("result")
    if isinstance(inner, str):
        return inner
    if isinstance(inner, dict):
        # 兼容 {message: {content: ...}} / {content: ...} / {response: ...} / {output: ...}
        msg = inner.get("message")
        if isinstance(msg, dict):
            content = msg.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                parts = []
                for item in content:
                    if isinstance(item, dict) and isinstance(item.get("text"), str):
                        parts.append(item["text"])
                if parts:
                    return "\n".join(parts)
        for key in ("content", "response", "output", "text", "reply"):
            value = inner.get(key)
            if isinstance(value, str) and value.strip():
                return value
        if isinstance(inner.get("choices"), list) and inner["choices"]:
            choice = inner["choices"][0]
            if isinstance(choice, dict):
                message = choice.get("message")
                if isinstance(message, dict) and isinstance(message.get("content"), str):
                    return message["content"]
    return ""


def _execute_expert_pipeline(req: PipelineRequest, batch_id: str) -> dict[str, Any]:
    """
    深度分析串行流水线：
    1. 小黑(CEO) 先回答 → 获取回复
    2. 叠加上下文 → 小橙(PM) 回答 → 获取回复
    3. 叠加上下文 → 小金(CS) 回答 → 获取回复
    4. LLM 综合所有回复生成最终报告
    """
    steps: list[dict[str, Any]] = []
    context_so_far: dict[str, str] = {}

    # 确定需要执行的角色顺序
    # CEO → PM → CS，只执行在 member_ids 中的
    role_order = ["default", "media-ops", "investor"]
    role_prompts = {
        "default": "你正在参与工作空间“{workspace}”的深度分析。请从主控汇总视角梳理问题、协调判断，并形成可供后续汇总的执行意见。\n\n原始问题：{question}",
        "media-ops": "你正在参与工作空间“{workspace}”的深度分析。\n\nCEO（小黑）的分析：\n{ceo_response}\n\n请在此基础上，从内容传播视角分析受众、表达、渠道与传播执行重点。",
        "investor": "你正在参与工作空间“{workspace}”的深度分析。\n\nCEO（小黑）的分析：\n{ceo_response}\n\nPM（小橙）的分析：\n{pm_response}\n\n请在此基础上，从商业风险视角分析价值、成本、回报、约束与潜在风险。",
    }

    # ── Step 1: 小黑（CEO）────────────────────────────────────────────
    if "default" in req.member_ids:
        step: dict[str, Any] = {"agent_id": "default", "status": "pending"}
        steps.append(step)

        prompt = role_prompts["default"].format(
            workspace=req.workspace_name,
            question=req.question,
        )
        step["status"] = "running"
        send_result = _send_to_hermes("default", prompt, batch_id)
        if send_result.get("delivered"):
            # 优先用同步返回的完整响应（落盘已做），异步兜底轮询
            response = send_result.get("response") or _wait_for_response(batch_id, "default", timeout=40)
            if response:
                context_so_far["default"] = response
                step["status"] = "done"
                step["response_preview"] = response[:200] + "..." if len(response) > 200 else response
            else:
                step["status"] = "error"
                step["error"] = "等待回复超时"
        else:
            step["status"] = "offline"
            step["error"] = send_result.get("error", "发送失败")
    else:
        # 跳过但占位
        steps.append({"agent_id": "default", "status": "skipped", "reason": "未在成员列表中"})

    # ── Step 2: 小橙（PM）─────────────────────────────────────────────
    if "media-ops" in req.member_ids:
        step = {"agent_id": "media-ops", "status": "pending"}
        steps.append(step)

        ceo_resp = context_so_far.get("default", "（小黑未参与或无回复）")
        prompt = role_prompts["media-ops"].format(
            workspace=req.workspace_name,
            ceo_response=ceo_resp,
        )
        step["status"] = "running"
        send_result = _send_to_hermes("media-ops", prompt, batch_id)
        if send_result.get("delivered"):
            response = send_result.get("response") or _wait_for_response(batch_id, "media-ops", timeout=40)
            if response:
                context_so_far["media-ops"] = response
                step["status"] = "done"
                step["response_preview"] = response[:200] + "..." if len(response) > 200 else response
            else:
                step["status"] = "error"
                step["error"] = "等待回复超时"
        else:
            step["status"] = "offline"
            step["error"] = send_result.get("error", "发送失败")
    else:
        steps.append({"agent_id": "media-ops", "status": "skipped", "reason": "未在成员列表中"})

    # ── Step 3: 小金（CS）────────────────────────────────────────────
    if "investor" in req.member_ids:
        step = {"agent_id": "investor", "status": "pending"}
        steps.append(step)

        ceo_resp = context_so_far.get("default", "（小黑未参与或无回复）")
        pm_resp = context_so_far.get("media-ops", "（小橙未参与或无回复）")
        prompt = role_prompts["investor"].format(
            workspace=req.workspace_name,
            ceo_response=ceo_resp,
            pm_response=pm_resp,
        )
        step["status"] = "running"
        send_result = _send_to_hermes("investor", prompt, batch_id)
        if send_result.get("delivered"):
            response = send_result.get("response") or _wait_for_response(batch_id, "investor", timeout=40)
            if response:
                context_so_far["investor"] = response
                step["status"] = "done"
                step["response_preview"] = response[:200] + "..." if len(response) > 200 else response
            else:
                step["status"] = "error"
                step["error"] = "等待回复超时"
        else:
            step["status"] = "offline"
            step["error"] = send_result.get("error", "发送失败")
    else:
        steps.append({"agent_id": "investor", "status": "skipped", "reason": "未在成员列表中"})

    # ── Step 4: LLM 综合生成最终报告 ─────────────────────────────────
    final_report = ""
    synthesize_error = ""

    if context_so_far:
        try:
            llm_base_url, llm_model, api_key = _get_llm_config()
            synthesize_prompt = (
                "你是一个专业的商业分析报告撰写助手。请根据以下三位专家的分析，"
                "撰写一份结构化的深度分析报告。\n\n"
                + "\n\n".join([
                    f"【{k}专家】: {v}" for k, v in context_so_far.items()
                ])
                + "\n\n请综合以上分析，生成一份完整、专业的深度分析报告，包括：\n"
                "1. 执行摘要\n2. 各维度分析（整合 CEO/PM/CS 视角）\n3. 综合结论与建议"
            )

            final_report = _sync_llm_call(
                f"{llm_base_url}/v1/chat/completions",
                api_key,
                llm_model,
                synthesize_prompt,
                max_tokens=800,
            )
        except Exception as exc:
            logger.exception("专家结论综合失败")
            synthesize_error = "内部错误，请稍后重试"
            # 降级：拼接各专家回复
            final_report = "\n\n---\n\n".join([
                f"【{k}专家】: {v}" for k, v in context_so_far.items()
            ])
    else:
        final_report = "⚠️ 所有 Agent 均未成功回复，无法生成报告。请检查各 Agent 在线状态。"

    return {
        "ok": True,
        "batch_id": batch_id,
        "steps": steps,
        "context_collected": context_so_far,
        "final_report": final_report,
        "synthesize_error": synthesize_error if synthesize_error else None,
        "pipeline_type": req.pipeline_type,
        "workspace_name": req.workspace_name,
    }


def _update_pipeline_job(batch_id: str, **updates: Any) -> None:
    with PIPELINE_JOBS_LOCK:
        job = PIPELINE_JOBS.get(batch_id)
        if job is not None:
            job.update(updates)


def _cleanup_pipeline_job(batch_id: str) -> None:
    """Remove a completed/failed pipeline job from memory after a grace period."""
    with PIPELINE_JOBS_LOCK:
        PIPELINE_JOBS.pop(batch_id, None)


def _run_pipeline_job(req: PipelineRequest, batch_id: str) -> None:
    _update_pipeline_job(batch_id, status="running")
    try:
        result = _execute_expert_pipeline(req, batch_id)
    except Exception as exc:
        _update_pipeline_job(
            batch_id,
            status="failed",
            final_report="",
            synthesize_error=f"{type(exc).__name__}: {exc}",
        )
        threading.Timer(3600, _cleanup_pipeline_job, args=[batch_id]).start()
        return
    _update_pipeline_job(batch_id, status="completed", **result)
    threading.Timer(3600, _cleanup_pipeline_job, args=[batch_id]).start()


@app.post("/api/experts/pipeline")
async def run_expert_pipeline(req: PipelineRequest):
    batch_id = f"pipeline-{datetime.now().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:6]}"
    role_order = ["default", "media-ops", "investor"]
    steps = [
        {"agent_id": agent_id, "status": "pending" if agent_id in req.member_ids else "skipped", **(
            {} if agent_id in req.member_ids else {"reason": "未在成员列表中"}
        )}
        for agent_id in role_order
    ]
    job = {
        "ok": True,
        "status": "queued",
        "batch_id": batch_id,
        "steps": steps,
        "context_collected": {},
        "final_report": "",
        "synthesize_error": None,
        "pipeline_type": req.pipeline_type,
        "workspace_name": req.workspace_name,
    }
    with PIPELINE_JOBS_LOCK:
        PIPELINE_JOBS[batch_id] = job
    PIPELINE_EXECUTOR.submit(_run_pipeline_job, req.model_copy(deep=True), batch_id)
    return job


@app.get("/api/experts/pipeline/{batch_id}")
async def get_expert_pipeline(batch_id: str):
    with PIPELINE_JOBS_LOCK:
        job = PIPELINE_JOBS.get(batch_id)
    if job is None:
        return JSONResponse(status_code=404, content={"ok": False, "error": "pipeline_not_found"})
    return dict(job)


# ────────────────────────────────────────────────────────────
# 重构 v3：成长记录 / 知识库 / 用量趋势（真实数据，无 mock）
# ────────────────────────────────────────────────────────────

GROWTH_PREFIX_MAP = {
    "【成长】": "growth",
    "【决策】": "decision",
    "【踩坑】": "pitfall",
    "【复盘】": "review",
    "[成长]": "growth",
    "[决策]": "decision",
    "[踩坑]": "pitfall",
    "[复盘]": "review",
}


def _wiki_file_count(directory: str) -> int:
    path = WIKI_HOME / directory
    if not path.is_dir():
        return 0
    try:
        return sum(
            1
            for item in path.rglob("*")
            if item.is_file() and not item.name.startswith(".")
        )
    except OSError:
        return 0


def _kanban_growth_records(conn: sqlite3.Connection, limit: int = 30) -> list[dict[str, Any]]:
    try:
        rows = conn.execute(
            "SELECT id, title, status, created_at FROM tasks ORDER BY created_at DESC LIMIT 300"
        ).fetchall()
    except sqlite3.Error:
        return []
    records: list[dict[str, Any]] = []
    for row in rows:
        title = safe_string(_row_get(row, "title"), limit=160) or ""
        prefix = next((p for p in GROWTH_PREFIX_MAP if title.startswith(p)), None)
        if not prefix:
            continue
        records.append({
            "id": f"kanban:{_row_get(row, 'id')}",
            "type": GROWTH_PREFIX_MAP[prefix],
            "title": title,
            "date": epoch_to_iso(_row_get(row, "created_at")),
            "status": map_kanban_status(_row_get(row, "status")),
            "source": "kanban",
        })
        if len(records) >= limit:
            break
    return records


def _wiki_idea_records(limit: int = 30) -> list[dict[str, Any]]:
    ideas_dir = WIKI_HOME / "想法"
    records: list[dict[str, Any]] = []
    if not ideas_dir.is_dir():
        return records
    entries = [
        item
        for item in ideas_dir.iterdir()
        if item.is_file() and item.suffix == ".md" and not item.name.startswith(".")
    ]
    entries.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for item in entries:
        kind = "idea"
        try:
            text = item.read_text(encoding="utf-8", errors="replace")[:800]
            if "type: case" in text:
                kind = "case"
        except OSError:
            text = ""
        records.append({
            "id": f"wiki:{item.name}",
            "type": kind,
            "title": item.stem,
            "date": iso_mtime(item),
            "status": "done",
            "source": "wiki",
        })
        if len(records) >= limit:
            break
    return records


def _skill_iteration_records(limit: int = 20) -> list[dict[str, Any]]:
    entries = [item for item in directory_children(SKILLS_HOME) if item.is_dir()]
    entries.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    records: list[dict[str, Any]] = []
    for item in entries:
        mtime = file_modified_datetime(item)
        if mtime is None:
            continue
        records.append({
            "id": f"skill:{item.name}",
            "type": "skill",
            "title": item.name,
            "date": mtime.isoformat(),
            "status": "done",
            "source": "skill",
        })
        if len(records) >= limit:
            break
    return records


def _wiki_git_records(limit: int = 20) -> list[dict[str, Any]]:
    try:
        result = subprocess.run(
            [
                "git", "-C", str(WIKI_HOME), "log", f"-{limit}",
                "--date=iso-strict", "--pretty=format:%h%x1f%aI%x1f%s%x1e",
            ],
            capture_output=True, text=True, timeout=8,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if result.returncode != 0:
        return []
    records: list[dict[str, Any]] = []
    for chunk in result.stdout.split("\x1e"):
        parts = chunk.strip().split("\x1f")
        if len(parts) < 3:
            continue
        records.append({
            "id": f"git:{parts[0]}",
            "type": "knowledge",
            "title": safe_string(parts[2], limit=120) or parts[0],
            "date": parts[1],
            "status": "done",
            "source": "wiki-git",
        })
    return records


def _merge_growth_records(*groups: list[dict[str, Any]], limit: int = 50) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for group in groups:
        merged.extend(group)
    merged.sort(key=lambda item: item.get("date") or "", reverse=True)
    return merged[:limit]


@app.get("/api/growth")
def growth(limit: int = 50) -> dict[str, Any]:
    """聚合成长记录：决策/踩坑/复盘（kanban）+ 想法/案例（wiki）+ skill 迭代 + 知识库提交。"""
    kanban_records: list[dict[str, Any]] = []
    conn = open_kanban_db()
    if conn is not None:
        try:
            kanban_records = _kanban_growth_records(conn)
        finally:
            conn.close()
    records = _merge_growth_records(
        kanban_records,
        _wiki_idea_records(),
        _skill_iteration_records(),
        _wiki_git_records(),
        limit=limit,
    )
    summary: Counter[str] = Counter()
    for record in records:
        summary[record["type"]] += 1
    return {
        "generated_at": utc_now(),
        "available": WIKI_HOME.is_dir() or conn is not None,
        "total": len(records),
        "summary": dict(summary),
        "records": records,
    }


@app.get("/api/knowledge")
def knowledge() -> dict[str, Any]:
    """知识库统计：wiki 目录规模、近 7 天入库趋势、最近提交。"""
    counts = {
        "来源": _wiki_file_count("来源"),
        "概念": _wiki_file_count("概念"),
        "对比": _wiki_file_count("对比"),
        "实体": _wiki_file_count("实体"),
        "想法": _wiki_file_count("想法"),
    }
    total = sum(counts.values())
    all_files: list[Path] = []
    for directory in ("来源", "概念", "对比", "实体", "想法"):
        path = WIKI_HOME / directory
        if not path.is_dir():
            continue
        try:
            all_files.extend(
                item
                for item in path.rglob("*")
                if item.is_file() and not item.name.startswith(".")
            )
        except OSError:
            continue
    today = datetime.now(SHANGHAI_TZ).date()
    trend: list[dict[str, Any]] = []
    for offset in range(6, -1, -1):
        day = today - timedelta(days=offset)
        count = 0
        for item in all_files:
            mtime = file_modified_datetime(item)
            if mtime is not None and mtime.astimezone(SHANGHAI_TZ).date() == day:
                count += 1
        trend.append({"date": day.isoformat(), "files_added": count})
    return {
        "generated_at": utc_now(),
        "available": WIKI_HOME.is_dir(),
        "counts": counts,
        "total": total,
        "trend": trend,
        "recent_commits": _wiki_git_records(limit=15),
    }


DATA_DIR = PROJECT_ROOT / "data"


@app.get("/api/knowledge/topics")
def knowledge_topics() -> dict[str, Any]:
    """返回知识库主题列表及其前 50 个文件。"""
    index_path = DATA_DIR / "wiki_topic_index.json"
    try:
        with index_path.open("r", encoding="utf-8") as handle:
            index = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {
            "generated_at": None,
            "model": None,
            "total_files": 0,
            "topics": [],
        }

    topics: list[dict[str, Any]] = []
    for topic in index.get("topics", []):
        if not isinstance(topic, dict):
            continue
        files = topic.get("files", [])
        if not isinstance(files, list):
            files = []
        topics.append(
            {
                "name": topic.get("name", ""),
                "count": topic.get("count", len(files)),
                "files": files[:50],
            }
        )

    return {
        "generated_at": index.get("generated_at"),
        "model": index.get("model"),
        "total_files": index.get("total_files", 0),
        "topics": topics,
    }


@app.get("/api/knowledge/topic/{name}")
def knowledge_topic(name: str):
    """返回指定主题的完整文件列表。"""
    from urllib.parse import unquote

    topic_name = unquote(name)
    index_path = DATA_DIR / "wiki_topic_index.json"

    try:
        with index_path.open("r", encoding="utf-8") as handle:
            index = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return JSONResponse(
            status_code=404,
            content={"detail": "知识地图索引不可用"},
        )

    for topic in index.get("topics", []):
        if not isinstance(topic, dict) or topic.get("name") != topic_name:
            continue

        raw_files = topic.get("files", [])
        files: list[dict[str, Any]] = []
        if isinstance(raw_files, list):
            for item in raw_files:
                if not isinstance(item, dict):
                    continue
                path = str(item.get("path", ""))
                files.append(
                    {
                        "path": path,
                        "name": Path(path).name,
                        "reason": item.get("reason", ""),
                    }
                )

        return {
            "name": topic_name,
            "count": topic.get("count", len(files)),
            "files": files,
        }

    return JSONResponse(
        status_code=404,
        content={"detail": f"未找到主题：{topic_name}"},
    )


@app.get("/api/knowledge/graph")
def knowledge_graph(topic: str = "") -> dict[str, Any]:
    """概念知识图谱：节点=概念，边=双链。可选 topic 过滤。"""
    graph_path = DATA_DIR / "wiki_graph.json"
    try:
        with graph_path.open("r", encoding="utf-8") as handle:
            graph = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {"available": False, "nodes": [], "edges": []}

    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])
    if not isinstance(nodes, list):
        nodes = []
    if not isinstance(edges, list):
        edges = []

    if topic:
        # 过滤：只保留该主题的节点 + 两端都在内的边
        node_ids = {n["id"] for n in nodes if n.get("topic") == topic}
        filtered_nodes = [n for n in nodes if n.get("topic") == topic]
        filtered_edges = [
            e for e in edges
            if e.get("source") in node_ids and e.get("target") in node_ids
        ]
        return {"available": True, "topic": topic, "nodes": filtered_nodes, "edges": filtered_edges}

    return {"available": True, "nodes": nodes, "edges": edges}



@app.get("/api/usage/trend")
def usage_trend(days: int = 14) -> dict[str, Any]:
    """Token 用量趋势：按天聚合 state.db 最近 N 天（默认 14，范围 7-90）。"""
    days = max(7, min(days, 90))
    db_path = HERMES_HOME / "state.db"
    if not db_path.is_file():
        return {"ok": True, "available": False, "message": "state.db 不可用"}
    today = datetime.now(SHANGHAI_TZ).date()
    start = datetime.combine(
        today - timedelta(days=days - 1), datetime.min.time(), tzinfo=SHANGHAI_TZ
    ).timestamp()
    try:
        conn = sqlite3.connect(str(db_path))
        cur = conn.cursor()
        cur.execute(
            """
            SELECT date(last_seen, 'unixepoch', '+8 hours') AS day,
                   SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(api_call_count)
            FROM session_model_usage
            WHERE last_seen >= ?
            GROUP BY day
            ORDER BY day
            """,
            (start,),
        )
        rows = cur.fetchall()
        conn.close()
    except sqlite3.Error:
        return {"ok": True, "available": False, "message": "内部错误"}
    by_day: dict[str, dict[str, Any]] = {}
    for row in rows:
        day_key = row[0]
        by_day[day_key] = {
            "date": day_key,
            "input_tokens": row[1] or 0,
            "output_tokens": row[2] or 0,
            "cache_read_tokens": row[3] or 0,
            "api_calls": row[4] or 0,
        }
    days_out: list[dict[str, Any]] = []
    for offset in range(days - 1, -1, -1):
        key = (today - timedelta(days=offset)).strftime("%Y-%m-%d")
        days_out.append(
            by_day.get(
                key,
                {"date": key, "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "api_calls": 0},
            )
        )
    total_calls = sum(item["api_calls"] for item in days_out)
    return {"ok": True, "available": True, "days": days_out, "total_calls": total_calls}
