# Hermes Office Mobile

移动端 Hermes 可视化办公室，用来管理三个 AI 员工。前端采用 Marvis Office 风格的轻量办公空间隐喻：白色与浅米灰底、统一线性 SVG 图标、员工工位卡和克制的信息层级。

## MVP 闭环

- 办公室首页：展示在线、离线、待补投概览，以及带 Dragon Image2 头像和职责信息的员工工位卡。
- Agent 详情：展示 profile、端口、SOUL.md / AGENT.md 状态。
- 派活入口：优先把任务发送到对应 Hermes API Server；不可用时写入 `backend/runtime/outbox.jsonl` 兜底。
- 进化档案：以成长概览、能力矩阵、最近进化时间线和员工档案卡展示 `evolution.skills` / `evolution.profiles` 的真实记录；缺失项明确显示暂无或待记录。
- 任务动态：采用移动任务清单布局，展示进行中、已完成、待补投统计，保留兜底队列逐条重试，并将 Cron 转为任务卡片、Gateway 活动弱化为可折叠最近事件。
- 移动导航：保留办公室、员工、进化、任务四个 Tab，使用统一线性图标和浅蓝选中态。

## 启动

后端：

```bash
cd /home/agentuser/projects/hermes-office-mobile/backend
.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8787
```

前端：

```bash
cd /home/agentuser/projects/hermes-office-mobile/frontend
npm run dev -- --host 127.0.0.1 --port 5173
```

浏览器访问：

```text
http://127.0.0.1:5173/
```

## 验证

```bash
cd /home/agentuser/projects/hermes-office-mobile
backend/.venv/bin/python -m py_compile backend/main.py
cd frontend && npm run build
```

API 烟测：

```bash
curl -sS http://127.0.0.1:8787/api/health
curl -sS http://127.0.0.1:8787/api/agents
curl -sS http://127.0.0.1:8787/api/outbox
curl -sS -X POST http://127.0.0.1:8787/api/outbox/retry \
  -H 'Content-Type: application/json' \
  -d '{"limit":1}'
curl -sS -X POST http://127.0.0.1:8787/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"default","message":"测试任务"}'
```

| Endpoint | 用途 |
|---|---|
| `POST /api/messages` | 发送任务，优先 API Server，失败写入 outbox |
| `GET /api/outbox` | 查看兜底队列最近 50 条 |
| `POST /api/outbox/retry` | 小步重试 outbox，默认/建议一次 1 条，避免手机端长时间等待 |

`POST /api/messages` 会按 profile 路由到本机 Hermes API Server：

| profile | 端口 | config |
|---|---:|---|
| `default` | 8642 | `/home/agentuser/.hermes/config.yaml` |
| `media-ops` | 8650 | `/home/agentuser/.hermes/profiles/media-ops/config.yaml` |
| `investor` | 8660 | `/home/agentuser/.hermes/profiles/investor/config.yaml` |

后端只读取对应 config 的 `platforms.api_server.extra.key` 用作本机 Bearer 鉴权，不在响应、outbox 或日志中返回该 key。端口离线、key 不可用或请求失败时，接口仍返回成功入队状态，并记录不含敏感信息的 `fallback_reason`。

## 当前边界

- Hermes API Server 为首选发送通道，项目内 outbox 只作为失败兜底。
- 不修改 Hermes core、gateway、config.yaml、.env 或密钥。
- 不公网暴露，默认本机访问。
