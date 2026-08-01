from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse

from local_security import (
    AuthIdentity,
    IdempotencyStore,
    LocalAuthConfig,
    LoginRateLimiter,
    SecurityConfigurationError,
    SecurityManager,
    SecuritySettings,
    SessionStore,
    create_password_record,
    required_role,
    role_allows,
    valid_csrf_headers,
    valid_uuid,
)


PASSWORD = "correct horse battery staple"
ORIGIN = "https://office.icewill.tech"


def make_request(
    method: str,
    path: str,
    headers: dict[str, str] | None = None,
    cookie: str | None = None,
) -> Request:
    values = dict(headers or {})
    if cookie:
        values["Cookie"] = cookie
    raw_headers = [
        (key.lower().encode("ascii"), value.encode("utf-8"))
        for key, value in values.items()
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
        "client": ("203.0.113.9", 12345),
        "server": ("office.icewill.tech", 443),
    })


def local_settings(runtime: Path) -> SecuritySettings:
    return SecuritySettings(
        mode="local",
        allowed_origin=ORIGIN,
        auth_config_path=runtime / "local-auth.json",
        sessions_path=runtime / "sessions.json",
        idempotency_path=runtime / "idempotency.json",
        audit_path=runtime / "audit.jsonl",
        session_ttl_seconds=604800,
    )


def local_config() -> LocalAuthConfig:
    return LocalAuthConfig(
        admin_email="owner@example.com",
        password_record=create_password_record(PASSWORD, salt=b"1" * 16),
    )


