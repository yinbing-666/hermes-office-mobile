# Hermes Office Mobile

移动端 Hermes 可视化办公室，用来管理小黑、小橙、小金三个 AI 员工。

## MVP 闭环

- 办公室首页：展示 Agent 状态。
- Agent 详情：展示 profile、端口、SOUL.md / AGENT.md 状态。
- 派活入口：优先把任务发送到对应 Hermes API Server；不可用时写入 `backend/runtime/outbox.jsonl` 兜底。
- 进化档案：展示最近 Skills 和 profile 人格文件更新时间。
- 任务动态：展示 Cron 和 gateway 活动。

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
curl -sS -X POST http://127.0.0.1:8787/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"default","message":"测试任务"}'
```

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
