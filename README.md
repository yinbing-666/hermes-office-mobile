# Hermes Office Mobile

Hermes Office Mobile 是面向手机的 Hermes 多智能体办公室。前端以 React PWA 展示员工、任务、选题、空间和工作流；FastAPI BFF 聚合本机 Hermes 数据，并承接消息投递、兜底队列和部分看板／工作流操作。

生产站点公开运行于 `https://office.icewill.tech`。本地密码登录、服务端会话、角色授权、CSRF、幂等和应用级限流代码已经实现并通过测试，但尚未设置真实密码、启用运行模式或重启服务，当前公网仍按“未启用鉴权”处理。CORS 不能视为安全边界，任何有副作用的接口验证都必须先得到主人确认。

## 当前能力

- 展示小黑、小橙、小金的状态、任务、进化档案和真实活动摘要。
- 聚合 Cron、Gateway、Kanban、sent 与 outbox，区分已送达、待补投、阻塞、失败和暂停。
- 将消息优先投递到本机 Hermes API Server，失败时写入项目 outbox。
- 提供空间、专家团、选题和工作流页面；专家团只展示真实投递／回执，工作流执行当前明确为模拟模式。
- PWA 支持移动端安装和离线 app shell；API 始终以网络真实结果为准。

本项目不修改 Hermes core、profile 配置、`.env`、密钥或 Gateway。没有真实计量或执行证据时，界面必须显示待接入、未确认或模拟状态，不能生成看似真实的结果。

## 目录

```text
backend/                 FastAPI BFF 与项目运行时数据
frontend/                React + TypeScript + 原生 CSS PWA
docs/architecture.md     架构、数据流和信任边界
docs/api.md              API 分类与副作用
docs/operations.md       生产构建、检查、回滚和 outbox 恢复
docs/acceptance.md       移动端与服务验收用例
docs/specs/              跨模块设计与分阶段上线门禁
ROADMAP.md               当前进度、已知问题、下一步和判断库
```

## 开发启动

后端：

```bash
cd /home/agentuser/projects/hermes-office-mobile/backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8787
```

前端：

```bash
cd /home/agentuser/projects/hermes-office-mobile/frontend
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

生产 BFF 由用户级 `hermes-office-mobile-bff.service` 守护，不要用开发命令替换该服务。真实线上链路、构建和回滚见 [`docs/operations.md`](docs/operations.md)。

## 默认验证

不发布的代码检查：

```bash
cd /home/agentuser/projects/hermes-office-mobile
backend/.venv/bin/python -m py_compile backend/main.py backend/local_security.py backend/manage_local_auth.py
cd backend && .venv/bin/python -m unittest -v test_access_security.py test_local_security.py
cd ../frontend && npx tsc --noEmit
```

服务器 `frontend/dist` 是 Nginx 线上目录，`make gate` 包含生产构建，只能在取得公开发布确认后执行。

只读 API 烟测：

```bash
curl -sS http://127.0.0.1:8787/api/health
curl -sS http://127.0.0.1:8787/api/agents
curl -sS http://127.0.0.1:8787/api/tasks
curl -sS http://127.0.0.1:8787/api/outbox
curl -sS https://office.icewill.tech/api/health
```

默认烟测禁止调用 POST。`POST /api/messages`、outbox 补投、Kanban、工作流和专家管线均可能产生真实副作用，详见 [`docs/api.md`](docs/api.md) 与 [`docs/acceptance.md`](docs/acceptance.md)。

## 生产事实

```text
Cloudflare Tunnel
  → Nginx
    → frontend/dist
    → /api/* → 127.0.0.1:8787
      → hermes-office-mobile-bff.service
```

- BFF 只监听回环地址，由 Nginx 同源转发 `/api/*`。
- BFF 会读取本机 Hermes API Server key，仅用于本机 Bearer 鉴权，绝不返回或记录凭证值。
- 自动补投默认关闭；超过 48 小时的旧消息默认跳过，`allow_stale=true` 只能在确认历史内容和风险后使用。
- 当前最高优先级是按门禁顺序分别确认：以禁用模式重启 BFF、发布登录前端、交互设置密码、启用本地认证并再次重启。Tailscale SSH 是忘记密码或会话异常时的恢复通道，不是网页免登录通道。安全源代码存在不等于线上已经生效。

## 文档入口

- [架构与数据流](docs/architecture.md)
- [API 与副作用](docs/api.md)
- [生产运维](docs/operations.md)
- [验收清单](docs/acceptance.md)
- [本地登录安全设计](docs/specs/2026-08-01-local-auth-security-design.md)
- [已停止的 Access 设计](docs/specs/2026-08-01-access-security-design.md)
- [后端边界](backend/README.md)
- [项目进度](ROADMAP.md)
