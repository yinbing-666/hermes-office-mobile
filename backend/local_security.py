from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import math
import os
import secrets
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping
from urllib.parse import urlparse

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.responses import Response


CSRF_HEADER = "X-Hermes-CSRF"
IDEMPOTENCY_HEADER = "Idempotency-Key"
REQUEST_ID_HEADER = "X-Request-ID"
SESSION_COOKIE_NAME = "__Host-hermes_office_session"
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
ROLE_LEVEL = {"viewer": 10, "operator": 20, "admin": 30}
OPERATOR_POST_ROUTES = frozenset({
    "/api/messages",
    "/api/workflows",
    "/api/workflows/execute",
})
RATE_LIMITS: dict[tuple[str, str], tuple[int, int]] = {
    ("POST", "/api/messages"): (10, 60),
    ("POST", "/api/workflows"): (20, 60),
    ("POST", "/api/workflows/execute"): (20, 60),
    ("POST", "/api/outbox/retry"): (1, 60),
    ("POST", "/api/kanban/unblock/{task_id}"): (3, 600),
    ("POST", "/api/experts/summarize"): (3, 600),
    ("POST", "/api/experts/pipeline"): (1, 600),
}
SCRYPT_N = 1 << 14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32


class SecurityConfigurationError(RuntimeError):
    pass


@dataclass(frozen=True)
class AuthIdentity:
    email: str
    subject: str
    role: str


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def create_password_record(password: str, salt: bytes | None = None) -> dict[str, Any]:
    if not 12 <= len(password) <= 256:
        raise ValueError("password must contain 12 to 256 characters")
    password_bytes = password.encode("utf-8")
    salt_bytes = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password_bytes,
        salt=salt_bytes,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=SCRYPT_DKLEN,
    )
    return {
        "algorithm": "scrypt",
        "salt": _b64encode(salt_bytes),
        "digest": _b64encode(digest),
        "n": SCRYPT_N,
        "r": SCRYPT_R,
        "p": SCRYPT_P,
        "dklen": SCRYPT_DKLEN,
    }


@dataclass(frozen=True)
class LocalAuthConfig:
    admin_email: str
    password_record: Mapping[str, Any]

    @classmethod
    def load(cls, path: Path) -> "LocalAuthConfig":
        _require_private_file(path, "local auth configuration")
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SecurityConfigurationError(
                "local auth configuration is missing or invalid"
            ) from exc
        if not isinstance(payload, dict):
            raise SecurityConfigurationError("local auth configuration must be an object")
        email = payload.get("admin_email")
        password_record = payload.get("password")
        if not isinstance(email, str) or "@" not in email or len(email) > 254:
            raise SecurityConfigurationError("local auth admin_email is invalid")
        if not isinstance(password_record, dict):
            raise SecurityConfigurationError("local auth password record is missing")
        cls._validate_password_record(password_record)
        return cls(email.strip().lower(), password_record)

    @staticmethod
    def _validate_password_record(record: Mapping[str, Any]) -> None:
        expected = {
            "algorithm": "scrypt",
            "n": SCRYPT_N,
            "r": SCRYPT_R,
            "p": SCRYPT_P,
            "dklen": SCRYPT_DKLEN,
        }
        for key, value in expected.items():
            if record.get(key) != value:
                raise SecurityConfigurationError("unsupported local auth password record")
        try:
            salt = _b64decode(str(record["salt"]))
            digest = _b64decode(str(record["digest"]))
        except (KeyError, ValueError, TypeError) as exc:
            raise SecurityConfigurationError("local auth password record is invalid") from exc
        if len(salt) < 16 or len(digest) != SCRYPT_DKLEN:
            raise SecurityConfigurationError("local auth password record is invalid")

    def verify_password(self, password: str) -> bool:
        if not 1 <= len(password) <= 256:
            return False
        try:
            candidate = hashlib.scrypt(
                password.encode("utf-8"),
                salt=_b64decode(str(self.password_record["salt"])),
                n=SCRYPT_N,
                r=SCRYPT_R,
                p=SCRYPT_P,
                dklen=SCRYPT_DKLEN,
            )
            expected = _b64decode(str(self.password_record["digest"]))
        except (KeyError, ValueError, TypeError):
            return False
        return hmac.compare_digest(candidate, expected)


