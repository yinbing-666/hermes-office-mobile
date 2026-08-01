from __future__ import annotations

import time
import unittest
from types import SimpleNamespace

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Request
from fastapi.responses import JSONResponse

from access_security import (
    AccessTokenVerifier,
    FixedWindowRateLimiter,
    IdempotencyStore,
    InvalidAccessToken,
    SecurityManager,
    SecurityConfigurationError,
    SecuritySettings,
    required_role,
    role_allows,
    valid_csrf_headers,
    valid_uuid,
)


def settings_env(**overrides: str) -> dict[str, str]:
    values = {
        "HERMES_AUTH_MODE": "enforce",
        "CF_ACCESS_TEAM_DOMAIN": "https://example.cloudflareaccess.com",
        "CF_ACCESS_AUD": "audience-tag",
        "HERMES_AUTH_ADMIN_EMAILS": "owner@example.com",
        "HERMES_AUTH_OPERATOR_EMAILS": "operator@example.com",
        "HERMES_ALLOWED_ORIGIN": "https://office.icewill.tech",
    }
    values.update(overrides)
    return values


class FakeJwkClient:
    def __init__(self, key: object) -> None:
        self.key = key

    def get_signing_key_from_jwt(self, token: str) -> SimpleNamespace:
        del token
        return SimpleNamespace(key=self.key)
class FakeVerifier:
    def __init__(self, email: str) -> None:
        self.email = email

    def verify(self, token: str) -> dict[str, str]:
        del token
        return {
            "email": self.email,
            "sub": f"subject:{self.email}",
        }


def make_request(
    method: str, path: str, headers: dict[str, str] | None = None
) -> Request:
    raw_headers = [
        (key.lower().encode("ascii"), value.encode("utf-8"))
        for key, value in (headers or {}).items()
    ]
    return Request({
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "https",
        "path": path,
        "raw_path": path.encode("ascii"),
        "query_string": b"",
        "root_path": "",
        "headers": raw_headers,
        "client": ("127.0.0.1", 12345),
        "server": ("office.icewill.tech", 443),
    })




class SecuritySettingsTests(unittest.TestCase):
    def test_disabled_mode_needs_no_access_configuration(self) -> None:
        settings = SecuritySettings.from_env({})
        self.assertFalse(settings.enabled)

    def test_enforce_mode_fails_closed_without_required_values(self) -> None:
        with self.assertRaises(SecurityConfigurationError):
            SecuritySettings.from_env({"HERMES_AUTH_MODE": "enforce"})

    def test_roles_are_exact_email_matches(self) -> None:
        settings = SecuritySettings.from_env(settings_env())
        self.assertEqual(settings.role_for("OWNER@example.com"), "admin")
        self.assertEqual(settings.role_for("operator@example.com"), "operator")
        self.assertEqual(settings.role_for("unknown@example.com"), "viewer")


class AuthorizationPolicyTests(unittest.TestCase):
    def test_safe_routes_require_viewer(self) -> None:
        self.assertEqual(required_role("GET", "/api/tasks"), "viewer")

    def test_operator_routes_are_explicit(self) -> None:
        self.assertEqual(required_role("POST", "/api/messages"), "operator")
        self.assertEqual(required_role("POST", "/api/workflows"), "operator")

    def test_other_write_routes_fail_to_admin(self) -> None:
        self.assertEqual(
            required_role("POST", "/api/kanban/unblock/task-1"), "admin"
        )
        self.assertEqual(required_role("DELETE", "/api/future"), "admin")

    def test_role_order(self) -> None:
        self.assertTrue(role_allows("admin", "viewer"))
        self.assertTrue(role_allows("operator", "operator"))
        self.assertFalse(role_allows("viewer", "operator"))


class RequestGuardTests(unittest.TestCase):
    def test_csrf_requires_exact_origin_and_marker(self) -> None:
        allowed = "https://office.icewill.tech"
        self.assertTrue(valid_csrf_headers(allowed, "1", allowed))
        self.assertFalse(
            valid_csrf_headers("https://evil.example", "1", allowed)
        )
        self.assertFalse(valid_csrf_headers(allowed, None, allowed))

    def test_idempotency_key_must_be_canonical_uuid(self) -> None:
        self.assertTrue(valid_uuid("71e120d4-9f7c-43ad-a580-1d122c546e60"))
        self.assertFalse(valid_uuid("not-a-uuid"))


class AccessTokenVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.private_key = rsa.generate_private_key(
            public_exponent=65537, key_size=2048
        )
        self.public_key = self.private_key.public_key()
        self.issuer = "https://example.cloudflareaccess.com"
        self.audience = "audience-tag"

    def token(self, **overrides: object) -> str:
        now = int(time.time())
        payload: dict[str, object] = {
            "iss": self.issuer,
            "aud": [self.audience],
            "sub": "subject-1",
            "email": "owner@example.com",
            "iat": now,
            "exp": now + 300,
        }
        payload.update(overrides)
        return jwt.encode(payload, self.private_key, algorithm="RS256")

    def verifier(self) -> AccessTokenVerifier:
        return AccessTokenVerifier(
            self.issuer,
            self.audience,
            jwk_client=FakeJwkClient(self.public_key),
        )

    def test_valid_rs256_token_is_accepted(self) -> None:
        payload = self.verifier().verify(self.token())
        self.assertEqual(payload["email"], "owner@example.com")

    def test_wrong_audience_is_rejected(self) -> None:
        with self.assertRaises(InvalidAccessToken):
            self.verifier().verify(self.token(aud=["wrong-audience"]))

    def test_missing_email_is_rejected(self) -> None:
        with self.assertRaises(InvalidAccessToken):
            self.verifier().verify(self.token(email=None))


