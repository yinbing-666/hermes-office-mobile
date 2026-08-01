# Hermes Office Mobile Backend

Hermes Office Mobile 的 FastAPI BFF，监听 `127.0.0.1:8787`，由用户级 `hermes-office-mobile-bff.service` 守护。它既有只读聚合接口，也有消息投递、outbox 补投、工作流持久化、专家管线和 Kanban 解阻塞等有副作用接口，因此不能描述为“纯只读服务”。

## 数据与凭证边界

- 只读数据包括 Hermes profile 状态、Gateway 活动、Cron、Skills、档案、Kanban 与选题临时文件。
- BFF 会读写项目内 `backend/runtime/` 的 outbox、sent 和工作流文件；具体接口见 [`../docs/api.md`](../docs/api.md)。
- 为调用本机 Hermes API Server，BFF 会读取各 profile 配置中的 API Server key，并仅用于本机 Bearer 鉴权。
- key 不得出现在 HTTP 响应、outbox、sent、日志、截图或文档中；排障只记录“存在／缺失”和脱敏错误。
- BFF 不应修改 Hermes core、profile 配置、`.env` 或密钥。

## 公网边界

生产站点通过 `https://office.icewill.tech/api/*` 暴露 BFF。`local_security.py` 已实现单管理员本地密码登录、服务端会话、严格 Origin、CSRF 头、幂等、按身份限流和脱敏审计；默认 `HERMES_AUTH_MODE=disabled`。

当前尚未交互设置管理员密码、配置 `HERMES_AUTH_MODE=local` 或重启生产服务，因此线上仍不能视为已启用鉴权。`Access-Control-Allow-Origin` 只控制浏览器跨域行为，不是身份认证。

在本地登录完成生产验收前，默认验收只执行 GET 请求。任何业务 POST 验证都可能发送消息、重试历史队列或改变工作流／看板状态，必须先得到主人针对该次操作的确认。登录和退出只用于认证验收，不代表业务写操作授权。完整设计见 [`../docs/specs/2026-08-01-local-auth-security-design.md`](../docs/specs/2026-08-01-local-auth-security-design.md)。

## Install

```bash
cd /home/agentuser/projects/hermes-office-mobile/backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## 本地运行

```bash
cd /home/agentuser/projects/hermes-office-mobile/backend
.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8787
```

生产服务继续绑定 `127.0.0.1`，由 Nginx 反向代理；不要为临时调试改成 `0.0.0.0`。

本地认证的生产 systemd drop-in 模板位于 `systemd/hermes-office-mobile-bff.service.d/auth.conf`。模板不包含密码或其他凭证；启用时复制到用户级 systemd 目录，执行 `daemon-reload` 后重启服务。真实密码仅保存在权限为 `0600` 的 `runtime/local-auth.json`，不得写入 unit 或仓库。

## 不发布验证

```bash
cd /home/agentuser/projects/hermes-office-mobile/backend
.venv/bin/python -m py_compile main.py local_security.py manage_local_auth.py test_local_security.py
.venv/bin/python -m unittest -v test_access_security.py test_local_security.py
```

运行中的生产服务尚未重启时，可继续只读调用现有 GET；启用 `local` 后，除 `GET /api/session` 和 `POST /api/auth/login` 外的 API 都需要有效会话。Tailscale SSH 仅用于运行交互式密码重置、查看脱敏状态和恢复服务，不提供 HTTP 绕过。

Interactive OpenAPI documentation is available at `http://127.0.0.1:8787/docs` while the server is running.

完整架构、API 副作用、生产操作和验收要求分别见：

- [`../docs/architecture.md`](../docs/architecture.md)
- [`../docs/api.md`](../docs/api.md)
- [`../docs/operations.md`](../docs/operations.md)
- [`../docs/acceptance.md`](../docs/acceptance.md)
- [`../docs/specs/2026-08-01-local-auth-security-design.md`](../docs/specs/2026-08-01-local-auth-security-design.md)
- [`../docs/specs/2026-08-01-access-security-design.md`](../docs/specs/2026-08-01-access-security-design.md)（已停止）
