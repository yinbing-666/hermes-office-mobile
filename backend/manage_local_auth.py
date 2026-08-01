from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path

from local_security import LocalAuthConfig, create_password_record


RUNTIME_DIR = Path(__file__).resolve().parent / "runtime"
AUTH_CONFIG_PATH = RUNTIME_DIR / "local-auth.json"
SESSIONS_PATH = RUNTIME_DIR / "sessions.json"


def write_private_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def existing_email() -> str | None:
    if not AUTH_CONFIG_PATH.is_file():
        return None
    return LocalAuthConfig.load(AUTH_CONFIG_PATH).admin_email


def set_password(email: str | None) -> int:
    admin_email = (email or existing_email() or "").strip().lower()
    if "@" not in admin_email or len(admin_email) > 254:
        raise SystemExit("首次设置必须通过 --email 提供有效管理员邮箱")

    password = getpass.getpass("新密码（至少 12 个字符）：")
    confirmation = getpass.getpass("再次输入新密码：")
    if password != confirmation:
        raise SystemExit("两次输入的密码不一致，未修改配置")

    record = create_password_record(password)
    write_private_json(
        AUTH_CONFIG_PATH,
        {"version": 1, "admin_email": admin_email, "password": record},
    )
    write_private_json(SESSIONS_PATH, {})
    print("本地登录密码已更新，所有旧会话已撤销。")
    return 0


def show_status() -> int:
    if not AUTH_CONFIG_PATH.is_file():
        print("configured=false")
        return 0
    config = LocalAuthConfig.load(AUTH_CONFIG_PATH)
    local, _, domain = config.admin_email.partition("@")
    masked = f"{local[:3]}***@{domain}" if domain else "***"
    print("configured=true")
    print(f"admin_email={masked}")
    print(f"sessions_file={SESSIONS_PATH.is_file()}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="通过 Tailscale SSH 管理 Hermes Office 本地登录。"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    password_parser = subparsers.add_parser(
        "set-password", help="交互式设置密码并撤销全部旧会话"
    )
    password_parser.add_argument("--email", help="首次设置时的管理员邮箱")
    subparsers.add_parser("status", help="只显示脱敏配置状态")
    args = parser.parse_args()

    if args.command == "set-password":
        return set_password(args.email)
    return show_status()


if __name__ == "__main__":
    raise SystemExit(main())