class RateLimiterTests(unittest.TestCase):
    def test_endpoint_limit_returns_retry_after(self) -> None:
        now = [100.0]
        limiter = FixedWindowRateLimiter(clock=lambda: now[0])
        for _ in range(10):
            self.assertIsNone(
                limiter.check("subject", "POST", "/api/messages")
            )
        self.assertEqual(
            limiter.check("subject", "POST", "/api/messages"), 60
        )
        now[0] += 60
        self.assertIsNone(limiter.check("subject", "POST", "/api/messages"))


class IdempotencyStoreTests(unittest.TestCase):
    def test_completed_operation_replays_without_new_execution(self) -> None:
        now = [1000.0]
        store = IdempotencyStore(
            path=None, ttl_seconds=10, clock=lambda: now[0]
        )
        key = "71e120d4-9f7c-43ad-a580-1d122c546e60"
        first = store.begin("subject", "POST", "/api/messages", key)
        self.assertEqual(first.kind, "new")
        store.complete(first.fingerprint, 200, {"ok": True})
        replay = store.begin("subject", "POST", "/api/messages", key)
        self.assertEqual(replay.kind, "replay")
        self.assertEqual(replay.replay.status_code, 200)
        self.assertEqual(replay.replay.body, {"ok": True})

    def test_pending_operation_is_not_run_twice(self) -> None:
        store = IdempotencyStore(path=None)
        key = "f5088e73-306f-4b28-a9dc-f7de407de330"
        first = store.begin("subject", "POST", "/api/outbox/retry", key)
        second = store.begin("subject", "POST", "/api/outbox/retry", key)
        self.assertEqual(first.kind, "new")
        self.assertEqual(second.kind, "pending")

    def test_expired_record_can_run_again(self) -> None:
        now = [1000.0]
        store = IdempotencyStore(
            path=None, ttl_seconds=10, clock=lambda: now[0]
        )
        key = "3f61c1e3-dc77-4925-a2b0-ac1512129d9c"
        first = store.begin("subject", "POST", "/api/messages", key)
        store.complete(first.fingerprint, 200, {"ok": True})
        now[0] += 11
        self.assertEqual(
            store.begin("subject", "POST", "/api/messages", key).kind,
            "new",
        )


class SecurityMiddlewareTests(unittest.IsolatedAsyncioTestCase):
    def manager(self, email: str) -> SecurityManager:
        settings = SecuritySettings.from_env(settings_env())
        return SecurityManager(
            settings,
            verifier=FakeVerifier(email),
            idempotency=IdempotencyStore(path=None),
            audit_enabled=False,
        )

    async def test_missing_token_never_calls_business_handler(self) -> None:
        called = 0

        async def call_next(request: Request) -> JSONResponse:
            nonlocal called
            del request
            called += 1
            return JSONResponse({"ok": True})

        response = await self.manager("owner@example.com").handle(
            make_request("GET", "/api/tasks"),
            call_next,
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(called, 0)

    async def test_viewer_cannot_reach_write_handler(self) -> None:
        called = 0

        async def call_next(request: Request) -> JSONResponse:
            nonlocal called
            del request
            called += 1
            return JSONResponse({"ok": True})

        response = await self.manager("viewer@example.com").handle(
            make_request(
                "POST",
                "/api/messages",
                {"Cf-Access-Jwt-Assertion": "token"},
            ),
            call_next,
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(called, 0)

    async def test_csrf_rejection_happens_before_write_handler(self) -> None:
        called = 0

        async def call_next(request: Request) -> JSONResponse:
            nonlocal called
            del request
            called += 1
            return JSONResponse({"ok": True})

        response = await self.manager("operator@example.com").handle(
            make_request(
                "POST",
                "/api/messages",
                {"Cf-Access-Jwt-Assertion": "token"},
            ),
            call_next,
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(called, 0)

    async def test_completed_write_replays_without_second_execution(self) -> None:
        called = 0
        manager = self.manager("operator@example.com")
        headers = {
            "Cf-Access-Jwt-Assertion": "token",
            "Origin": "https://office.icewill.tech",
            "X-Hermes-CSRF": "1",
            "Idempotency-Key": "71e120d4-9f7c-43ad-a580-1d122c546e60",
        }

        async def call_next(request: Request) -> JSONResponse:
            nonlocal called
            del request
            called += 1
            return JSONResponse({"ok": True, "delivered": True})

        first = await manager.handle(
            make_request("POST", "/api/messages", headers),
            call_next,
        )
        second = await manager.handle(
            make_request("POST", "/api/messages", headers),
            call_next,
        )
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.headers["X-Idempotent-Replay"], "true")
        self.assertEqual(called, 1)


if __name__ == "__main__":
    unittest.main()