@dataclass(frozen=True)
class SecuritySettings:
    mode: str
    allowed_origin: str
    auth_config_path: Path
    sessions_path: Path
    idempotency_path: Path
    audit_path: Path
    session_ttl_seconds: int

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "SecuritySettings":
        values = os.environ if env is None else env
        runtime_dir = Path(__file__).resolve().parent / "runtime"
        ttl_raw = values.get("HERMES_SESSION_TTL_SECONDS", "604800").strip()
        try:
            ttl = int(ttl_raw)
        except ValueError as exc:
            raise SecurityConfigurationError(
                "HERMES_SESSION_TTL_SECONDS must be an integer"
            ) from exc
        settings = cls(
            mode=values.get("HERMES_AUTH_MODE", "disabled").strip().lower(),
            allowed_origin=values.get(
                "HERMES_ALLOWED_ORIGIN", "https://office.icewill.tech"
            ).strip().rstrip("/"),
            auth_config_path=Path(
                values.get("HERMES_LOCAL_AUTH_CONFIG", runtime_dir / "local-auth.json")
            ),
            sessions_path=runtime_dir / "sessions.json",
            idempotency_path=runtime_dir / "idempotency.json",
            audit_path=runtime_dir / "security-audit.jsonl",
            session_ttl_seconds=ttl,
        )
        settings.validate()
        return settings

    @property
    def enabled(self) -> bool:
        return self.mode == "local"

    def validate(self) -> None:
        if self.mode not in {"disabled", "local"}:
            raise SecurityConfigurationError("HERMES_AUTH_MODE must be disabled or local")
        allowed = urlparse(self.allowed_origin)
        if (
            allowed.scheme != "https"
            or not allowed.hostname
            or allowed.path not in {"", "/"}
            or allowed.params
            or allowed.query
            or allowed.fragment
        ):
            raise SecurityConfigurationError(
                "HERMES_ALLOWED_ORIGIN must be an https origin"
            )
        if not 900 <= self.session_ttl_seconds <= 2592000:
            raise SecurityConfigurationError(
                "HERMES_SESSION_TTL_SECONDS must be between 900 and 2592000"
            )


def _write_private_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True),
        encoding="utf-8",
    )
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def _require_private_file(path: Path, label: str) -> None:
    if path.is_symlink():
        raise SecurityConfigurationError(f"{label} must not be a symbolic link")
    try:
        mode = path.stat().st_mode
    except OSError as exc:
        raise SecurityConfigurationError(f"{label} is missing or unreadable") from exc
    if os.name != "nt" and mode & 0o077:
        raise SecurityConfigurationError(f"{label} must have mode 600")


class SessionStore:
    def __init__(
        self,
        path: Path | None,
        ttl_seconds: int = 604800,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.path = path
        self.ttl_seconds = ttl_seconds
        self.clock = clock
        self._records: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._load()

    @staticmethod
    def token_hash(token: str) -> str:
        return hashlib.sha256(token.encode("ascii", errors="ignore")).hexdigest()

    def _load(self) -> None:
        if self.path is None or not self.path.exists():
            return
        _require_private_file(self.path, "session store")
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SecurityConfigurationError("session store is unreadable or invalid") from exc
        if not isinstance(payload, dict):
            raise SecurityConfigurationError("session store must be an object")
        for key, value in payload.items():
            if (
                not isinstance(key, str)
                or len(key) != 64
                or not isinstance(value, dict)
                or not isinstance(value.get("email"), str)
                or not isinstance(value.get("expires_at"), (int, float))
            ):
                raise SecurityConfigurationError("session store contains an invalid record")
        self._records = payload
        self._prune_locked()

    def _prune_locked(self) -> bool:
        now = self.clock()
        before = len(self._records)
        self._records = {
            key: value
            for key, value in self._records.items()
            if value["expires_at"] > now
        }
        return len(self._records) != before

    def create(self, email: str) -> tuple[str, float]:
        token = secrets.token_urlsafe(32)
        expires_at = self.clock() + self.ttl_seconds
        key = self.token_hash(token)
        with self._lock:
            self._prune_locked()
            self._records[key] = {"email": email, "expires_at": expires_at}
            self._save_locked()
        return token, expires_at

    def resolve(self, token: str) -> AuthIdentity | None:
        key = self.token_hash(token)
        with self._lock:
            changed = self._prune_locked()
            record = self._records.get(key)
            if changed:
                self._save_locked()
            if record is None:
                return None
            return AuthIdentity(record["email"], key, "admin")

    def revoke(self, token: str) -> None:
        key = self.token_hash(token)
        with self._lock:
            if self._records.pop(key, None) is not None:
                self._save_locked()

    def revoke_all(self) -> None:
        with self._lock:
            self._records = {}
            self._save_locked()

    def _save_locked(self) -> None:
        if self.path is not None:
            _write_private_json(self.path, self._records)


def normalize_route(path: str) -> str:
    if path.startswith("/api/kanban/unblock/"):
        return "/api/kanban/unblock/{task_id}"
    return path


def required_role(method: str, path: str) -> str:
    normalized_method = method.upper()
    normalized_path = normalize_route(path)
    if normalized_method in SAFE_METHODS:
        return "viewer"
    if normalized_method == "POST" and normalized_path in OPERATOR_POST_ROUTES:
        return "operator"
    return "admin"


def role_allows(actual: str, required: str) -> bool:
    return ROLE_LEVEL.get(actual, 0) >= ROLE_LEVEL.get(required, 10**6)


def valid_csrf_headers(origin: str | None, csrf_value: str | None, allowed: str) -> bool:
    return origin == allowed and csrf_value == "1"


def valid_uuid(value: str | None) -> bool:
    if not value:
        return False
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError):
        return False
    return str(parsed) == value.lower()