class PasswordTests(unittest.TestCase):
    def test_scrypt_record_accepts_only_correct_password(self) -> None:
        config = local_config()
        self.assertTrue(config.verify_password(PASSWORD))
        self.assertFalse(config.verify_password("wrong password"))

    def test_short_password_is_rejected_when_creating_record(self) -> None:
        with self.assertRaises(ValueError):
            create_password_record("too-short")

    def test_local_mode_fails_closed_without_config(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(SecurityConfigurationError):
                SecurityManager(local_settings(Path(temporary)))

    def test_auth_config_rejects_group_readable_permissions(self) -> None:
        if os.name == "nt":
            self.skipTest("POSIX permission check")
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "local-auth.json"
            path.write_text(
                json.dumps({
                    "admin_email": "owner@example.com",
                    "password": create_password_record(PASSWORD, salt=b"2" * 16),
                }),
                encoding="utf-8",
            )
            os.chmod(path, 0o644)
            with self.assertRaises(SecurityConfigurationError):
                LocalAuthConfig.load(path)


class SettingsAndPolicyTests(unittest.TestCase):
    def test_disabled_mode_is_default(self) -> None:
        settings = SecuritySettings.from_env({})
        self.assertFalse(settings.enabled)

    def test_unknown_mode_is_rejected(self) -> None:
        with self.assertRaises(SecurityConfigurationError):
            SecuritySettings.from_env({"HERMES_AUTH_MODE": "enforce"})

    def test_existing_role_policy_is_preserved(self) -> None:
        self.assertEqual(required_role("GET", "/api/tasks"), "viewer")
        self.assertEqual(required_role("POST", "/api/messages"), "operator")
        self.assertEqual(required_role("POST", "/api/outbox/retry"), "admin")
        self.assertTrue(role_allows("admin", "operator"))

    def test_csrf_and_idempotency_contract_is_preserved(self) -> None:
        self.assertTrue(valid_csrf_headers(ORIGIN, "1", ORIGIN))
        self.assertFalse(valid_csrf_headers("https://evil.example", "1", ORIGIN))
        self.assertTrue(valid_uuid("71e120d4-9f7c-43ad-a580-1d122c546e60"))
        self.assertFalse(valid_uuid("not-a-uuid"))


class SessionStoreTests(unittest.TestCase):
    def test_session_is_resolved_and_revoked_without_storing_raw_token(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "sessions.json"
            store = SessionStore(path, ttl_seconds=600)
            token, _ = store.create("owner@example.com")
            identity = store.resolve(token)
            self.assertIsInstance(identity, AuthIdentity)
            self.assertNotIn(token, path.read_text(encoding="utf-8"))
            store.revoke(token)
            self.assertIsNone(store.resolve(token))

    def test_expired_session_is_rejected(self) -> None:
        now = [100.0]
        store = SessionStore(None, ttl_seconds=10, clock=lambda: now[0])
        token, _ = store.create("owner@example.com")
        now[0] += 11
        self.assertIsNone(store.resolve(token))


class LoginRateLimiterTests(unittest.TestCase):
    def test_five_failures_block_the_next_attempt(self) -> None:
        limiter = LoginRateLimiter(period_seconds=900)
        for _ in range(5):
            self.assertIsNone(limiter.check("203.0.113.9"))
            limiter.record_failure("203.0.113.9")
        self.assertEqual(limiter.check("203.0.113.9"), 900)


class SecurityManagerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        runtime = Path(self.temporary.name)
        self.sessions = SessionStore(None, ttl_seconds=604800)
        self.manager = SecurityManager(
            local_settings(runtime),
            auth_config=local_config(),
            sessions=self.sessions,
            idempotency=IdempotencyStore(path=None),
            audit_enabled=False,
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    async def login(self, password: str = PASSWORD) -> JSONResponse:
        return await self.manager.login(
            make_request(
                "POST",
                "/api/auth/login",
                headers={"Origin": ORIGIN, "X-Hermes-CSRF": "1"},
            ),
            password,
        )

    @staticmethod
    def cookie_from(response: JSONResponse) -> str:
        header = response.headers["set-cookie"]
        return header.split(";", 1)[0]

    async def test_login_sets_secure_http_only_cookie(self) -> None:
        response = await self.login()
        cookie = response.headers["set-cookie"]
        self.assertEqual(response.status_code, 200)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("Secure", cookie)
        self.assertIn("SameSite=strict", cookie)
        self.assertTrue(cookie.startswith("__Host-hermes_office_session="))
        self.assertEqual(response.headers["cache-control"], "no-store")

    async def test_login_returns_conflict_while_auth_is_disabled(self) -> None:
        runtime = Path(self.temporary.name)
        manager = SecurityManager(
            SecuritySettings(
                mode="disabled",
                allowed_origin=ORIGIN,
                auth_config_path=runtime / "local-auth.json",
                sessions_path=runtime / "sessions.json",
                idempotency_path=runtime / "idempotency.json",
                audit_path=runtime / "audit.jsonl",
                session_ttl_seconds=604800,
            ),
            audit_enabled=False,
        )
        response = await manager.login(
            make_request("POST", "/api/auth/login"), PASSWORD
        )
        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(payload["error"], "auth_not_enabled")

    async def test_invalid_password_returns_generic_error_without_cookie(self) -> None:
        response = await self.login("wrong password")
        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 401)
        self.assertEqual(payload["error"], "invalid_credentials")
        self.assertNotIn("set-cookie", response.headers)

    async def test_login_rejects_cross_site_origin(self) -> None:
        response = await self.manager.login(
            make_request(
                "POST",
                "/api/auth/login",
                headers={"Origin": "https://evil.example", "X-Hermes-CSRF": "1"},
            ),
            PASSWORD,
        )
        self.assertEqual(response.status_code, 403)

    async def test_missing_session_never_calls_business_handler(self) -> None:
        called = 0

        async def call_next(request: Request) -> JSONResponse:
            nonlocal called
            del request
            called += 1
            return JSONResponse({"ok": True})

        response = await self.manager.handle(
            make_request("GET", "/api/tasks"), call_next
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(called, 0)

    async def test_session_endpoint_is_public_but_reports_authentication(self) -> None:
        async def call_next(request: Request) -> JSONResponse:
            return JSONResponse(self.manager.session_payload(request))

        anonymous = await self.manager.handle(
            make_request("GET", "/api/session"), call_next
        )
        self.assertFalse(json.loads(anonymous.body)["authenticated"])

        login = await self.login()
        authenticated = await self.manager.handle(
            make_request(
                "GET", "/api/session", cookie=self.cookie_from(login)
            ),
            call_next,
        )
        self.assertTrue(json.loads(authenticated.body)["authenticated"])

    async def test_authenticated_get_reaches_business_handler(self) -> None:
        login = await self.login()
        called = 0

        async def call_next(request: Request) -> JSONResponse:
            nonlocal called
            called += 1
            self.assertEqual(request.state.auth_identity.role, "admin")
            return JSONResponse({"ok": True})

        response = await self.manager.handle(
            make_request("GET", "/api/tasks", cookie=self.cookie_from(login)),
            call_next,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(called, 1)

    async def test_write_still_requires_csrf_and_idempotency(self) -> None:
        login = await self.login()
        called = 0

        async def call_next(request: Request) -> JSONResponse:
            nonlocal called
            del request
            called += 1
            return JSONResponse({"ok": True})

        response = await self.manager.handle(
            make_request(
                "POST", "/api/messages", cookie=self.cookie_from(login)
            ),
            call_next,
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(called, 0)

    async def test_authenticated_write_replays_without_second_execution(self) -> None:
        login = await self.login()
        cookie = self.cookie_from(login)
        called = 0
        headers = {
            "Origin": ORIGIN,
            "X-Hermes-CSRF": "1",
            "Idempotency-Key": "71e120d4-9f7c-43ad-a580-1d122c546e60",
        }

        async def call_next(request: Request) -> JSONResponse:
            nonlocal called
            del request
            called += 1
            return JSONResponse({"ok": True, "count": called})

        first = await self.manager.handle(
            make_request("POST", "/api/messages", headers=headers, cookie=cookie),
            call_next,
        )
        second = await self.manager.handle(
            make_request("POST", "/api/messages", headers=headers, cookie=cookie),
            call_next,
        )
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.headers["X-Idempotent-Replay"], "true")
        self.assertEqual(called, 1)

    async def test_logout_revokes_session(self) -> None:
        login = await self.login()
        cookie = self.cookie_from(login)
        request = make_request("POST", "/api/auth/logout", cookie=cookie)
        response = self.manager.logout(request)
        self.assertEqual(response.status_code, 200)
        token = cookie.split("=", 1)[1]
        self.assertIsNone(self.sessions.resolve(token))


if __name__ == "__main__":
    unittest.main()
