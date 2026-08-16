from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping
from urllib.parse import urlparse

import jwt
from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.responses import Response


ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion"
CSRF_HEADER = "X-Hermes-CSRF"
IDEMPOTENCY_HEADER = "Idempotency-Key"
REQUEST_ID_HEADER = "X-Request-ID"
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


class SecurityConfigurationError(RuntimeError):
    pass


class InvalidAccessToken(Exception):
    pass


class AccessKeyUnavailable(Exception):
    pass


@dataclass(frozen=True)
class AuthIdentity:
    email: str
    subject: str
    role: str


@dataclass(frozen=True)
class SecuritySettings:
    mode: str
    team_domain: str
    audience: str
    admin_emails: frozenset[str]
    operator_emails: frozenset[str]
    allowed_origin: str
    idempotency_path: Path
    audit_path: Path

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "SecuritySettings":
        values = os.environ if env is None else env
        runtime_dir = Path(__file__).resolve().parent / "runtime"

        def emails(name: str) -> frozenset[str]:
            return frozenset(
                item.strip().lower()
                for item in values.get(name, "").split(",")
                if item.strip()
            )

        settings = cls(
            mode=values.get("HERMES_AUTH_MODE", "disabled").strip().lower(),
            team_domain=values.get("CF_ACCESS_TEAM_DOMAIN", "").strip().rstrip("/"),
            audience=values.get("CF_ACCESS_AUD", "").strip(),
            admin_emails=emails("HERMES_AUTH_ADMIN_EMAILS"),
            operator_emails=emails("HERMES_AUTH_OPERATOR_EMAILS"),
            allowed_origin=values.get(
                "HERMES_ALLOWED_ORIGIN", "https://office.example.com"
            ).strip().rstrip("/"),
            idempotency_path=runtime_dir / "idempotency.json",
            audit_path=runtime_dir / "security-audit.jsonl",
        )
        settings.validate()
        return settings

    @property
    def enabled(self) -> bool:
        return self.mode == "enforce"

    def validate(self) -> None:
        if self.mode not in {"disabled", "enforce"}:
            raise SecurityConfigurationError(
                "HERMES_AUTH_MODE must be disabled or enforce"
            )
        if not self.enabled:
            return
        parsed = urlparse(self.team_domain)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or not parsed.hostname.endswith(".cloudflareaccess.com")
            or parsed.path not in {"", "/"}
            or parsed.params
            or parsed.query
            or parsed.fragment
        ):
            raise SecurityConfigurationError(
                "CF_ACCESS_TEAM_DOMAIN must be an https cloudflareaccess.com origin"
            )
        if not self.audience:
            raise SecurityConfigurationError("CF_ACCESS_AUD is required")
        if not self.admin_emails:
            raise SecurityConfigurationError(
                "HERMES_AUTH_ADMIN_EMAILS must contain at least one address"
            )
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

    def role_for(self, email: str) -> str:
        normalized = email.strip().lower()
        if normalized in self.admin_emails:
            return "admin"
        if normalized in self.operator_emails:
            return "operator"
        return "viewer"


class AccessTokenVerifier:
    def __init__(
        self,
        team_domain: str,
        audience: str,
        jwk_client: Any | None = None,
    ) -> None:
        self.team_domain = team_domain
        self.audience = audience
        self.jwk_client = jwk_client or jwt.PyJWKClient(
            f"{team_domain}/cdn-cgi/access/certs",
            cache_jwk_set=True,
            lifespan=300,
        )

    def verify(self, token: str) -> dict[str, Any]:
        try:
            signing_key = self.jwk_client.get_signing_key_from_jwt(token)
            payload = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                audience=self.audience,
                issuer=self.team_domain,
                leeway=30,
                options={"require": ["exp", "iat", "iss", "aud", "sub"]},
            )
        except jwt.exceptions.PyJWKClientConnectionError as exc:
            raise AccessKeyUnavailable(
                "Cloudflare Access signing keys unavailable"
            ) from exc
        except jwt.PyJWTError as exc:
            raise InvalidAccessToken("Cloudflare Access token rejected") from exc

        email = payload.get("email")
        subject = payload.get("sub")
        if not isinstance(email, str) or not email.strip():
            raise InvalidAccessToken("Cloudflare Access token has no email")
        if not isinstance(subject, str) or not subject.strip():
            raise InvalidAccessToken("Cloudflare Access token has no subject")
        return payload


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


def valid_csrf_headers(
    origin: str | None, csrf_value: str | None, allowed: str
) -> bool:
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

    def begin(
        self, actor: str, method: str, path: str, key: str
    ) -> IdempotencyDecision:
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
                return IdempotencyDecision(
                    kind="pending", fingerprint=fingerprint
                )
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
            self._save_locked()

    def abort(self, fingerprint: str) -> None:
        with self._lock:
            self._pending.discard(fingerprint)

    def _save_locked(self) -> None:
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(self._records, ensure_ascii=False, sort_keys=True),
            encoding="utf-8",
        )
        os.chmod(temporary, 0o600)
        os.replace(temporary, self.path)