class FixedWindowRateLimiter:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self._windows: dict[tuple[str, str, str], tuple[float, int]] = {}
        self._lock = threading.Lock()

    def check(self, actor: str, method: str, path: str) -> int | None:
        normalized_method = method.upper()
        normalized_path = normalize_route(path)
        limit, period = RATE_LIMITS.get(
            (normalized_method, normalized_path),
            (120, 60) if normalized_method in SAFE_METHODS else (5, 60),
        )
        key = (actor, normalized_method, normalized_path)
        now = self.clock()
        with self._lock:
            started, count = self._windows.get(key, (now, 0))
            if now - started >= period:
                started, count = now, 0
            if count >= limit:
                return max(1, math.ceil(period - (now - started)))
            self._windows[key] = (started, count + 1)
        return None


class LoginRateLimiter:
    def __init__(
        self,
        per_source_limit: int = 5,
        global_limit: int = 30,
        period_seconds: int = 900,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.per_source_limit = per_source_limit
        self.global_limit = global_limit
        self.period_seconds = period_seconds
        self.clock = clock
        self._windows: dict[str, tuple[float, int]] = {}
        self._lock = threading.Lock()

    def _state(self, key: str, now: float) -> tuple[float, int]:
        started, count = self._windows.get(key, (now, 0))
        if now - started >= self.period_seconds:
            return now, 0
        return started, count

    def check(self, source: str) -> int | None:
        now = self.clock()
        with self._lock:
            source_started, source_count = self._state(f"source:{source}", now)
            global_started, global_count = self._state("global", now)
            self._windows[f"source:{source}"] = (source_started, source_count)
            self._windows["global"] = (global_started, global_count)
            if source_count >= self.per_source_limit:
                return max(1, math.ceil(self.period_seconds - (now - source_started)))
            if global_count >= self.global_limit:
                return max(1, math.ceil(self.period_seconds - (now - global_started)))
        return None

    def record_failure(self, source: str) -> None:
        now = self.clock()
        with self._lock:
            for key in (f"source:{source}", "global"):
                started, count = self._state(key, now)
                self._windows[key] = (started, count + 1)

    def reset_source(self, source: str) -> None:
        with self._lock:
            self._windows.pop(f"source:{source}", None)


@dataclass(frozen=True)
class IdempotencyReplay:
    status_code: int
    body: Any


@dataclass(frozen=True)
class IdempotencyDecision:
    kind: str
    fingerprint: str
    replay: IdempotencyReplay | None = None


class IdempotencyStore:
    def __init__(
        self,
        path: Path | None,
        ttl_seconds: int = 86400,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.path = path
        self.ttl_seconds = ttl_seconds
        self.clock = clock
        self._records: dict[str, dict[str, Any]] = {}
        self._pending: set[str] = set()
        self._lock = threading.Lock()
        self._load()

    @staticmethod
    def fingerprint(actor: str, method: str, path: str, key: str) -> str:
        value = "\n".join((actor, method.upper(), normalize_route(path), key))
        return hashlib.sha256(value.encode("utf-8")).hexdigest()

    def _load(self) -> None:
        if self.path is None or not self.path.is_file():
            return
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SecurityConfigurationError(
                "idempotency store is unreadable or invalid"
            ) from exc
        if not isinstance(payload, dict):
            raise SecurityConfigurationError("idempotency store must be an object")
        self._records = {
            key: value
            for key, value in payload.items()
            if isinstance(key, str) and isinstance(value, dict)
        }
        self._prune_locked()

    def _prune_locked(self) -> None:
        now = self.clock()
        self._records = {
            key: value
            for key, value in self._records.items()
            if isinstance(value.get("expires_at"), (int, float))
            and value["expires_at"] > now
        }
        if len(self._records) > 1000:
            ordered = sorted(
                self._records.items(),
                key=lambda item: float(item[1]["expires_at"]),
                reverse=True,
            )
            self._records = dict(ordered[:1000])

    def begin(self, actor: str, method: str, path: str, key: str) -> IdempotencyDecision:
        fingerprint = self.fingerprint(actor, method, path, key)
        with self._lock:
            self._prune_locked()
            record = self._records.get(fingerprint)
            if record is not None:
                return IdempotencyDecision(
                    kind="replay",
                    fingerprint=fingerprint,
                    replay=IdempotencyReplay(
                        status_code=int(record["status_code"]),
                        body=record.get("body"),
                    ),
                )
            if fingerprint in self._pending:
                return IdempotencyDecision(kind="pending", fingerprint=fingerprint)
            self._pending.add(fingerprint)
        return IdempotencyDecision(kind="new", fingerprint=fingerprint)

    def complete(self, fingerprint: str, status_code: int, body: Any) -> None:
        with self._lock:
            self._pending.discard(fingerprint)
            self._records[fingerprint] = {
                "expires_at": self.clock() + self.ttl_seconds,
                "status_code": status_code,
                "body": body,
            }
            self._prune_locked()
            if self.path is not None:
                _write_private_json(self.path, self._records)

    def abort(self, fingerprint: str) -> None:
        with self._lock:
            self._pending.discard(fingerprint)


def request_source(request: Request) -> str:
    forwarded = request.headers.get("CF-Connecting-IP", "").strip()
    if forwarded:
        try:
            return str(ipaddress.ip_address(forwarded))
        except ValueError:
            pass
    if request.client and request.client.host:
        try:
            return str(ipaddress.ip_address(request.client.host))
        except ValueError:
            return request.client.host[:128]
    return "unknown"


class SecurityManager:
    def __init__(
        self,
        settings: SecuritySettings,
        auth_config: LocalAuthConfig | None = None,
        sessions: SessionStore | None = None,
        limiter: FixedWindowRateLimiter | None = None,
        login_limiter: LoginRateLimiter | None = None,
        idempotency: IdempotencyStore | None = None,
        audit_enabled: bool = True,
    ) -> None:
        self.settings = settings
        self.auth_config = auth_config
        self.sessions = sessions
        self.limiter = limiter or FixedWindowRateLimiter()
        self.login_limiter = login_limiter or LoginRateLimiter()
        self.idempotency = idempotency
        self.audit_enabled = audit_enabled
        self._audit_lock = threading.Lock()
        if self.settings.enabled:
            self.auth_config = auth_config or LocalAuthConfig.load(
                settings.auth_config_path
            )
            self.sessions = sessions or SessionStore(
                settings.sessions_path, settings.session_ttl_seconds
            )
            self.idempotency = idempotency or IdempotencyStore(
                settings.idempotency_path
            )

    async def handle(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        path = request.url.path
        method = request.method.upper()
        if not path.startswith("/api/") or method == "OPTIONS":
            return await call_next(request)
        if not self.settings.enabled:
            request.state.auth_identity = AuthIdentity("", "disabled", "admin")
            return await call_next(request)
        if path == "/api/auth/login":
            return await call_next(request)

        identity = self._identity_from_request(request)
        request.state.auth_identity = identity
        if path == "/api/session":
            return await call_next(request)

        request_id = self._request_id(request.headers.get(REQUEST_ID_HEADER))
        if identity is None:
            return self._error(401, "authentication_required", request_id)

        needed = required_role(method, path)
        if not role_allows(identity.role, needed):
            self._audit(identity, request, request_id, 403, "forbidden")
            return self._error(403, "forbidden", request_id)

        retry_after = self.limiter.check(identity.subject, method, path)
        if retry_after is not None:
            self._audit(identity, request, request_id, 429, "rate_limited")
            return self._error(
                429,
                "rate_limited",
                request_id,
                headers={"Retry-After": str(retry_after)},
            )

        decision: IdempotencyDecision | None = None
        if method not in SAFE_METHODS:
            if not valid_csrf_headers(
                request.headers.get("Origin"),
                request.headers.get(CSRF_HEADER),
                self.settings.allowed_origin,
            ):
                self._audit(identity, request, request_id, 403, "csrf_rejected")
                return self._error(403, "csrf_rejected", request_id)
            idempotency_key = request.headers.get(IDEMPOTENCY_HEADER)
            if not valid_uuid(idempotency_key):
                self._audit(identity, request, request_id, 400, "invalid_idempotency_key")
                return self._error(400, "invalid_idempotency_key", request_id)
            assert self.idempotency is not None
            decision = self.idempotency.begin(
                identity.subject, method, path, idempotency_key
            )
            if decision.kind == "pending":
                self._audit(identity, request, request_id, 409, "operation_in_progress")
                return self._error(409, "operation_in_progress", request_id)
            if decision.kind == "replay" and decision.replay is not None:
                self._audit(
                    identity,
                    request,
                    request_id,
                    decision.replay.status_code,
                    "replayed",
                )
                return JSONResponse(
                    status_code=decision.replay.status_code,
                    content=decision.replay.body,
                    headers={
                        REQUEST_ID_HEADER: request_id,
                        "X-Idempotent-Replay": "true",
                    },
                )

        try:
            response = await call_next(request)
        except Exception:
            if decision is not None and decision.kind == "new":
                assert self.idempotency is not None
                self.idempotency.abort(decision.fingerprint)
            self._audit(identity, request, request_id, 500, "exception")
            raise

        response.headers[REQUEST_ID_HEADER] = request_id
        if decision is None or decision.kind != "new":
            return response

        buffered, body = await self._buffer_json_response(response)
        assert self.idempotency is not None
        if response.status_code < 500 and body is not None:
            self.idempotency.complete(decision.fingerprint, response.status_code, body)
        else:
            self.idempotency.abort(decision.fingerprint)
        self._audit(identity, request, request_id, response.status_code, "completed")
        return buffered

    async def login(self, request: Request, password: str) -> JSONResponse:
        request_id = self._request_id(request.headers.get(REQUEST_ID_HEADER))
        if not self.settings.enabled:
            return self._error(409, "auth_not_enabled", request_id)

        source = request_source(request)
        if not valid_csrf_headers(
            request.headers.get("Origin"),
            request.headers.get(CSRF_HEADER),
            self.settings.allowed_origin,
        ):
            self._audit_login(source, request_id, 403, "csrf_rejected")
            return self._error(403, "csrf_rejected", request_id)

        retry_after = self.login_limiter.check(source)
        if retry_after is not None:
            self._audit_login(source, request_id, 429, "login_rate_limited")
            return self._error(
                429,
                "login_rate_limited",
                request_id,
                headers={"Retry-After": str(retry_after)},
            )

        assert self.auth_config is not None
        valid = await asyncio.to_thread(self.auth_config.verify_password, password)
        if not valid:
            self.login_limiter.record_failure(source)
            self._audit_login(source, request_id, 401, "invalid_credentials")
            return self._error(401, "invalid_credentials", request_id)

        self.login_limiter.reset_source(source)
        assert self.sessions is not None
        token, _ = self.sessions.create(self.auth_config.admin_email)
        response = JSONResponse(
            content={
                "ok": True,
                "authenticated": True,
                "email": self.auth_config.admin_email,
                "role": "admin",
            },
            headers={REQUEST_ID_HEADER: request_id, "Cache-Control": "no-store"},
        )
        response.set_cookie(
            key=SESSION_COOKIE_NAME,
            value=token,
            max_age=self.settings.session_ttl_seconds,
            path="/",
            secure=True,
            httponly=True,
            samesite="strict",
        )
        self._audit_login(source, request_id, 200, "login_succeeded")
        return response

    def logout(self, request: Request) -> JSONResponse:
        token = request.cookies.get(SESSION_COOKIE_NAME)
        if token and self.sessions is not None:
            self.sessions.revoke(token)
        response = JSONResponse(
            content={"ok": True}, headers={"Cache-Control": "no-store"}
        )
        response.delete_cookie(
            SESSION_COOKIE_NAME,
            path="/",
            secure=True,
            httponly=True,
            samesite="strict",
        )
        return response

    def session_payload(self, request: Request) -> dict[str, Any]:
        if not self.settings.enabled:
            return {
                "ok": True,
                "auth_enabled": False,
                "auth_mode": "disabled",
                "authenticated": True,
                "email": None,
                "role": None,
                "capabilities": [],
            }
        identity = getattr(request.state, "auth_identity", None)
        if not isinstance(identity, AuthIdentity):
            return {
                "ok": True,
                "auth_enabled": True,
                "auth_mode": "local",
                "authenticated": False,
                "email": None,
                "role": None,
                "capabilities": [],
            }
        return {
            "ok": True,
            "auth_enabled": True,
            "auth_mode": "local",
            "authenticated": True,
            "email": identity.email,
            "role": identity.role,
            "capabilities": [
                "read",
                "message",
                "workflow",
                "outbox_retry",
                "kanban_unblock",
                "expert_pipeline",
            ],
        }

    def _identity_from_request(self, request: Request) -> AuthIdentity | None:
        token = request.cookies.get(SESSION_COOKIE_NAME)
        if not token or self.sessions is None:
            return None
        return self.sessions.resolve(token)

    @staticmethod
    def _request_id(value: str | None) -> str:
        return value.lower() if valid_uuid(value) else str(uuid.uuid4())

    @staticmethod
    def _error(
        status_code: int,
        code: str,
        request_id: str,
        headers: dict[str, str] | None = None,
    ) -> JSONResponse:
        response_headers = {
            REQUEST_ID_HEADER: request_id,
            "Cache-Control": "no-store",
        }
        if headers:
            response_headers.update(headers)
        return JSONResponse(
            status_code=status_code,
            content={"ok": False, "error": code, "request_id": request_id},
            headers=response_headers,
        )

    async def _buffer_json_response(self, response: Response) -> tuple[Response, Any | None]:
        body_iterator = getattr(response, "body_iterator", None)
        if body_iterator is None:
            body = getattr(response, "body", b"")
        else:
            chunks = []
            async for chunk in body_iterator:
                chunks.append(chunk if isinstance(chunk, bytes) else chunk.encode("utf-8"))
            body = b"".join(chunks)
        buffered = Response(
            content=body,
            status_code=response.status_code,
            headers=dict(response.headers),
            media_type=response.media_type,
            background=response.background,
        )
        try:
            return buffered, json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return buffered, None

    def _audit_login(
        self,
        source: str,
        request_id: str,
        status_code: int,
        outcome: str,
    ) -> None:
        record = {
            "timestamp": time.time(),
            "actor_hash": hashlib.sha256(source.encode("utf-8")).hexdigest()[:16],
            "role": "anonymous",
            "method": "POST",
            "path": "/api/auth/login",
            "request_id": request_id,
            "status_code": status_code,
            "outcome": outcome,
        }
        self._append_audit(record)

    def _audit(
        self,
        identity: AuthIdentity,
        request: Request,
        request_id: str,
        status_code: int,
        outcome: str,
    ) -> None:
        if request.method.upper() in SAFE_METHODS:
            return
        record = {
            "timestamp": time.time(),
            "actor_hash": hashlib.sha256(identity.email.encode("utf-8")).hexdigest()[:16],
            "role": identity.role,
            "method": request.method.upper(),
            "path": normalize_route(request.url.path),
            "request_id": request_id,
            "status_code": status_code,
            "outcome": outcome,
        }
        self._append_audit(record)

    def _append_audit(self, record: dict[str, Any]) -> None:
        if not self.audit_enabled:
            return
        with self._audit_lock:
            self.settings.audit_path.parent.mkdir(parents=True, exist_ok=True)
            new_file = not self.settings.audit_path.exists()
            with self.settings.audit_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            if new_file:
                os.chmod(self.settings.audit_path, 0o600)