class SecurityManager:
    def __init__(
        self,
        settings: SecuritySettings,
        verifier: AccessTokenVerifier | None = None,
        limiter: FixedWindowRateLimiter | None = None,
        idempotency: IdempotencyStore | None = None,
        audit_enabled: bool = True,
    ) -> None:
        self.settings = settings
        self.verifier = verifier
        self.limiter = limiter or FixedWindowRateLimiter()
        self.idempotency = idempotency
        self.audit_enabled = audit_enabled
        self._audit_lock = threading.Lock()
        if self.settings.enabled:
            self.verifier = verifier or AccessTokenVerifier(
                settings.team_domain, settings.audience
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
        if not path.startswith("/api/") or request.method.upper() == "OPTIONS":
            return await call_next(request)
        if not self.settings.enabled:
            request.state.auth_identity = AuthIdentity("", "disabled", "admin")
            return await call_next(request)

        request_id = self._request_id(request.headers.get(REQUEST_ID_HEADER))
        token = request.headers.get(ACCESS_JWT_HEADER)
        if not token:
            return self._error(401, "missing_access_token", request_id)
        try:
            assert self.verifier is not None
            payload = await asyncio.to_thread(self.verifier.verify, token)
        except AccessKeyUnavailable:
            return self._error(503, "access_keys_unavailable", request_id)
        except InvalidAccessToken:
            return self._error(401, "invalid_access_token", request_id)

        email = str(payload["email"]).strip().lower()
        identity = AuthIdentity(
            email=email,
            subject=str(payload["sub"]),
            role=self.settings.role_for(email),
        )
        request.state.auth_identity = identity

        needed = required_role(request.method, path)
        if not role_allows(identity.role, needed):
            self._audit(identity, request, request_id, 403, "forbidden")
            return self._error(403, "forbidden", request_id)

        retry_after = self.limiter.check(
            identity.subject, request.method, path
        )
        if retry_after is not None:
            self._audit(identity, request, request_id, 429, "rate_limited")
            return self._error(
                429,
                "rate_limited",
                request_id,
                headers={"Retry-After": str(retry_after)},
            )

        decision: IdempotencyDecision | None = None
        if request.method.upper() not in SAFE_METHODS:
            if not valid_csrf_headers(
                request.headers.get("Origin"),
                request.headers.get(CSRF_HEADER),
                self.settings.allowed_origin,
            ):
                self._audit(identity, request, request_id, 403, "csrf_rejected")
                return self._error(403, "csrf_rejected", request_id)
            idempotency_key = request.headers.get(IDEMPOTENCY_HEADER)
            if not valid_uuid(idempotency_key):
                self._audit(
                    identity,
                    request,
                    request_id,
                    400,
                    "invalid_idempotency_key",
                )
                return self._error(
                    400, "invalid_idempotency_key", request_id
                )
            assert self.idempotency is not None
            decision = self.idempotency.begin(
                identity.subject,
                request.method,
                path,
                idempotency_key,
            )
            if decision.kind == "pending":
                self._audit(
                    identity, request, request_id, 409, "operation_in_progress"
                )
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
            self.idempotency.complete(
                decision.fingerprint, response.status_code, body
            )
        else:
            self.idempotency.abort(decision.fingerprint)
        self._audit(
            identity, request, request_id, response.status_code, "completed"
        )
        return buffered

    def session_payload(self, request: Request) -> dict[str, Any]:
        identity = getattr(request.state, "auth_identity", None)
        if not self.settings.enabled:
            return {
                "ok": True,
                "auth_enabled": False,
                "email": None,
                "role": None,
                "capabilities": [],
            }
        if not isinstance(identity, AuthIdentity):
            return {
                "ok": False,
                "auth_enabled": True,
                "email": None,
                "role": None,
                "capabilities": [],
            }
        capabilities = ["read"]
        if role_allows(identity.role, "operator"):
            capabilities.extend(["message", "workflow"])
        if role_allows(identity.role, "admin"):
            capabilities.extend(
                ["outbox_retry", "kanban_unblock", "expert_pipeline"]
            )
        return {
            "ok": True,
            "auth_enabled": True,
            "email": identity.email,
            "role": identity.role,
            "capabilities": capabilities,
        }

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
        response_headers = {REQUEST_ID_HEADER: request_id}
        if headers:
            response_headers.update(headers)
        return JSONResponse(
            status_code=status_code,
            content={"ok": False, "error": code, "request_id": request_id},
            headers=response_headers,
        )

    async def _buffer_json_response(
        self, response: Response
    ) -> tuple[Response, Any | None]:
        body_iterator = getattr(response, "body_iterator", None)
        if body_iterator is None:
            body = getattr(response, "body", b"")
        else:
            chunks = []
            async for chunk in body_iterator:
                chunks.append(
                    chunk if isinstance(chunk, bytes) else chunk.encode("utf-8")
                )
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

    def _audit(
        self,
        identity: AuthIdentity,
        request: Request,
        request_id: str,
        status_code: int,
        outcome: str,
    ) -> None:
        if not self.audit_enabled:
            return
        if request.method.upper() in SAFE_METHODS:
            return
        record = {
            "timestamp": time.time(),
            "actor_hash": hashlib.sha256(
                identity.email.encode("utf-8")
            ).hexdigest()[:16],
            "role": identity.role,
            "method": request.method.upper(),
            "path": normalize_route(request.url.path),
            "request_id": request_id,
            "status_code": status_code,
            "outcome": outcome,
        }
        with self._audit_lock:
            self.settings.audit_path.parent.mkdir(parents=True, exist_ok=True)
            new_file = not self.settings.audit_path.exists()
            with self.settings.audit_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            if new_file:
                os.chmod(self.settings.audit_path, 0o600)
